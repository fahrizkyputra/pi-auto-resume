/**
 * `jcode-auto-resume <install|uninstall|status|on|off|language en|id|run|log>`
 *
 * install: copies are already in ~/.jcode/plugins/pi-auto-resume (bin/jcode.mjs);
 * this writes the launchd agent that keeps the daemon running, and the command.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, writeConfig } from "../src/config.ts";
import { formatClockWithDay, formatCountdown, parseLanguage } from "../src/messages.ts";
import { installShim, removeShim, shimCommand } from "./kit.ts";
import { configPath, stateDir, statusPath } from "./daemon.ts";

export const PACKAGE = "pi-auto-resume";
export const SHIM = "jcode-auto-resume";
export const LABEL = "com.fahrizkyputra.jcode-auto-resume";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);

export const plistPath = (): string => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const logPath = (): string => join(stateDir(), "daemon.log");

function launchdEnabled(): boolean {
	return process.platform === "darwin" && process.env.JCODE_AUTO_RESUME_NO_LAUNCHD !== "1";
}

/** The jcode CLI on PATH (the bridge comes from it). */
export function findJcode(): string | undefined {
	const fromEnv = process.env.JCODE_BIN?.trim();
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	for (const dir of [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin")]) {
		const candidate = join(dir, "jcode");
		if (dir && existsSync(candidate)) return candidate;
	}
	return undefined;
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plistText(input: { node: string; daemon: string; jcode: string; log: string; env: Record<string, string> }): string {
	const env = Object.entries(input.env)
		.map(([key, value]) => `\t\t<key>${xml(key)}</key>\n\t\t<string>${xml(value)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(input.node)}</string>
		<string>--no-warnings</string>
		<string>${xml(input.daemon)}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>JCODE_BIN</key>
		<string>${xml(input.jcode)}</string>
${env}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${xml(input.log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(input.log)}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]): { status: number | null; stderr: string } {
	const result = spawnSync("launchctl", args, { encoding: "utf8" });
	return { status: result.status, stderr: (result.stderr ?? "").trim() };
}

function loaded(): boolean {
	return launchctl(["print", `${domain()}/${LABEL}`]).status === 0;
}

function sleepMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `bootout` returns before the job is gone; a `bootstrap` right after it fails. Wait it out. */
function unload(): void {
	if (!loaded()) return;
	launchctl(["bootout", `${domain()}/${LABEL}`]);
	for (let i = 0; i < 50 && loaded(); i++) sleepMs(200);
}

function load(): void {
	unload();
	let last = launchctl(["bootstrap", domain(), plistPath()]);
	for (let i = 0; i < 5 && last.status !== 0; i++) {
		sleepMs(1000);
		last = launchctl(["bootstrap", domain(), plistPath()]);
	}
	if (last.status !== 0 && !loaded()) throw new Error(`launchctl bootstrap failed (${last.status}): ${last.stderr}`);
}

function domain(): string {
	return `gui/${process.getuid?.() ?? 501}`;
}

function install(): string[] {
	const jcode = findJcode();
	if (!jcode) throw new Error("jcode not found on PATH (or set JCODE_BIN)");
	mkdirSync(stateDir(), { recursive: true });
	if (existsSync(logPath()) && statSync(logPath()).size > 5 * 1024 * 1024) rmSync(logPath());
	const shim = installShim(SHIM, join(here, "cli.ts"));
	const env: Record<string, string> = { HOME: homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin" };
	if (process.env.JCODE_HOME) env.JCODE_HOME = process.env.JCODE_HOME;
	const plist = plistText({ node: process.execPath, daemon: join(here, "daemon.ts"), jcode, log: logPath(), env });
	mkdirSync(dirname(plistPath()), { recursive: true });
	writeFileSync(plistPath(), plist);
	if (launchdEnabled()) load();
	return [
		`${PACKAGE} installed for jcode`,
		`- daemon: launchd agent ${LABEL} (starts at login, restarts if it stops)`,
		`- watches every jcode session open in a terminal; after jcode's own retries give up on a rate limit, waits for the reset and sends the continuation`,
		`- settings: ${configPath()} (same keys as the Pi package)`,
		`- log: ${logPath()}`,
		`- command: ${shim} status | on | off | language en|id | log | uninstall`,
	];
}

function uninstall(): string[] {
	if (launchdEnabled()) unload();
	rmSync(plistPath(), { force: true });
	removeShim(SHIM);
	rmSync(stateDir(), { recursive: true, force: true });
	rmSync(pluginRoot, { recursive: true, force: true });
	return [`${PACKAGE} removed from jcode (launchd agent, command, state). ${configPath()} is kept.`];
}

function daemonRunning(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function status(): string[] {
	const config = readConfig(configPath());
	const lines = [PACKAGE, `enabled: ${config.enabled}`, `language: ${config.language}`];
	if (existsSync(statusPath())) {
		const state = JSON.parse(readFileSync(statusPath(), "utf8")) as { pid?: number; sessions?: { session_id: string; title: string; resume_at: number | null }[] };
		lines.push(`daemon: ${daemonRunning(state.pid) ? `running (pid ${state.pid})` : `not running${launchdEnabled() && loaded() ? " (launchd agent loaded; starting or failing, see the log)" : ""}`}`);
		const now = Date.now();
		for (const session of state.sessions ?? []) {
			const wait = session.resume_at ? `resuming ${formatClockWithDay(session.resume_at, now)} (in ${formatCountdown(session.resume_at - now)})` : "watching";
			lines.push(`- ${session.title.slice(0, 50)} [${session.session_id}]: ${wait}`);
		}
		if ((state.sessions ?? []).length === 0) lines.push("- no jcode session open in a terminal");
	} else {
		const agent = !existsSync(plistPath()) ? "not installed" : launchdEnabled() && !loaded() ? "launchd agent NOT loaded; run install again" : "launchd agent loaded; starting or failing, see the log";
		lines.push(`daemon: not running (${agent})`);
	}
	lines.push(`log: ${logPath()}`, `command: ${shimCommand(SHIM)}`);
	return lines;
}

export async function run(args: readonly string[]): Promise<{ code: number; lines: string[] }> {
	const command = (args[0] ?? "status").toLowerCase();
	switch (command) {
		case "install":
			return { code: 0, lines: install() };
		case "uninstall":
			return { code: 0, lines: uninstall() };
		case "status":
			return { code: 0, lines: status() };
		case "on":
		case "off": {
			const config = readConfig(configPath());
			config.enabled = command === "on";
			writeConfig(config, configPath());
			return { code: 0, lines: [`${PACKAGE}: ${command} (applies within seconds)`] };
		}
		case "language": {
			const language = parseLanguage(args[1]);
			if (!language) return { code: 2, lines: ["usage: language en|id"] };
			const config = readConfig(configPath());
			config.language = language;
			writeConfig(config, configPath());
			return { code: 0, lines: [`${PACKAGE}: language ${language}`] };
		}
		case "log": {
			if (!existsSync(logPath())) return { code: 0, lines: ["(no log yet)"] };
			return { code: 0, lines: readFileSync(logPath(), "utf8").trimEnd().split("\n").slice(-40) };
		}
		case "run": {
			execFileSync(process.execPath, ["--no-warnings", join(here, "daemon.ts")], { stdio: "inherit", env: { ...process.env, JCODE_BIN: findJcode() ?? "jcode" } });
			return { code: 0, lines: [] };
		}
		default:
			return { code: 2, lines: [`unknown command "${command}". Use install, uninstall, status, on, off, language en|id, log, run.`] };
	}
}

if (import.meta.main) {
	try {
		const { code, lines } = await run(process.argv.slice(2));
		if (lines.length > 0) (code === 0 ? console.log : console.error)(lines.join("\n"));
		process.exitCode = code;
	} catch (error) {
		console.error(`${PACKAGE}: ${(error as Error).message}`);
		process.exitCode = 1;
	}
}
