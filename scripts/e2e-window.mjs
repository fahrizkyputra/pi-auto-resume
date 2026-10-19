#!/usr/bin/env node
/**
 * End-to-end check of the two cases the first version skipped, against a real Pi process.
 *
 * A local OpenAI-compatible server plays 9router and fails the way 9router really does:
 *
 *   A. Plan window. The error says "Usage limit reached for 5 hour. Your limit will reset at
 *      <Beijing time>" and, right next to it, the gateway's own "(reset after 2s)". The window
 *      ends a few seconds from now. The package must wait for the real end, not 2 seconds: a
 *      request that arrives early is answered with the same limit again.
 *   B. No time at all. "Stream ended without finish_reason" (a dropped stream) twice in a row.
 *      The package must retry by itself, on the backoff ladder, until a request succeeds.
 *
 * The backoff steps are shortened through PI_AUTO_RESUME_BACKOFF_MS so the check runs in seconds.
 *
 * Usage:  node scripts/e2e-window.mjs
 *         PI_AUTO_RESUME_EXTENSION=npm:@fahrizkyputra/pi-auto-resume node scripts/e2e-window.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 120_000;
const extensionSpec =
	process.env.PI_AUTO_RESUME_EXTENSION ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "auto-resume.ts");

const root = mkdtempSync(join(tmpdir(), "pi-auto-resume-e2e-window-"));
const agentDir = join(root, "agent");
const workDir = join(root, "work");
for (const dir of [agentDir, workDir]) mkdirSync(dir, { recursive: true });
// Pi's own retry off: the run settles on the first error, so only this package acts.
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
writeFileSync(join(agentDir, "auto-resume.json"), JSON.stringify({ slackMs: 300 }));

// ---- the scripted provider ---------------------------------------------------------------------

/** Beijing time (UTC+8) as 9router's GLM route writes it: no zone, "YYYY-MM-DD HH:MM:SS". */
function beijing(timestamp) {
	const shifted = new Date(timestamp + 8 * 3600 * 1000);
	return shifted.toISOString().replace("T", " ").slice(0, 19);
}

const WINDOW_SECONDS = 6;
let windowEndsAt = 0; // set when the first request arrives
let scenario = "window";
const log = [];
let requestsInScenario = 0;

function windowError() {
	return {
		message: `[glm/glm-5.3] [429]: {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at ${beijing(windowEndsAt)}"}} (reset after 2s)`,
	};
}

const server = createServer((request, response) => {
	let body = "";
	request.on("data", (chunk) => (body += chunk));
	request.on("end", () => {
		let parsed = {};
		try {
			parsed = JSON.parse(body || "{}");
		} catch {
			// not json
		}
		const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
		const sse = (delta, finish) =>
			`data: ${JSON.stringify({
				id: "stub",
				object: "chat.completion.chunk",
				created: 0,
				model: "stub-model",
				choices: [{ index: 0, delta, finish_reason: finish }],
				...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
			})}\n\n`;
		if (messages.length === 0) {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(sse({ role: "assistant", content: "" }, "stop") + "data: [DONE]\n\n");
			return;
		}
		requestsInScenario++;
		const now = Date.now();
		log.push({ scenario, at: now, n: requestsInScenario });

		if (scenario === "window") {
			if (windowEndsAt === 0) windowEndsAt = now + WINDOW_SECONDS * 1000;
			if (now < windowEndsAt) {
				response.writeHead(429, { "content-type": "application/json" });
				response.end(JSON.stringify(windowError()));
				return;
			}
		}
		if (scenario === "network" && requestsInScenario <= 2) {
			// A dropped stream: headers and one token, then the connection ends without a finish_reason.
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(sse({ role: "assistant", content: "par" }, null));
			response.end();
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		response.write(sse({ role: "assistant", content: `ok from ${scenario}` }, null));
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

// ---- the pi process ----------------------------------------------------------------------------------

const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", stubExtension, "-e", extensionSpec], {
	cwd: workDir,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AUTO_RESUME_BACKOFF_MS: "1500,2500,3500,4500" },
	stdio: ["pipe", "pipe", "pipe"],
});

const extensionErrors = [];
const notices = [];
const stderr = [];
const settled = [];
const resumes = [];
const assistantTexts = [];
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
		if (line) handle(line);
	}
});

const text = (message) => {
	const content = message?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
};

