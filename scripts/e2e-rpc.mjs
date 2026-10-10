#!/usr/bin/env node
/**
 * End-to-end check against a real Pi process and a real 429.
 *
 * A local HTTP server plays an OpenAI-compatible provider: the first requests
 * answer 429 with a rate_limit_error and "(reset after 1s)", later requests
 * answer normally. Pi's own retry is shortened to one attempt, so the run
 * settles with the error; the package must then wait and send the marked
 * continuation by itself, and the stub's success answer must follow.
 *
 * Usage:  npm run test:e2e   (needs `pi` on PATH)
 *         PI_AUTO_RESUME_EXTENSION=npm:@fahrizkyputra/pi-auto-resume npm run test:e2e
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 90_000;
const FAILING_REQUESTS = 2; // initial request + Pi's single retry
const SUCCESS_TEXT = "resumed ok after the limit";
// PI_AUTO_RESUME_LANGUAGE=id runs the same check with Indonesian text.
const LANGUAGE = process.env.PI_AUTO_RESUME_LANGUAGE ?? "en";
const EXPECT = {
	en: { prompt: /do not repeat tool calls that already succeeded/, header: /, waited \d+s\):/, notice: /resuming automatically at/ },
	id: { prompt: /jangan ulangi tool call yang sudah berhasil/, header: /, menunggu \d+s\):/, notice: /mencoba lanjut otomatis/ },
}[LANGUAGE];

const extensionSpec =
	process.env.PI_AUTO_RESUME_EXTENSION ??
	resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "auto-resume.ts");

const root = mkdtempSync(join(tmpdir(), "pi-auto-resume-e2e-"));
const agentDir = join(root, "agent");
const workDir = join(root, "work");
for (const dir of [agentDir, workDir]) mkdirSync(dir, { recursive: true });

// Pi's built-in retry: one quick attempt, so the run settles fast.
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { maxRetries: 1, baseDelayMs: 200 } }));
writeFileSync(
	join(agentDir, "auto-resume.json"),
	JSON.stringify(LANGUAGE === "en" ? { slackMs: 200 } : { slackMs: 200, language: LANGUAGE }),
);

let requests = 0;
const server = createServer((request, response) => {
	let body = "";
	request.on("data", (chunk) => (body += chunk));
	request.on("end", () => {
		requests++;
		if (requests <= FAILING_REQUESTS) {
			response.writeHead(429, { "content-type": "application/json", "retry-after-ms": "800" });
			response.end(
				JSON.stringify({
					error: {
						type: "rate_limit_error",
						message: "This request would exceed your account's rate limit. Please try again later. (reset after 1s)",
					},
				}),
			);
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const chunk = (delta, finish) =>
			`data: ${JSON.stringify({
				id: "stub",
				object: "chat.completion.chunk",
				created: 0,
				model: "stub-model",
				choices: [{ index: 0, delta, finish_reason: finish }],
				...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
			})}\n\n`;
		response.write(chunk({ role: "assistant", content: SUCCESS_TEXT }, null));
		response.write(chunk({}, "stop"));
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
		models: [{
			id: "stub-model",
			name: "Stub",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32000,
			maxTokens: 1024,
		}],
	});
}
`,
);

const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", stubExtension, "-e", extensionSpec], {
	cwd: workDir,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	stdio: ["pipe", "pipe", "pipe"],
});

const extensionErrors = [];
const notices = [];
const stderr = [];
let resumeMessage;
let successAfterResume = false;
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

function send(payload) {
	child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function text(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function handle(line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "extension_error") extensionErrors.push(JSON.stringify(event).slice(0, 300));
	if (event.type === "extension_ui_request" && event.method === "notify") notices.push(String(event.message));
	if (event.type === "response" && event.success === false) {
		fail(`rpc ${event.command} failed: ${JSON.stringify(event).slice(0, 300)}`);
	}
	if (event.type === "message_end") {
		const message = event.message ?? {};
		if (message.role === "user" && text(message).startsWith("⚙ auto-resume")) resumeMessage = text(message);
		if (message.role === "assistant" && resumeMessage && text(message).includes(SUCCESS_TEXT)) {
			successAfterResume = true;
			check();
		}
	}
}

function check() {
	if (extensionErrors.length > 0) return fail(`extension error: ${extensionErrors[0]}`);
	if (!resumeMessage) return fail("no auto-resume message was sent");
	if (!EXPECT.prompt.test(resumeMessage) || !EXPECT.header.test(resumeMessage)) {
		return fail(`unexpected ${LANGUAGE} continuation text: ${resumeMessage}`);
	}
	if (!successAfterResume) return fail("the stub's success answer never followed the resume");
	if (!notices.some((notice) => EXPECT.notice.test(notice))) {
		return fail(`no schedule notification, got: ${notices.join(" | ")}`);
	}
	// Idle cache warming can add requests later, so only a lower bound is meaningful.
	if (requests < FAILING_REQUESTS + 1) return fail(`expected at least ${FAILING_REQUESTS + 1} provider requests, saw ${requests}`);
	finish(0);
}

function fail(message) {
	console.error(`FAIL: ${message}`);
	if (stderr.length) console.error(`stderr: ${stderr.join("").slice(-600)}`);
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
		console.log(`e2e ok [${LANGUAGE}]: 429 → Pi gave up → auto-resume sent → stub answered (${requests} requests)`);
	}
	process.exit(code);
}

const timer = setTimeout(
	() => fail(`timed out (requests=${requests}, resume=${resumeMessage ? "sent" : "not sent"}, notices=${notices.join(" | ")})`),
	TIMEOUT_MS,
);

setTimeout(() => {
	send({ id: "m1", type: "set_model", provider: "stub", modelId: "stub-model" });
	setTimeout(() => send({ id: "p1", type: "prompt", message: "say hello" }), 800);
}, 3000);
