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
	// A time written to the second counts as the end of that second.
	const iso = parseResetHint({ errorMessage: "limit resets at 2026-03-11T10:05:00Z", now: NOW });
	assert.equal(iso?.delayMs, 5 * 60_000 + 1000);
	const exact = parseResetHint({ errorMessage: "limit resets at 2026-03-11T10:05:00.000Z", now: NOW });
	assert.equal(exact?.delayMs, 5 * 60_000, "a time with milliseconds is exact");

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

// ---- plan windows: the real end of a 5-hour or weekly limit ---------------------------------------------

const GLM_5H =
	'429: {"message":"[glm/glm-5.3] [429]: {\\"error\\":{\\"code\\":\\"1308\\",\\"message\\":\\"Usage limit reached for 5 hour. Your limit will reset at 2026-08-12 17:11:22\\"}} (reset after 2s)"}';
const COMMANDCODE_WEEKLY =
	'429: {"message":"You\'ve reached your weekly usage limit for your plan. Your limit resets at 2026-09-16T05:07:39.132Z. Please wait for the window to reset or upgrade your plan to continue.","type":"rate_limit_error","code":"RATE_LIMITED"}';

test("a window's real end wins over the gateway's own 'reset after 2s'", () => {
	// The gateway pauses 2 s between its own retries; the limit really lifts at 17:11:22 Beijing time.
	const now = Date.parse("2026-08-12T04:49:22Z");
	const hint = parseResetHint({ errorMessage: GLM_5H, now });
	assert.equal(hint?.kind, "window");
	// 17:11:22 at UTC+8 is 09:11:22 UTC; the message states whole seconds, so it counts as the end of that second.
	assert.equal(hint?.delayMs, Date.parse("2026-08-12T09:11:23Z") - now);
	assert.match(hint?.raw ?? "", /will reset at 2026-08-12 17:11:22/);
});

test("a time without a zone is read at the configured offset, Beijing time by default", () => {
	const now = Date.parse("2026-08-12T04:49:22Z");
	const utc = parseResetHint({ errorMessage: GLM_5H, now, zonelessOffsetHours: 0 });
	assert.equal(utc?.delayMs, Date.parse("2026-08-12T17:11:23Z") - now);
	const jakarta = parseResetHint({ errorMessage: GLM_5H, now, zonelessOffsetHours: 7 });
	assert.equal(jakarta?.delayMs, Date.parse("2026-08-12T10:11:23Z") - now);
	const half = parseResetHint({ errorMessage: GLM_5H, now, zonelessOffsetHours: 5.5 });
	assert.equal(half?.delayMs, Date.parse("2026-08-12T11:41:23Z") - now, "half-hour offsets work");
});

test("an explicit zone in the message is never overridden by the offset setting", () => {
	const now = Date.parse("2026-09-11T05:28:00Z");
	const hint = parseResetHint({ errorMessage: COMMANDCODE_WEEKLY, now, zonelessOffsetHours: 8 });
	assert.equal(hint?.kind, "window");
	assert.equal(hint?.delayMs, Date.parse("2026-09-16T05:07:39.132Z") - now, "a time with milliseconds is exact");
	const withOffset = parseResetHint({ errorMessage: "Your limit resets at 2026-09-16T12:07:39+07:00.", now });
	assert.equal(withOffset?.delayMs, Date.parse("2026-09-16T05:07:40Z") - now);
	const gmt = parseResetHint({ errorMessage: "Your limit resets at 2026-09-16 05:07:39 UTC.", now });
	assert.equal(gmt?.delayMs, Date.parse("2026-09-16T05:07:40Z") - now);
});

test("a window that already ended waits no time at all", () => {
	const hint = parseResetHint({ errorMessage: GLM_5H, now: Date.parse("2026-08-12T10:00:00Z") });
	assert.equal(hint?.delayMs, 0);
});

test("the gateway's own pause is a retry, not a window", () => {
	const hint = parseResetHint({ errorMessage: NINE_ROUTER_429, now: NOW });
	assert.equal(hint?.kind, "retry");
	assert.equal(parseResetHint({ errorMessage: "", headers: { "retry-after": "30" }, now: NOW })?.kind, "retry");
	assert.equal(parseResetHint({ errorMessage: "", headers: { "x-ratelimit-reset": String(NOW / 1000 + 600) }, now: NOW })?.kind, "window");
});

test("every duration shape 9router writes is read", () => {
	const shapes: [string, number][] = [
		["(reset after 58s)", 58_000],
		["(reset after 1m 4s)", 64_000],
		["(reset after 5m)", 300_000],
		["(reset after 1h 2m 3s)", 3_723_000],
	];
	for (const [text, expected] of shapes) {
		assert.equal(parseResetHint({ errorMessage: `503: [429] rate_limit_error ${text}`, now: NOW })?.delayMs, expected, text);
	}
});

test("a nonsense far-future window is ignored", () => {
	assert.equal(parseResetHint({ errorMessage: "Your limit resets at 2099-01-01 00:00:00", now: NOW })?.kind, undefined);
});
