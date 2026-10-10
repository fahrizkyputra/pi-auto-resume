import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration, parseResetHint } from "../src/reset-hint.ts";

const NOW = Date.parse("2026-03-11T10:00:00.000Z");

// The exact shape 9router produces in this user's sessions.
const NINE_ROUTER_429 =
	'503: {"message":"[claude/claude-opus-5-5] [429]: {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"rate_limit_error\\",\\"message\\":\\"This request would exceed your account\'s rate limit. Please try again later.\\"},\\"request_id\\":\\"req_011Cfq9zHs61w3dcCfdbdwDs\\"} (reset after 8s)"}';

test("reads the 9router suffix from a real error", () => {
	const hint = parseResetHint({ errorMessage: NINE_ROUTER_429, now: NOW });
	assert.equal(hint?.delayMs, 8000);
	assert.equal(hint?.source, "text");
});

test("reads common text phrasings", () => {
	const cases: [string, number][] = [
		["(reset after 2s)", 2000],
		["reset after 2m", 120_000],
		["Rate limited, retry after 30 seconds", 30_000],
		["Please try again in 2 minutes.", 120_000],
		["try again in 1h30m", 5_400_000],
		["limit resets in 45s", 45_000],
		["retry-after: 12", 12_000],
	];
	for (const [text, expected] of cases) {
		assert.equal(parseResetHint({ errorMessage: text, now: NOW })?.delayMs, expected, text);
	}
});

test("reads absolute reset times", () => {
	const iso = parseResetHint({ errorMessage: "limit resets at 2026-03-11T10:05:00Z", now: NOW });
	assert.equal(iso?.delayMs, 5 * 60_000);

	const clock = parseResetHint({ errorMessage: "usage resets at 18:00", now: NOW });
	assert.ok(clock && clock.delayMs > 0 && clock.delayMs <= 24 * 3_600_000, "next occurrence of 18:00");
});

test("headers win over text", () => {
	const hint = parseResetHint({ errorMessage: "(reset after 8s)", headers: { "Retry-After": "20" }, now: NOW });
	assert.equal(hint?.delayMs, 20_000);
	assert.equal(hint?.source, "header");
});

test("reads every supported header", () => {
	assert.equal(parseResetHint({ headers: { "retry-after-ms": "1500" }, now: NOW })?.delayMs, 1500);
	assert.equal(
		parseResetHint({ headers: { "retry-after": "Wed, 11 Mar 2026 10:01:00 GMT" }, now: NOW })?.delayMs,
		60_000,
	);
	assert.equal(parseResetHint({ headers: { "x-ratelimit-reset-after": "7" }, now: NOW })?.delayMs, 7000);
	assert.equal(
		parseResetHint({ headers: { "x-ratelimit-reset": String(NOW / 1000 + 30) }, now: NOW })?.delayMs,
		30_000,
	);
});

test("returns nothing when there is no hint", () => {
	assert.equal(parseResetHint({ errorMessage: "rate limit exceeded", now: NOW }), undefined);
	assert.equal(parseResetHint({ errorMessage: "", now: NOW }), undefined);
	assert.equal(parseResetHint({ now: NOW }), undefined);
});

test("past reset times clamp to zero and absurd ones are rejected", () => {
	assert.equal(parseResetHint({ errorMessage: "resets at 2026-03-11T09:00:00Z", now: NOW })?.delayMs, 0);
	assert.equal(parseResetHint({ headers: { "retry-after": "999999999" }, now: NOW }), undefined);
});

test("parseDuration handles units and compounds", () => {
	assert.equal(parseDuration("8s"), 8000);
	assert.equal(parseDuration("1.5 hours"), 5_400_000);
	assert.equal(parseDuration("2m 30s"), 150_000);
	assert.equal(parseDuration("250ms"), 250);
	assert.equal(parseDuration("soon"), undefined);
});
