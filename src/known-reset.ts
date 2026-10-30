/**
 * The plan window's real reset time, learned from successful responses.
 *
 * Why: when a Claude subscription behind 9router hits its limit, the reset time only travels in
 * response headers (`anthropic-ratelimit-unified-reset`), and Pi does not pass the headers of a
 * failed request to extensions. The error text only carries 9router's own lock ("reset after 9s"),
 * which grows 2 s, 4 s, 8 s … up to 5 minutes and says nothing about when the window ends.
 *
 * Successful responses do carry those headers, every time. So the reset of the window that is
 * filling up is already known before the limit hits: remember it, and use it when the limit comes.
 */

export type WindowName = "five_hour" | "seven_day" | "unified";

export interface KnownReset {
	/** Epoch milliseconds when the window that was closest to holding resets. */
	resetAt: number;
	/** Which window: `representative-claim` from the headers, or "unified" when not stated. */
	window: WindowName;
	/** When this was learned. */
	seenAt: number;
	/** Fraction used (0..1) of that window, when the provider says so. */
	utilization?: number;
}

const HEADER = "anthropic-ratelimit-unified-";

function lookup(headers: Record<string, string>): (name: string) => string | undefined {
	const map = new Map<string, string>();
	for (const [key, value] of Object.entries(headers)) map.set(key.toLowerCase(), value);
	return (name) => map.get(name.toLowerCase());
}

/** Unix seconds (or milliseconds) in a header, as epoch milliseconds; undefined when absent or nonsense. */
function epochMs(value: string | undefined, now: number): number | undefined {
	if (value === undefined) return undefined;
	const number = Number(value.trim());
	if (!Number.isFinite(number) || number <= 0) return undefined;
	const ms = number >= 1e12 ? number : number * 1000;
	// A reset in the past or more than 30 days out is not a window reset.
	if (ms <= now || ms > now + 30 * 24 * 3600 * 1000) return undefined;
	return ms;
}

function fraction(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const number = Number(value.trim());
	return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/**
 * Read Anthropic's unified rate-limit headers (as forwarded by 9router) from any response.
 * Picks the window that is closest to holding: the `representative-claim`, else the unified reset.
 */
export function readUnifiedReset(headers: Record<string, string> | undefined, now: number): KnownReset | undefined {
	if (!headers) return undefined;
	const get = lookup(headers);
	const claim = get(`${HEADER}representative-claim`)?.trim().toLowerCase();
	const perWindow: Record<"five_hour" | "seven_day", { reset?: number; utilization?: number }> = {
		five_hour: { reset: epochMs(get(`${HEADER}5h-reset`), now), utilization: fraction(get(`${HEADER}5h-utilization`)) },
		seven_day: { reset: epochMs(get(`${HEADER}7d-reset`), now), utilization: fraction(get(`${HEADER}7d-utilization`)) },
	};
	const unified = epochMs(get(`${HEADER}reset`), now);

	if (claim === "five_hour" || claim === "seven_day") {
		const window = perWindow[claim];
		const resetAt = window.reset ?? unified;
		if (resetAt !== undefined) {
			return { resetAt, window: claim, seenAt: now, ...(window.utilization === undefined ? {} : { utilization: window.utilization }) };
		}
	}
	if (unified !== undefined) return { resetAt: unified, window: "unified", seenAt: now };
	const five = perWindow.five_hour;
	if (five.reset !== undefined) return { resetAt: five.reset, window: "five_hour", seenAt: now, ...(five.utilization === undefined ? {} : { utilization: five.utilization }) };
	return undefined;
}

/** Errors that come from a Claude subscription through 9router: `[claude/…]` or a `cc/…` model. */
export function isClaudeGatewayLimit(message: string): boolean {
	return /\[claude\/[^\]]+\]\s*\[429\]/i.test(message) || (/\bcc\/claude/i.test(message) && /rate[_\s-]?limit/i.test(message));
}

/**
 * 9router's own lock, in the error text: "(reset after 9s)". It grows on its own while the account
 * stays limited, so it is not a sign that the limit is getting worse.
 */
export function isGatewayLockHint(raw: string | undefined): boolean {
	return raw !== undefined && /^[0-9.,\s]*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/i.test(raw.trim());
}
