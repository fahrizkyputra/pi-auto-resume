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
	assert.equal(classifyError("Connection error."), "other");
	assert.equal(classifyError("an explanation of the plan"), "other", "no false positive on 'explanation'");
	assert.equal(classifyError(undefined), "other");
});

test("schedules a rate limit that carries a reset hint", () => {
	const decision = decide();
	assert.equal(decision.action, "schedule");
	if (decision.action === "schedule") assert.equal(decision.delayMs, 8000);
});

test("reports a rate limit without a reset hint", () => {
	const decision = decide({ errorMessage: "rate limit exceeded" });
	assert.equal(decision.action, "report");
});

test("reports quota errors even when they carry a hint", () => {
	const decision = decide({ errorMessage: "Monthly usage limit reached, resets at 2026-04-01T00:00:00Z" });
	assert.equal(decision.action, "report");
});

test("ignores unrelated errors and clean runs", () => {
	assert.equal(decide({ errorMessage: "Connection error." }).action, "ignore");
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
