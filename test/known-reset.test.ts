import assert from "node:assert/strict";
import { test } from "node:test";
import { isClaudeGatewayLimit, readUnifiedReset } from "../src/known-reset.ts";

const NOW = Date.UTC(2026, 9, 30, 6, 0, 0); // 30 Oct, 13:00 WIB

// The exact header set 9router returned on a successful cc/ request (recorded in this session).
const SUCCESS_HEADERS = {
	"anthropic-ratelimit-unified-representative-claim": "five_hour",
	"anthropic-ratelimit-unified-reset": String(NOW / 1000 + 2 * 3600),
	"anthropic-ratelimit-unified-status": "allowed",
	"anthropic-ratelimit-unified-5h-reset": String(NOW / 1000 + 2 * 3600),
	"anthropic-ratelimit-unified-5h-utilization": "0.82",
	"anthropic-ratelimit-unified-7d-reset": String(NOW / 1000 + 4 * 24 * 3600),
	"anthropic-ratelimit-unified-7d-utilization": "0.43",
};

// The error the user pasted, unchanged.
const USER_ERROR =
	'503: {"message":"[claude/claude-opus-5-5] [429]: {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"rate_limit_error\\",\\"message\\":\\"This request would exceed your account\'s rate limit. Please try again later.\\"},\\"request_id\\":\\"req_011CExampleRequestId0001\\"} (reset after 9s)"}';

test("reads the window that holds, from the representative claim", () => {
	const known = readUnifiedReset(SUCCESS_HEADERS, NOW);
	assert.equal(known?.window, "five_hour");
	assert.equal(known?.resetAt, NOW + 2 * 3600 * 1000);
	assert.equal(known?.utilization, 0.82);
});

test("a weekly claim picks the weekly reset", () => {
	const known = readUnifiedReset({ ...SUCCESS_HEADERS, "anthropic-ratelimit-unified-representative-claim": "seven_day" }, NOW);
	assert.equal(known?.window, "seven_day");
	assert.equal(known?.resetAt, NOW + 4 * 24 * 3600 * 1000);
});

test("only the unified reset, as on 9router 0.5.99: still read", () => {
	const known = readUnifiedReset(
		{
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
			"anthropic-ratelimit-unified-reset": String(NOW / 1000 + 3600),
			"anthropic-ratelimit-unified-status": "allowed",
		},
		NOW,
	);
	assert.equal(known?.window, "five_hour");
	assert.equal(known?.resetAt, NOW + 3600 * 1000);
});

test("header names are case-insensitive and milliseconds are accepted", () => {
	const known = readUnifiedReset({ "Anthropic-RateLimit-Unified-Reset": String(NOW + 600_000) }, NOW);
	assert.equal(known?.resetAt, NOW + 600_000);
	assert.equal(known?.window, "unified");
});

test("no headers, past resets, and nonsense are ignored", () => {
	assert.equal(readUnifiedReset(undefined, NOW), undefined);
	assert.equal(readUnifiedReset({}, NOW), undefined);
	assert.equal(readUnifiedReset({ "anthropic-ratelimit-unified-reset": String(NOW / 1000 - 60) }, NOW), undefined, "already past");
	assert.equal(readUnifiedReset({ "anthropic-ratelimit-unified-reset": "inf" }, NOW), undefined);
	assert.equal(readUnifiedReset({ "anthropic-ratelimit-unified-reset": String(NOW / 1000 + 90 * 24 * 3600) }, NOW), undefined, "too far");
});

test("the user's 9router error is recognised as a Claude subscription limit", () => {
	assert.equal(isClaudeGatewayLimit(USER_ERROR), true);
	assert.equal(isClaudeGatewayLimit("503: [glm/glm-5.3] [429]: Usage limit reached for 5 hour"), false);
	assert.equal(isClaudeGatewayLimit("Stream ended without finish_reason"), false);
});
