#!/usr/bin/env node
/**
 * End-to-end check of a Claude subscription limit behind 9router, against a real Pi process.
 *
 * A local OpenAI-compatible server plays 9router exactly as recorded:
 *   - a successful answer carries `anthropic-ratelimit-unified-reset` (the 5-hour window's end)
 *   - then the account is limited: every request gets
 *     503 {"message":"[claude/claude-opus-5-5] [429]: {…rate_limit_error…} (reset after Ns)"}
 *     where N is 9router's own lock and DOUBLES each time (2, 4, 8, 16 …), with no rate-limit
 *     headers on the error (Pi does not pass a failed request's headers to extensions anyway)
 *   - the limit lifts at the reset the success announced
 *
 * Before the fix (0.3.0), the growing lock made the package give up after two resumes. Now it must
 * wait for the announced reset, send one continuation, and get the answer.
 *
 * Usage:  node scripts/e2e-9router.mjs
 *         PI_AUTO_RESUME_EXTENSION=npm:@fahrizkyputra/pi-auto-resume node scripts/e2e-9router.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 120_000;
const WINDOW_MS = 12_000; // the limit lifts 12 s after it starts
const extensionSpec =
	process.env.PI_AUTO_RESUME_EXTENSION ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "auto-resume.ts");

const root = mkdtempSync(join(tmpdir(), "pi-auto-resume-e2e-9router-"));
const agentDir = join(root, "agent");
const workDir = join(root, "work");
for (const dir of [agentDir, workDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
writeFileSync(join(agentDir, "auto-resume.json"), JSON.stringify({ slackMs: 300 }));

// ---- the scripted 9router ---------------------------------------------------------------------------
let phase = "healthy"; // healthy → limited (at the first "LIMIT" prompt) → lifted at resetAt
let resetAt = 0;
let lockSeconds = 1;
const requests = [];

const NINE_ERROR = (seconds) =>
	`{"message":"[claude/claude-opus-5-5] [429]: {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"rate_limit_error\\",\\"message\\":\\"This request would exceed your account's rate limit. Please try again later.\\"},\\"request_id\\":\\"req_011CExampleRequestId0001\\"} (reset after ${seconds}s)"}`;

const sse = (delta, finish) =>
	`data: ${JSON.stringify({
		id: "stub",
		object: "chat.completion.chunk",
		created: 0,
		model: "stub-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
		...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
	})}\n\n`;

const server = createServer((request, response) => {
	let body = "";
	request.on("data", (chunk) => (body += chunk));
	request.on("end", () => {
		let parsed = {};
		try {
			parsed = JSON.parse(body || "{}");
		} catch {
			// ignore
		}
		const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
		if (messages.length === 0) {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(sse({ role: "assistant", content: "" }, "stop") + "data: [DONE]\n\n");
			return;
		}
		const now = Date.now();
		const last = JSON.stringify(messages.at(-1) ?? {});
		if (phase === "healthy" && last.includes("LIMIT-NOW")) {
			phase = "limited";
			lockSeconds = 1;
		}
		if (phase === "limited" && now >= resetAt) phase = "lifted";

		if (phase === "limited") {
			lockSeconds = Math.min(lockSeconds * 2, 300);
			requests.push({ at: now, status: 503, lock: lockSeconds });
			// No rate-limit headers on the error, as on 9router 0.5.99.
			response.writeHead(503, { "content-type": "application/json", "retry-after": String(lockSeconds) });
			response.end(NINE_ERROR(lockSeconds));
			return;
		}
		requests.push({ at: now, status: 200 });
		// Every successful answer announces when the 5-hour window resets, as 9router forwards it.
		if (phase === "healthy") resetAt = now + WINDOW_MS;
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			"anthropic-ratelimit-unified-status": "allowed",
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
			"anthropic-ratelimit-unified-reset": String(Math.ceil(resetAt / 1000)),
			"anthropic-ratelimit-unified-5h-utilization": "0.97",
		});
		response.write(sse({ role: "assistant", content: phase === "lifted" ? "ANSWER-AFTER-RESET" : "first answer" }, null));
		response.write(sse({}, "stop"));
		response.end("data: [DONE]\n\n");
	});
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

const stubExtension = join(root, "stub-provider.ts");
writeFileSync(
	stubExtension,
	`export default function (pi) {
	pi.registerProvider("stub", {
		baseUrl: "http://127.0.0.1:${port}/v1",
		apiKey: "stub-key",
		api: "openai-completions",
		models: [{ id: "stub-model", name: "Stub", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
	});
}
`,
);

// ---- pi --------------------------------------------------------------------------------------------
const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", stubExtension, "-e", extensionSpec], {
	cwd: workDir,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	stdio: ["pipe", "pipe", "pipe"],
});
const notices = [];
const resumes = [];
const answers = [];
const extensionErrors = [];
const stderr = [];
let finished = false;
child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (!line) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "extension_error") extensionErrors.push(line.slice(0, 300));
		if (event.type === "extension_ui_request" && event.method === "notify") notices.push(String(event.message));
		if (event.type === "message_end") {
			const message = event.message ?? {};
			const content = typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("");
			if (message.role === "user" && content.startsWith("⚙ auto-resume")) resumes.push({ at: Date.now(), content });
			if (message.role === "assistant" && message.stopReason !== "error") answers.push({ at: Date.now(), content });
		}
	}
});

const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${label}`);
}
function finish(code, message) {
	if (finished) return;
	finished = true;
	clearTimeout(timer);
	if (code !== 0) {
		console.error(`FAIL: ${message}`);
		console.error(`requests: ${requests.map((entry) => `${entry.status}${entry.lock ? `(lock ${entry.lock}s)` : ""}@+${((entry.at - requests[0].at) / 1000).toFixed(1)}s`).join(" ")}`);
		console.error(`notices: ${notices.join(" | ")}`);
		if (extensionErrors.length) console.error(`extension errors: ${extensionErrors.join(" | ")}`);
		if (stderr.length) console.error(`stderr: ${stderr.join("").slice(-400)}`);
	} else {
		console.log(message);
	}
	child.kill("SIGKILL");
	server.close();
	rmSync(root, { recursive: true, force: true });
	process.exit(code);
}
const timer = setTimeout(() => finish(1, "timed out"), TIMEOUT_MS);

try {
	await sleep(3000);
	send({ id: "m", type: "set_model", provider: "stub", modelId: "stub-model" });
	await sleep(800);

	// 1. A successful answer: the package learns when the 5-hour window resets.
	send({ id: "p1", type: "prompt", message: "hello" });
	await until(() => answers.some((answer) => answer.content.includes("first answer")), "the first answer", 20_000);
	const limitStartedAt = Date.now();

	// 2. The account hits its limit: 9router answers 503 with a growing "(reset after Ns)".
	send({ id: "p2", type: "prompt", message: "LIMIT-NOW continue the task" });
	await until(() => answers.some((answer) => answer.content.includes("ANSWER-AFTER-RESET")), "the answer after the reset", 60_000);

	const limited = requests.filter((entry) => entry.status === 503);
	const firstAfterReset = requests.find((entry) => entry.status === 200 && entry.at >= resetAt);
	if (!firstAfterReset) throw new Error("no successful request after the reset");
	if (resumes.length !== 1) throw new Error(`expected exactly one continuation (at the reset), saw ${resumes.length}`);
	if (limited.length > 2) throw new Error(`the limited account was hit ${limited.length} times; it should wait, not probe on 9router's lock`);
	const resumedAt = resumes[0].at;
	if (resumedAt < resetAt) throw new Error(`resumed ${((resetAt - resumedAt) / 1000).toFixed(1)}s before the window reset`);
	if (resumedAt > resetAt + 5000) throw new Error(`resumed ${((resumedAt - resetAt) / 1000).toFixed(1)}s after the reset`);
	if (notices.some((notice) => /getting longer|makin jauh|not resuming/.test(notice))) throw new Error(`it gave up: ${notices.join(" | ")}`);
	if (!notices.some((notice) => /plan window ends at/.test(notice))) throw new Error("no notice naming the window's reset");
	if (extensionErrors.length) throw new Error(`extension error: ${extensionErrors[0]}`);
	finish(
		0,
		`e2e ok: 9router 503 "(reset after Ns)" with no headers → waited for the reset learned from a successful answer (${((resumedAt - limitStartedAt) / 1000).toFixed(1)}s, ${limited.length} limited request${limited.length === 1 ? "" : "s"}) → one continuation → answered`,
	);
} catch (error) {
	finish(1, error instanceof Error ? error.message : String(error));
}
