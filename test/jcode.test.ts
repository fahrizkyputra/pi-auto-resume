import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, type AutoResumeConfig } from "../src/config.ts";
import { ApiClient, type Transport } from "../jcode/api.ts";
import { plistText } from "../jcode/cli.ts";
import { SessionWatcher } from "../jcode/watcher.ts";

const ROOT = resolve(import.meta.dirname, "..");
process.env.JCODE_HOME = realpathSync(mkdtempSync(join(tmpdir(), "auto-resume-jcode-default-")));

// ---------------------------------------------------------------- watcher (fake clock)

function harness(config: Partial<AutoResumeConfig> = {}) {
	let now = Date.parse("2026-10-28T00:00:00+07:00");
	const timers: { at: number; fire: () => void; cancelled: boolean }[] = [];
	const sent: string[] = [];
	const notices: string[] = [];
	const watcher = new SessionWatcher({
		sessionId: "s1",
		config: () => ({ ...DEFAULT_CONFIG, slackMs: 0, ...config }),
		now: () => now,
		setTimer: (delayMs, fire) => {
			const timer = { at: now + delayMs, fire, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		send: (text) => sent.push(text),
		notify: (message) => notices.push(message),
	});
	const advance = (ms: number) => {
		now += ms;
		for (const timer of timers) {
			if (!timer.cancelled && timer.at <= now) {
				timer.cancelled = true;
				timer.fire();
			}
		}
	};
	const turn = (stop?: { message: string; reason?: string }) => {
		watcher.handle({ ev: "connection_phase", session_id: "s1", phase: "sending request" });
		if (stop) watcher.handle({ ev: "turn_stopped", session_id: "s1", reason: stop.reason ?? "failure", message: stop.message });
		watcher.handle({ ev: "turn_done", session_id: "s1" });
	};
	return { watcher, sent, notices, advance, turn, now: () => now };
}

const WINDOW =
	'OpenAI-compatible chat request failed\n  status: 429 Too Many Requests\n  response: {"error":{"message":"[claude/x] [429]: {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"rate_limit_error\\",\\"message\\":\\"Usage limit reached for 5 hour. Your limit will reset at 2026-10-28 03:11:22\\"}} (reset after 2s)"}}';

test("a plan-window stop waits for the real end of the window, not the gateway's 2 s, then sends one marked continuation", () => {
	const { watcher, sent, advance, turn, now } = harness();
	turn({ message: WINDOW });
	const fireAt = watcher.pendingFireAt();
	assert.ok(fireAt !== undefined);
	// 03:11:22 Beijing = 02:11:23 WIB (end of that second): just over 2 hours after 00:00 WIB.
	assert.equal(fireAt - now(), (2 * 3600 + 11 * 60 + 23) * 1000);
	advance(60_000);
	assert.equal(sent.length, 0, "not after the gateway's 2 s pause");
	advance(fireAt - now());
	assert.equal(sent.length, 1);
	assert.match(sent[0] ?? "", /^⚙ auto-resume/);
});

test("a new turn while waiting (the TUI's own retry, or the user typing) drops the wait; that turn decides again", () => {
	const { watcher, sent, advance, turn } = harness();
	turn({ message: WINDOW });
	assert.ok(watcher.pendingFireAt() !== undefined);
	turn({ message: WINDOW }); // TUI retry hits the limit again: rescheduled
	assert.ok(watcher.pendingFireAt() !== undefined);
	turn(); // the user typed and it went through
	assert.equal(watcher.pendingFireAt(), undefined);
	advance(10 * 3600_000);
	assert.equal(sent.length, 0);
});

test("our own continuation's turn does not cancel anything, and the same error right after it stops the loop", () => {
	const { watcher, sent, notices, advance, turn } = harness();
	turn({ message: "rate limit exceeded (reset after 8s)" });
	advance(9000);
	assert.equal(sent.length, 1);
	turn({ message: "rate limit exceeded (reset after 8s)" });
	assert.equal(watcher.pendingFireAt(), undefined, "same error after our resume: report, no new wait");
	assert.ok(notices.some((n) => /same error/.test(n)));
});

test("an interrupt cancels silently; quota and non-limit errors never schedule", () => {
	const a = harness();
	a.turn({ message: "rate limit exceeded (reset after 30s)" });
	a.watcher.handle({ ev: "connection_phase", session_id: "s1" });
	a.watcher.handle({ ev: "turn_stopped", session_id: "s1", reason: "interrupted", message: "x" });
	assert.equal(a.watcher.pendingFireAt(), undefined);

	const b = harness();
	b.turn({ message: "Insufficient Balance" });
	b.turn({ message: "TypeError: x is undefined" });
	assert.equal(b.watcher.pendingFireAt(), undefined);
	b.advance(3600_000);
	assert.equal(b.sent.length, 0);
});

test("events of another session are ignored; disabled config never schedules", () => {
	const a = harness();
	a.watcher.handle({ ev: "turn_stopped", session_id: "other", reason: "failure", message: "rate limit (reset after 5s)" });
	assert.equal(a.watcher.pendingFireAt(), undefined);
	const b = harness({ enabled: false });
	b.turn({ message: WINDOW });
	assert.equal(b.watcher.pendingFireAt(), undefined);
});

// ---------------------------------------------------------------- API client framing

function fakeTransport() {
	const written: Record<string, unknown>[] = [];
	let onData: (chunk: string) => void = () => {};
	let onClose: () => void = () => {};
	const transport: Transport = {
		write: (line) => written.push(JSON.parse(line) as Record<string, unknown>),
		onData: (listener) => {
			onData = listener;
		},
		onClose: (listener) => {
			onClose = listener;
		},
		close: () => onClose(),
	};
	return { transport, written, push: (text: string) => onData(text), close: () => onClose() };
}

test("api client: replies match by id across split chunks; events go to listeners; close rejects waiters", async () => {
	const fake = fakeTransport();
	const client = new ApiClient(fake.transport, 1000);
	const events: string[] = [];
	client.onEvent((frame) => events.push(String(frame.ev)));
	const listing = client.listSessions(5);
	assert.deepEqual(fake.written[0], { v: 1, id: 1, req: "list_sessions", limit: 5 });
	fake.push('{"v":1,"ev":"turn_done","session_id":"s"}\n{"v":1,"reply_to":1,"ev":"sess');
	fake.push('ions","sessions":[{"session_id":"a","status":"idle","user_connected":true}]}\n');
	assert.deepEqual(await listing, [{ session_id: "a", status: "idle", user_connected: true }]);
	assert.deepEqual(events, ["turn_done"]);

	client.sendMessage("a", "go");
	assert.deepEqual(fake.written[1], { v: 1, id: 2, req: "send_message", session_id: "a", content: "go", images: [] });

	const attach = client.attachSession("a");
	fake.push('{"v":1,"reply_to":3,"ev":"error","code":"unknown_session","message":"gone"}\n');
	await assert.rejects(attach, /unknown_session: gone/);

	const pending = client.listSessions();
	fake.close();
	await assert.rejects(pending, /closed/);
});

// ---------------------------------------------------------------- installer

test("launchd plist escapes paths and keeps the daemon alive", () => {
	const plist = plistText({ node: "/n/node", daemon: "/a & b/daemon.ts", jcode: "/j/jcode", log: "/l/daemon.log", env: { HOME: "/h", PATH: "/x:/y" } });
	assert.match(plist, /<string>\/a &amp; b\/daemon.ts<\/string>/);
	assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
	assert.match(plist, /<key>JCODE_BIN<\/key>\s*<string>\/j\/jcode<\/string>/);
});

test("install writes the agent, the command, and settings; on/off/language edit the settings; uninstall removes everything", () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "auto-resume-jcode-")));
	const jcodeHome = join(home, ".jcode");
	const bin = join(home, ".local", "bin");
	mkdirSync(bin, { recursive: true });
	mkdirSync(jcodeHome, { recursive: true });
	const env = { ...process.env, HOME: home, JCODE_HOME: jcodeHome, JCODE_AUTO_RESUME_NO_LAUNCHD: "1", JCODE_BIN: "/bin/echo", PATH: `${bin}:${process.env.PATH}` };
	const run = (file: string, args: string[]) => spawnSync(file, args, { env, encoding: "utf8" });

	const installed = run(process.execPath, [join(ROOT, "bin", "jcode.mjs"), "jcode", "install"]);
	assert.equal(installed.status, 0, installed.stderr);
	const plist = readFileSync(join(home, "Library", "LaunchAgents", "com.fahrizkyputra.jcode-auto-resume.plist"), "utf8");
	assert.ok(plist.includes(join(jcodeHome, "plugins", "pi-auto-resume", "jcode", "daemon.ts")));
	assert.ok(plist.includes(`<string>${jcodeHome}</string>`), "JCODE_HOME passed to the daemon");

	const cli = join(bin, "jcode-auto-resume");
	assert.equal(run(cli, ["off"]).status, 0);
	assert.equal(run(cli, ["language", "id"]).status, 0);
	const settings = JSON.parse(readFileSync(join(jcodeHome, "pi-auto-resume.json"), "utf8"));
	assert.equal(settings.enabled, false);
	assert.equal(settings.language, "id");
	assert.match(run(cli, ["status"]).stdout, /enabled: false[\s\S]*daemon: not running/);
	assert.equal(run(cli, ["language", "fr"]).status, 2);

	assert.equal(run(cli, ["uninstall"]).status, 0);
	assert.ok(!existsSync(join(home, "Library", "LaunchAgents", "com.fahrizkyputra.jcode-auto-resume.plist")));
	assert.ok(!existsSync(cli));
	assert.ok(!existsSync(join(jcodeHome, "plugins", "pi-auto-resume")));
	assert.ok(existsSync(join(jcodeHome, "pi-auto-resume.json")), "settings are kept");
});
