#!/usr/bin/env node
/**
 * End-to-end against a real jcode, no API key and no real account:
 *
 * - a private jcode home whose only provider is a fake OpenAI-compatible gateway;
 * - the gateway answers 429 with a 9router-style plan-window message, whose
 *   "reset at" is a few seconds away while its "(reset after 1s)" says retry now;
 * - jcode retries on its own and then stops the turn (turn_stopped);
 * - the real daemon (jcode/daemon.ts) watches that session, waits for the window
 *   end, and sends the marked continuation; the gateway, now open, answers it.
 *
 * Asserts on the world: the gateway received the continuation only after the
 * window end, the session history holds the marker and the reply, and the daemon
 * sent exactly one continuation.
 *
 * Usage: node scripts/e2e-jcode.mjs          (requires `jcode` on PATH)
 *        node scripts/e2e-jcode.mjs --broken (daemon ignores turn_stopped: must FAIL)
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const broken = process.argv.includes("--broken");
const WINDOW_SECONDS = Number(process.env.WINDOW_SECONDS ?? 120);
const TIMEOUT_MS = (WINDOW_SECONDS + 120) * 1000;

const fail = (message) => {
	process.stderr.write(`e2e FAILED: ${message}\n`, () => {
		cleanup();
		process.exit(1);
	});
	return new Promise(() => {});
};

// Beijing wall time (UTC+8) of the window end, written without a zone, to the second.
const windowEnd = Math.ceil((Date.now() + WINDOW_SECONDS * 1000) / 1000) * 1000;
const beijing = new Date(windowEnd + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
const limitMessage = `[claude/x] [429]: {"type":"error","error":{"type":"rate_limit_error","message":"Usage limit reached for 5 hour. Your limit will reset at ${beijing}"}} (reset after 1s)`;

const calls = [];
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		if (!req.url.includes("chat/completions")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "fake-model", object: "model" }] }));
			return;
		}
		const last = (() => {
			try {
				const messages = JSON.parse(body).messages ?? [];
				const content = messages[messages.length - 1]?.content;
				return typeof content === "string" ? content : JSON.stringify(content);
			} catch {
				return "";
			}
		})();
		const open = Date.now() >= windowEnd;
		calls.push({ at: Date.now(), open, last: last.slice(0, 120) });
		if (!open) {
			res.writeHead(429, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: limitMessage, type: "rate_limit_error" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta, finish) =>
			`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
		res.write(chunk({ role: "assistant", content: last.includes("auto-resume") ? "CONTINUED_AFTER_WINDOW" : "OK" }));
		res.write(chunk({}, "stop"));
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const home = mkdtempSync(join(tmpdir(), "jcode-auto-resume-e2e-"));
writeFileSync(
	join(home, "config.toml"),
	`[provider]\ndefault_provider = "fakegw"\ndefault_model = "fake-model"\n\n[providers.fakegw]\ntype = "open-ai-compatible"\nbase_url = "http://127.0.0.1:${port}/v1"\nauth = "none"\nrequires_api_key = false\ndefault_model = "fake-model"\nmodel_catalog = false\n\n[[providers.fakegw.models]]\nid = "fake-model"\n\n[features]\nmemory = false\nauto_poke = false\n`,
);
const runtime = join(home, "run");
const env = {
	...process.env,
	JCODE_HOME: home,
	JCODE_RUNTIME_DIR: runtime,
	JCODE_SOCKET: join(runtime, "jcode.sock"),
	JCODE_NO_AUTO_UPDATE: "1",
	JCODE_AUTO_RESUME_NO_NOTIFY: "1",
	JCODE_AUTO_RESUME_DISCOVERY_MS: "1000",
};

const children = [];
function cleanup() {
	for (const child of children) child.kill();
	server.close();
}

// The "TUI": a client that creates the session and sends the first message, then stays attached.
const { ApiClient } = await import(join(ROOT, "jcode", "api.ts"));
const userBridge = spawn("jcode", ["--no-update", "api-bridge", "--api-socket", join(runtime, "user-api.sock")], { env, stdio: "ignore" });
children.push(userBridge);
let user;
for (let i = 0; i < 120 && !user; i++) {
	await new Promise((r) => setTimeout(r, 500));
	user = await ApiClient.connect(join(runtime, "user-api.sock"), "e2e-user").catch(() => undefined);
}
if (!user) await fail("jcode api-bridge did not come up");
const created = await user.request({ req: "create_session", working_dir: home });
const sessionId = created.session?.session_id;
if (!sessionId) await fail(`no session: ${JSON.stringify(created).slice(0, 200)}`);

// The daemon, told to watch this session (a TUI would make it user_connected).
const daemonEnv = { ...env, JCODE_BIN: "jcode", JCODE_AUTO_RESUME_SESSIONS: sessionId };
const daemonArgs = ["--no-warnings", join(ROOT, "jcode", "daemon.ts")];
if (broken) daemonEnv.JCODE_AUTO_RESUME_BROKEN = "1";
const daemon = spawn(process.execPath, daemonArgs, { env: daemonEnv, stdio: ["ignore", "pipe", "pipe"] });
children.push(daemon);
let daemonLog = "";
daemon.stdout.on("data", (c) => (daemonLog += c));
daemon.stderr.on("data", (c) => (daemonLog += c));
for (let i = 0; i < 60 && !daemonLog.includes("watching"); i++) await new Promise((r) => setTimeout(r, 500));
if (!daemonLog.includes("watching")) await fail(`daemon did not start watching:\n${daemonLog}`);

const sentAt = Date.now();
user.sendMessage(sessionId, "hello");
const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline && !calls.some((c) => c.open && c.last.includes("auto-resume"))) await new Promise((r) => setTimeout(r, 500));
await new Promise((r) => setTimeout(r, 3000));

const continuation = calls.find((c) => c.open && c.last.includes("auto-resume"));
if (!continuation) await fail(`no continuation reached the gateway.\ncalls: ${JSON.stringify(calls.map((c) => [c.at - sentAt, c.open, c.last.slice(0, 40)]))}\ndaemon:\n${daemonLog}`);
if (continuation.at < windowEnd) await fail("continuation was sent before the window ended");
const sends = (daemonLog.match(/sending continuation/g) ?? []).length;
if (sends !== 1) await fail(`expected exactly one continuation, daemon sent ${sends}\n${daemonLog}`);
const limited = calls.filter((c) => !c.open).length;
if (limited < 2) await fail(`jcode did not retry on its own before stopping (${limited} limited calls)`);

process.stdout.write(
	`e2e ok: plan-window 429 → jcode retried ${limited}× and stopped → daemon waited ${Math.round((continuation.at - sentAt) / 1000)}s (window ${WINDOW_SECONDS}s, gateway said 1s) → one marked continuation → answered\n`,
	() => {
		cleanup();
		process.exit(0);
	},
);
