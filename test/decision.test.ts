import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { classifyError, decideResume } from "../src/decision.ts";

const NOW = Date.parse("2026-03-11T10:00:00.000Z");
const RATE_LIMIT_8S =
	"503: [429] rate_limit_error: This request would exceed your account's rate limit. Please try again later. (reset after 8s)";

function decide(overrides: Partial<Parameters<typeof decideResume>[0]> = {}) {
	return decideResume({
		errorMessage: RATE_LIMIT_8S,
		now: NOW,
		config: DEFAULT_CONFIG,
		awaitingOutcome: false,
		resumesDone: 0,
		...overrides,
	});
}

test("classifies rate limits, quota limits, and everything else", () => {
	assert.equal(classifyError(RATE_LIMIT_8S), "rate-limit");
	assert.equal(classifyError("429 Too Many Requests"), "rate-limit");
	assert.equal(classifyError("model is overloaded"), "rate-limit");
	assert.equal(classifyError("insufficient_quota: You exceeded your current quota"), "quota");
	assert.equal(classifyError("Monthly usage limit reached"), "quota");
	assert.equal(classifyError("MODEL_NOT_IN_PLAN: available in Pro"), "quota");
	assert.equal(classifyError("Connection error."), "transient", "a dropped connection is retried, not ignored");
	assert.equal(classifyError("Stream ended without finish_reason"), "transient");
	assert.equal(classifyError("an explanation of the plan"), "other", "no false positive on 'explanation'");
	assert.equal(classifyError("Insufficient Balance"), "quota");
	assert.equal(classifyError("authentication_error: OAuth access token has expired"), "quota", "a retry cannot fix a credential");
	assert.equal(classifyError(undefined), "other");
});

test("schedules a rate limit that carries a reset hint", () => {
	const decision = decide();
	assert.equal(decision.action, "schedule");
	if (decision.action === "schedule") assert.equal(decision.delayMs, 8000);
});

test("a rate limit without any time is retried on a growing pause, then reported", () => {
	const message = "rate limit exceeded";
	const delays: number[] = [];
	for (let attempts = 0; attempts < 4; attempts++) {
		const decision = decide({ errorMessage: message, backoffAttempts: attempts });
		assert.equal(decision.action, "schedule");
		if (decision.action === "schedule") {
			assert.equal(decision.reason, "backoff");
			assert.equal(decision.attempt, attempts + 1);
			delays.push(decision.delayMs);
		}
	}
	assert.deepEqual(delays, [30_000, 60_000, 120_000, 300_000]);
	const exhausted = decide({ errorMessage: message, backoffAttempts: 4 });
	assert.equal(exhausted.action, "report");
	if (exhausted.action === "report") assert.equal(exhausted.reason.code, "retries-exhausted");
});

test("money and plan problems are reported even when they carry a time", () => {
	assert.equal(decide({ errorMessage: "Monthly usage limit reached, resets at 2026-04-01T00:00:00Z" }).action, "report");
	assert.equal(decide({ errorMessage: "insufficient_quota: You exceeded your current quota, resets at 2026-04-01T00:00:00Z" }).action, "report");
	assert.equal(decide({ errorMessage: "Insufficient Balance (request_id: x)" }).action, "report");
	assert.equal(decide({ errorMessage: "authentication_error: OAuth access token has expired" }).action, "report");
});

test("a 5-hour or weekly window waits for its real end, however long", () => {
	const fiveHour = decide({ errorMessage: "429: Usage limit reached for 5 hour. Your limit will reset at 2026-03-11 19:26:43 (reset after 2s)" });
	assert.equal(fiveHour.action, "schedule");
	if (fiveHour.action === "schedule") {
		assert.equal(fiveHour.reason, "window-reset");
		// 19:26:43 Beijing time is 11:26:43 UTC, read as the end of that second: 1h26m44s after NOW, not the gateway's 2 seconds.
		assert.equal(fiveHour.delayMs, Date.parse("2026-03-11T11:26:44Z") - NOW);
	}
	const weekly = decide({ errorMessage: "You've reached your weekly usage limit for your plan. Your limit resets at 2026-03-16T05:07:39.132Z. Please wait" });
	assert.equal(weekly.action, "schedule");
	if (weekly.action === "schedule") assert.equal(weekly.delayMs, Date.parse("2026-03-16T05:07:39.132Z") - NOW);
});

test("transient failures retry on the backoff, ignoring the gateway's own pause", () => {
	const decision = decide({ errorMessage: "503: [502]: fetch failed (cause: ETIMEDOUT) (reset after 3s)" });
	assert.equal(decision.action, "schedule");
	if (decision.action === "schedule") {
		assert.equal(decision.reason, "backoff");
		assert.equal(decision.delayMs, 30_000, "not 3 seconds");
	}
});

test("the weekly wait still respects maxWaitMs when the user sets one", () => {
	const message = "You've reached your weekly usage limit for your plan. Your limit resets at 2026-03-16T05:07:39.132Z.";
	assert.equal(decide({ errorMessage: message, config: { ...DEFAULT_CONFIG, maxWaitMs: 6 * 3_600_000 } }).action, "report");
});

test("ignores unrelated errors and clean runs", () => {
	assert.equal(decide({ errorMessage: "Invalid request: messages.3.content is empty" }).action, "ignore");
	assert.equal(decide({ errorMessage: undefined }).action, "ignore");
	assert.equal(decide({ config: { ...DEFAULT_CONFIG, enabled: false } }).action, "ignore");
});

test("stops when the resume immediately hits the same error", () => {
	const decision = decide({
		lastScheduled: { errorText: RATE_LIMIT_8S, hintMs: 8000 },
		awaitingOutcome: true,
	});
	assert.equal(decision.action, "report");
});

test("the same error after real progress is a fresh limit", () => {
	const decision = decide({
		lastScheduled: { errorText: RATE_LIMIT_8S, hintMs: 8000 },
		awaitingOutcome: false,
	});
	assert.equal(decision.action, "schedule");
});

test("stops when the reset hint grows sharply", () => {
	const decision = decide({
		errorMessage: "rate limit (reset after 20m)",
		lastScheduled: { errorText: RATE_LIMIT_8S, hintMs: 8000 },
	});
	assert.equal(decision.action, "report");
});

test("small fluctuations in the hint do not stop it", () => {
	const decision = decide({
		errorMessage: "rate limit (reset after 9s)",
		lastScheduled: { errorText: RATE_LIMIT_8S, hintMs: 8000 },
	});
	assert.equal(decision.action, "schedule");
});

test("unbounded by default, but honours configured limits", () => {
	assert.equal(decide({ errorMessage: "rate limit (reset after 3h)" }).action, "schedule");
	assert.equal(
		decide({ errorMessage: "rate limit (reset after 3h)", config: { ...DEFAULT_CONFIG, maxWaitMs: 60_000 } }).action,
		"report",
	);
	assert.equal(decide({ resumesDone: 3, config: { ...DEFAULT_CONFIG, maxResumes: 3 } }).action, "report");
	assert.equal(decide({ resumesDone: 50 }).action, "schedule", "maxResumes 0 means no limit");
});
