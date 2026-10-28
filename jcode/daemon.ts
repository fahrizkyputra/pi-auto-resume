/**
 * jcode-auto-resume daemon (run by launchd, or `jcode-auto-resume run`).
 *
 * - Starts its own `jcode api-bridge` on a private socket and restarts it if it dies.
 * - Every few seconds lists sessions and watches each one a terminal client has
 *   open (`user_connected`), one harness-API connection per session (the bridge
 *   attaches one session per connection).
 * - Each watched session gets a SessionWatcher: the Pi package's own decision
 *   logic, reset-hint parser, and wall-clock timer.
 * - Notices go to macOS notifications and the log; `status.json` shows what waits.
 */

import { spawn, type ChildProcess, execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig, type AutoResumeConfig } from "../src/config.ts";
import { wallClockTimer } from "../src/wall-clock.ts";
import { ApiClient, type SessionInfo } from "./api.ts";
import { jcodeHome } from "./kit.ts";
import { SessionWatcher } from "./watcher.ts";

export const stateDir = (): string => join(jcodeHome(), "pi-auto-resume");
export const configPath = (): string => join(jcodeHome(), "pi-auto-resume.json");
export const statusPath = (): string => join(stateDir(), "status.json");
export const socketPath = (): string => join(stateDir(), "api.sock");

const DISCOVERY_MS = Number(process.env.JCODE_AUTO_RESUME_DISCOVERY_MS ?? 5000);
const CLIENT_NAME = "jcode-auto-resume";

function log(message: string): void {
	console.log(`${new Date().toISOString()} ${message}`);
}

let lastNotice = { text: "", at: 0 };
function notify(title: string, message: string): void {
	// The TUI's own short retries end the same way several times in a row; say it once.
	const now = Date.now();
	const key = `${title}|${message.replace(/\([^)]*\)/g, "")}`;
	if (key === lastNotice.text && now - lastNotice.at < 120_000) return;
	lastNotice = { text: key, at: now };
	log(`notice: ${title}: ${message}`);
	if (process.platform !== "darwin" || process.env.JCODE_AUTO_RESUME_NO_NOTIFY === "1") return;
	const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
	execFile("osascript", ["-e", script], () => {});
}

interface Watched {
	client: ApiClient;
	watcher: SessionWatcher;
	title: string;
}

export class Daemon {
	private bridge: ChildProcess | undefined;
	private control: ApiClient | undefined;
	private watched = new Map<string, Watched>();
	private config: AutoResumeConfig = readConfig(configPath());
	private stopped = false;
	private discovering = false;

	private readonly jcodeBin: string;
	private readonly explicitSessions: readonly string[];

	constructor(jcodeBin: string, explicitSessions: readonly string[] = []) {
		this.jcodeBin = jcodeBin;
		this.explicitSessions = explicitSessions;
	}

	async start(): Promise<void> {
		mkdirSync(stateDir(), { recursive: true });
		log(`starting (jcode ${this.jcodeBin}, socket ${socketPath()})`);
		this.startBridge();
		const tick = async () => {
			if (this.stopped) return;
			try {
				await this.discover();
			} catch (error) {
				log(`discovery failed: ${(error as Error).message}`);
				this.control?.close();
				this.control = undefined;
			}
			setTimeout(tick, DISCOVERY_MS).unref?.();
		};
		await tick();
		// Keep the process alive; the timers above are unref'd.
		setInterval(() => {}, 1 << 30);
	}

	stop(): void {
		this.stopped = true;
		for (const [, entry] of this.watched) {
			entry.watcher.close();
			entry.client.close();
		}
		this.watched.clear();
		this.control?.close();
		this.bridge?.kill();
		rmSync(statusPath(), { force: true });
	}

