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

test("/auto-resume language switches the continuation language and persists it", async () => {
	const { pi, ctx, emit, commands, sent, notices } = fakePi();
	autoResumeExtension(pi);
	await emit("session_start", { reason: "startup" });

	await commands["auto-resume"]!.handler("language id", ctx);
	assert.match(notices.at(-1) ?? "", /Bahasa auto-resume: Bahasa Indonesia/);

	await emit("message_end", { message: errorMessage("rate limit (reset after 0s)") });
	await emit("agent_settled", { aborted: false });
	await sleep(200);
	assert.match(sent.at(-1) ?? "", /menunggu .*\n.*jangan ulangi tool call/s);

	await commands["auto-resume"]!.handler("language fr", ctx);
	assert.match(notices.at(-1) ?? "", /tidak dikenal/);

	await commands["auto-resume"]!.handler("language english", ctx);
	assert.match(notices.at(-1) ?? "", /Auto-resume language: English/);
	await emit("session_start", { reason: "reload" });
	await emit("message_end", { message: errorMessage("rate limit (reset after 0s)") });
	await emit("agent_settled", { aborted: false });
	await sleep(200);
	assert.match(sent.at(-1) ?? "", /waited .*\n.*do not repeat tool calls/s, "persisted across a reload");
});

// ---- the wall-clock timer: hours and days of waiting ------------------------------------------------------

import { WALL_CLOCK_TICK_MS, wallClockTimer } from "../extensions/auto-resume.ts";

/** A fake clock plus a fake scheduler: time only moves when the test says so. */
function fakeClock() {
	let now = 1_000_000;
	const queue: { at: number; callback: () => void; cancelled: boolean }[] = [];
	const schedule = (callback: () => void, ms: number) => {
		const entry = { at: now + ms, callback, cancelled: false };
		queue.push(entry);
		return { cancel: () => (entry.cancelled = true) };
	};
	/** Advance the wall clock; fire due callbacks in order, as a real event loop would. */
	const advance = (ms: number, options: { sleep?: boolean } = {}) => {
		const end = now + ms;
		if (options.sleep) {
			// The machine slept: the wall clock jumped, but no timer ran in between.
			now = end;
			for (const entry of queue.filter((item) => !item.cancelled && item.at <= now)) {
				entry.cancelled = true;
				entry.callback();
			}
			return;
		}
		for (;;) {
			const next = queue.filter((item) => !item.cancelled).sort((a, b) => a.at - b.at)[0];
			if (!next || next.at > end) break;
			now = next.at;
			next.cancelled = true;
			next.callback();
		}
		now = end;
	};
	return { now: () => now, schedule, advance, pending: () => queue.filter((item) => !item.cancelled).length };
}

test("wallClockTimer: fires at the wall-clock moment, in short steps", () => {
	const clock = fakeClock();
	let fired = 0;
	wallClockTimer(3 * 60_000, () => fired++, clock.now, clock.schedule);
	clock.advance(2 * 60_000);
	assert.equal(fired, 0);
	clock.advance(60_000 + 1);
	assert.equal(fired, 1);
	clock.advance(10 * 60_000);
	assert.equal(fired, 1, "fires once");
});

test("wallClockTimer: a wait of days works (no 24.8-day limit) and never schedules a huge timeout", () => {
	const clock = fakeClock();
	let fired = 0;
	const scheduled: number[] = [];
	const spy = (callback: () => void, ms: number) => {
		scheduled.push(ms);
		return clock.schedule(callback, ms);
	};
	const fourDays = 4 * 24 * 3600 * 1000;
	wallClockTimer(fourDays, () => fired++, clock.now, spy);
	clock.advance(fourDays - 1000);
	assert.equal(fired, 0);
	clock.advance(1000 + WALL_CLOCK_TICK_MS);
	assert.equal(fired, 1);
	assert.ok(Math.max(...scheduled) <= WALL_CLOCK_TICK_MS, "every real timeout is a short step");
	const fortyDays = 40 * 24 * 3600 * 1000;
	const second = fakeClock();
	let secondFired = 0;
	wallClockTimer(fortyDays, () => secondFired++, second.now, second.schedule);
	assert.equal(secondFired, 0, "a 40-day delay does not fire at once, as a plain setTimeout would");
});

test("wallClockTimer: a laptop that slept wakes up on time, not late by the sleep", () => {
	const clock = fakeClock();
	let fired = 0;
	wallClockTimer(5 * 3600 * 1000, () => fired++, clock.now, clock.schedule);
	clock.advance(60_000);
	// The lid is closed for 6 hours: the wall clock jumps past the target while no timer runs.
	clock.advance(6 * 3600 * 1000, { sleep: true });
	assert.equal(fired, 1, "the first step after waking sees the target has passed");
});

test("wallClockTimer: cancel stops it, mid-wait", () => {
	const clock = fakeClock();
	let fired = 0;
	const cancel = wallClockTimer(10 * 60_000, () => fired++, clock.now, clock.schedule);
	clock.advance(5 * 60_000);
	cancel();
	clock.advance(60 * 60_000);
	assert.equal(fired, 0);
	assert.equal(clock.pending(), 0, "nothing is left scheduled");
});

test("wallClockTimer: a delay of zero fires immediately", () => {
	const clock = fakeClock();
	let fired = 0;
	wallClockTimer(0, () => fired++, clock.now, clock.schedule);
	assert.equal(fired, 1);
});
