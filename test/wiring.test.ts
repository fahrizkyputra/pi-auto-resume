/**
 * Wiring: the extension entry point driven through fake Pi events, with real
 * (short) timers.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoResumeExtension from "../extensions/auto-resume.ts";
import { DEFAULT_CONFIG, writeConfig } from "../src/config.ts";

let agentDir: string;
let previousAgentDir: string | undefined;

before(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-auto-resume-wiring-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeConfig({ ...DEFAULT_CONFIG, slackMs: 50 }, join(agentDir, "auto-resume.json"));
});

after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
	const hooks: Record<string, Handler[]> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const sent: string[] = [];
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];

	const pi = {
		on: (name: string, handler: Handler) => {
			hooks[name] = [...(hooks[name] ?? []), handler];
		},
		registerCommand: (name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commands[name] = definition;
		},
		sendUserMessage: (text: string) => sent.push(text),
	} as unknown as ExtensionAPI;

	const ctx = {
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
		},
	};

	const emit = async (name: string, event: Record<string, unknown> = {}) => {
		for (const handler of hooks[name] ?? []) await handler({ type: name, ...event }, ctx);
	};

	return { pi, ctx, hooks, commands, sent, notices, statuses, emit };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(text: string) {
	return { role: "assistant", stopReason: "error", errorMessage: text };
}

test("registers the hooks and the /auto-resume command", () => {
	const { pi, hooks, commands } = fakePi();
	autoResumeExtension(pi);
	for (const name of ["session_start", "after_provider_response", "message_end", "agent_settled", "input", "session_shutdown"]) {
		assert.ok(hooks[name]?.length, `missing ${name}`);
	}
	assert.ok(commands["auto-resume"]);
});

test("an errored run with a reset hint resumes by itself", async () => {
	const { pi, emit, sent } = fakePi();
	autoResumeExtension(pi);
	await emit("session_start", { reason: "startup" });
	await emit("after_provider_response", { status: 429, headers: { "retry-after-ms": "100" } });
	await emit("message_end", { message: errorMessage("429 rate_limit_error") });
	await emit("agent_settled", { aborted: false });

	assert.deepEqual(sent, []);
	await sleep(250);
	assert.equal(sent.length, 1);
	assert.match(sent[0] ?? "", /^⚙ auto-resume/);
});

test("typing cancels, the package's own message does not", async () => {
	const { pi, emit, sent } = fakePi();
	autoResumeExtension(pi);
	await emit("session_start", { reason: "startup" });
	await emit("after_provider_response", { status: 429, headers: { "retry-after-ms": "100" } });
	await emit("message_end", { message: errorMessage("429 rate_limit_error") });
	await emit("agent_settled", { aborted: false });

	await emit("input", { source: "extension", text: "⚙ auto-resume ..." });
	await emit("input", { source: "interactive", text: "do something else" });
	await sleep(250);
	assert.deepEqual(sent, []);
});

test("an aborted run is never resumed", async () => {
	const { pi, emit, sent } = fakePi();
	autoResumeExtension(pi);
	await emit("session_start", { reason: "startup" });
	await emit("message_end", { message: errorMessage("rate limit (reset after 0s)") });
	await emit("agent_settled", { aborted: true });
	await sleep(200);
	assert.deepEqual(sent, []);
});

test("a clean run clears the error so nothing is scheduled", async () => {
	const { pi, emit, sent } = fakePi();
	autoResumeExtension(pi);
	await emit("session_start", { reason: "startup" });
	await emit("message_end", { message: errorMessage("rate limit (reset after 0s)") });
	await emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
	await emit("agent_settled", { aborted: false });
	await sleep(200);
	assert.deepEqual(sent, []);
});

test("/auto-resume off disables, and shutdown cancels", async () => {
	const { pi, ctx, emit, commands, sent } = fakePi();
	autoResumeExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands["auto-resume"]!.handler("off", ctx);
	await emit("message_end", { message: errorMessage("rate limit (reset after 0s)") });
	await emit("agent_settled", { aborted: false });
	await sleep(200);
	assert.deepEqual(sent, []);

	await commands["auto-resume"]!.handler("on", ctx);
	await emit("message_end", { message: errorMessage("rate limit (reset after 1s)") });
	await emit("agent_settled", { aborted: false });
	await emit("session_shutdown");
	await sleep(1200);
	assert.deepEqual(sent, []);
});