function handle(line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "extension_error") extensionErrors.push(JSON.stringify(event).slice(0, 300));
	if (event.type === "extension_ui_request" && event.method === "notify") notices.push({ at: Date.now(), message: String(event.message) });
	if (event.type === "agent_settled") settled.push({ at: Date.now(), aborted: event.aborted });
	if (event.type === "message_end") {
		const message = event.message ?? {};
		if (message.role === "user" && text(message).startsWith("⚙ auto-resume")) resumes.push({ at: Date.now(), scenario, text: text(message) });
		if (message.role === "assistant" && message.stopReason !== "error") assistantTexts.push({ at: Date.now(), text: text(message) });
	}
}

const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, ms = 60_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function fail(message) {
	console.error(`FAIL: ${message}`);
	console.error(`scenario log: ${log.map((entry) => `${entry.scenario}#${entry.n}@+${((entry.at - (log[0]?.at ?? entry.at)) / 1000).toFixed(1)}s`).join(" ")}`);
	console.error(`notices: ${notices.map((notice) => notice.message).join(" | ")}`);
	if (extensionErrors.length) console.error(`extension errors: ${extensionErrors.join(" | ")}`);
	if (stderr.length) console.error(`stderr: ${stderr.join("").slice(-500)}`);
	finish(1);
}

function finish(code) {
	if (finished) return;
	finished = true;
	clearTimeout(timer);
	child.kill("SIGKILL");
	server.close();
	rmSync(root, { recursive: true, force: true });
	if (code === 0) {
		console.log(
			"e2e ok: 5-hour window waited for its real end (not 2s) → resumed → answered; dropped stream retried on the backoff ladder → answered",
		);
	}
	process.exit(code);
}

const timer = setTimeout(() => fail("timed out"), TIMEOUT_MS);

try {
	await sleep(3000);
	send({ id: "m1", type: "set_model", provider: "stub", modelId: "stub-model" });
	await sleep(800);

	// ---- A. plan window ------------------------------------------------------------------------
	scenario = "window";
	send({ id: "a1", type: "prompt", message: "say hello" });
	await until(() => assistantTexts.some((entry) => entry.text.includes("ok from window")), "the answer after the window ended", 40_000);

	const windowRequests = log.filter((entry) => entry.scenario === "window");
	const firstRequestAt = windowRequests[0].at;
	const lastRequestAt = windowRequests.at(-1).at;
	const waitedS = (lastRequestAt - firstRequestAt) / 1000;
	if (windowRequests.length > 3) throw new Error(`the window was hammered with ${windowRequests.length} requests`);
	if (waitedS < WINDOW_SECONDS - 0.5) {
		throw new Error(`resumed after ${waitedS.toFixed(1)}s, before the window ended (${WINDOW_SECONDS}s): it followed the gateway's 2s`);
	}
	if (waitedS > WINDOW_SECONDS + 8) throw new Error(`resumed late, after ${waitedS.toFixed(1)}s`);
	const windowNotice = notices.find((notice) => /Usage limit: the plan window ends at/.test(notice.message));
	if (!windowNotice) throw new Error("no plan-window notice");
	if (!resumes.some((entry) => entry.scenario === "window")) throw new Error("no marked continuation was sent for the window");
	await sleep(1500);

	// ---- B. dropped stream, no time anywhere -----------------------------------------------------
	scenario = "network";
	requestsInScenario = 0;
	const resumesBefore = resumes.length;
	send({ id: "b1", type: "prompt", message: "say hello again" });
	await until(() => assistantTexts.some((entry) => entry.text.includes("ok from network")), "the answer after two dropped streams", 60_000);

	const networkRequests = log.filter((entry) => entry.scenario === "network");
	if (networkRequests.length < 3) throw new Error(`expected 3 requests (2 dropped, 1 ok), saw ${networkRequests.length}`);
	const gaps = networkRequests.slice(1).map((entry, index) => (entry.at - networkRequests[index].at) / 1000);
	if (gaps[0] < 1.2) throw new Error(`first retry came after ${gaps[0].toFixed(1)}s, expected the first ladder step (1.5s)`);
	if (gaps[1] < 2.2) throw new Error(`second retry came after ${gaps[1].toFixed(1)}s, expected the second ladder step (2.5s)`);
	if (resumes.length - resumesBefore !== 2) throw new Error(`expected 2 retries, saw ${resumes.length - resumesBefore}`);
	const backoffNotices = notices.filter((notice) => /Temporary failure with no reset time: retry \d of 4/.test(notice.message));
	if (backoffNotices.length < 2) throw new Error(`expected retry notices, saw ${backoffNotices.length}`);

	if (extensionErrors.length) throw new Error(`extension error: ${extensionErrors[0]}`);
	finish(0);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