	private startBridge(): void {
		rmSync(socketPath(), { force: true });
		const child = spawn(this.jcodeBin, ["--no-update", "api-bridge", "--api-socket", socketPath()], {
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, JCODE_API_SOCKET: socketPath() },
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text && !text.includes("list_sessions")) log(`bridge: ${text.slice(0, 300)}`);
		});
		child.once("exit", (code, signal) => {
			if (this.stopped) return;
			log(`bridge exited (${code ?? signal}); restarting in 5s`);
			this.control?.close();
			this.control = undefined;
			for (const [id, entry] of this.watched) this.unwatch(id, entry);
			setTimeout(() => this.startBridge(), 5000).unref?.();
		});
		this.bridge = child;
	}

	private async connect(): Promise<ApiClient> {
		for (let i = 0; i < 40; i++) {
			if (existsSync(socketPath())) {
				try {
					return await ApiClient.connect(socketPath(), CLIENT_NAME);
				} catch {
					// not listening yet
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error(`no bridge on ${socketPath()}`);
	}

	private async discover(): Promise<void> {
		if (this.discovering) return;
		this.discovering = true;
		try {
			this.config = readConfig(configPath());
			if (!this.control || this.control.closed) this.control = await this.connect();
			const sessions = await this.control.listSessions(100);
			const wanted = new Map<string, SessionInfo>();
			for (const session of sessions) {
				if (this.explicitSessions.length > 0 ? this.explicitSessions.includes(session.session_id) : session.user_connected === true) {
					wanted.set(session.session_id, session);
				}
			}
			// Sessions named explicitly are watched even before they show up in the listing.
			for (const id of this.explicitSessions) if (!wanted.has(id)) wanted.set(id, { session_id: id });
			if (!this.config.enabled) wanted.clear();
			for (const [id, session] of wanted) {
				if (!this.watched.has(id)) await this.watch(id, session.title ?? id);
			}
			for (const [id, entry] of this.watched) {
				// Keep watching while a resume waits, even if the terminal closed meanwhile.
				if (!wanted.has(id) && (entry.watcher.pendingFireAt() === undefined || !this.config.enabled)) this.unwatch(id, entry);
			}
			this.writeStatus();
		} finally {
			this.discovering = false;
		}
	}

	private async watch(sessionId: string, title: string): Promise<void> {
		const client = await this.connect();
		const watcher = new SessionWatcher({
			sessionId,
			config: () => this.config,
			now: () => Date.now(),
			setTimer: (delayMs, fire) => wallClockTimer(delayMs, fire),
			send: (text) => {
				log(`${sessionId}: sending continuation`);
				client.sendMessage(sessionId, text);
			},
			notify: (message) => notify(`jcode · ${title.slice(0, 60)}`, message),
			onChange: () => this.writeStatus(),
		});
		const broken = process.env.JCODE_AUTO_RESUME_BROKEN === "1"; // e2e: proves the harness bites
		client.onEvent((frame) => {
			if (broken && frame.ev === "turn_stopped") return;
			if (frame.ev === "turn_stopped") log(`${sessionId}: turn_stopped ${String(frame.reason)}: ${String(frame.message).replace(/\s+/g, " ").slice(0, 300)}`);
			watcher.handle(frame);
		});
		client.onClose(() => {
			const entry = this.watched.get(sessionId);
			if (entry?.client === client) this.unwatch(sessionId, entry);
		});
		await client.attachSession(sessionId);
		this.watched.set(sessionId, { client, watcher, title });
		log(`${sessionId}: watching (${title})`);
	}

	private unwatch(sessionId: string, entry: Watched): void {
		this.watched.delete(sessionId);
		entry.watcher.close();
		entry.client.close();
		log(`${sessionId}: stopped watching`);
		this.writeStatus();
	}

	private writeStatus(): void {
		const sessions = [...this.watched].map(([id, entry]) => ({
			session_id: id,
			title: entry.title,
			resume_at: entry.watcher.pendingFireAt() ?? null,
			resumes_sent: entry.watcher.controller.resumesSent(),
		}));
		const tmp = `${statusPath()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, updated_at: Date.now(), enabled: this.config.enabled, sessions }, null, 2)}\n`);
		renameSync(tmp, statusPath());
	}
}

if (import.meta.main) {
	const bin = process.env.JCODE_BIN || "jcode";
	const explicit = (process.env.JCODE_AUTO_RESUME_SESSIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	const daemon = new Daemon(bin, explicit);
	const shutdown = () => {
		daemon.stop();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	daemon.start().catch((error) => {
		log(`fatal: ${(error as Error).message}`);
		process.exit(1);
	});
}
