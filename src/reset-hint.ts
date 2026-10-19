/**
 * Reset hints: when does the provider say the limit lifts?
 *
 * Two sources, header first: `retry-after`-style response headers, then the
 * error message text that proxies commonly append, for example
 * `...(reset after 8s)` or `Rate limit reached, try again in 2 minutes`.
 */

export interface ResetHint {
	delayMs: number;
	source: "header" | "text";
	raw: string;
	/**
	 * "retry" is a short pause the gateway asks for between attempts ("reset after 8s"); "window" is
	 * the moment a plan window (5 hours, a week) really ends. A window time wins when both appear.
	 */
	kind: "retry" | "window";
}

export interface ResetHintInput {
	errorMessage?: string;
	headers?: Record<string, string>;
	/** Milliseconds since epoch; defaults to Date.now(). */
	now?: number;
	/**
	 * Time zone offset, in hours from UTC, of timestamps written without a zone, such as
	 * `2026-08-12 17:11:22`. Default 8: Z.ai (GLM) writes Beijing time, which matched every
	 * error in the author's sessions (a UTC reading was impossible in all of them).
	 */
	zonelessOffsetHours?: number;
}

export const DEFAULT_ZONELESS_OFFSET_HOURS = 8;

/** A time written to the second is read as the end of that second. */
const WINDOW_ROUNDING_MS = 1000;

const MAX_SANE_DELAY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, guards against nonsense timestamps

export function parseResetHint(input: ResetHintInput): ResetHint | undefined {
	const now = input.now ?? Date.now();
	const message = input.errorMessage ?? "";

	// 1. The moment a plan window ends, written in the message, beats everything: the gateway's own
	//    "(reset after 2s)" next to it is only its retry pause, not when the limit lifts.
	const window = parseWindowReset(message, now, input.zonelessOffsetHours ?? DEFAULT_ZONELESS_OFFSET_HOURS);
	if (window) return window;

	const fromHeader = parseHeaderHint(input.headers ?? {}, now);
	if (fromHeader) return fromHeader;

	return parseTextHint(message, now);
}

/**
 * `Your limit will reset at 2026-08-12 17:11:22`, `Your limit resets at 2026-09-16T05:07:39.132Z`.
 * Absolute times only; a bare clock such as "resets 6pm" stays with the text patterns.
 */
function parseWindowReset(message: string, now: number, zonelessOffsetHours: number): ResetHint | undefined {
	if (message.trim().length === 0) return undefined;
	const match =
		/\b(?:limit\s+)?(?:will\s+)?resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2}|UTC|GMT)?/i.exec(message);
	if (!match) return undefined;
	const [, date, time, zone] = match;
	if (!date || !time) return undefined;
	const clock = time.length === 5 ? `${time}:00` : time;
	let at: number;
	if (zone === undefined) {
		const offset = Math.round(zonelessOffsetHours * 60);
		const sign = offset >= 0 ? "+" : "-";
		const abs = Math.abs(offset);
		const zoneText = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
		at = Date.parse(`${date}T${clock}${zoneText}`);
	} else if (/^(utc|gmt)$/i.test(zone)) {
		at = Date.parse(`${date}T${clock}Z`);
	} else {
		at = Date.parse(`${date}T${clock}${zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`);
	}
	if (!Number.isFinite(at)) return undefined;
	// The message states whole seconds, so the real end can be up to a second later: round up.
	const hasFraction = /\.\d+/.test(time);
	const delayMs = sanitize(at - now + (hasFraction ? 0 : WINDOW_ROUNDING_MS));
	if (delayMs === undefined) return undefined;
	return { delayMs, source: "text", raw: match[0].trim(), kind: "window" };
}

function parseHeaderHint(headers: Record<string, string>, now: number): ResetHint | undefined {
	const lookup = headerLookup(headers);

	const retryAfterMs = lookup("retry-after-ms");
	if (retryAfterMs !== undefined) {
		const ms = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(ms)) {
			const delayMs = sanitize(ms);
			if (delayMs !== undefined) return { delayMs, source: "header", raw: `retry-after-ms: ${retryAfterMs}`, kind: "retry" };
		}
	}

	const retryAfter = lookup("retry-after");
	if (retryAfter !== undefined) {
		const delayMs = parseRetryAfterValue(retryAfter, now);
		if (delayMs !== undefined) return { delayMs, source: "header", raw: `retry-after: ${retryAfter}`, kind: "retry" };
	}

	const resetAfter = lookup("x-ratelimit-reset-after");
	if (resetAfter !== undefined) {
		const seconds = Number.parseFloat(resetAfter);
		if (Number.isFinite(seconds)) {
			const delayMs = sanitize(seconds * 1000);
			if (delayMs !== undefined) return { delayMs, source: "header", raw: `x-ratelimit-reset-after: ${resetAfter}`, kind: "retry" };
		}
	}

	const resetAt = lookup("x-ratelimit-reset");
	if (resetAt !== undefined) {
		const delayMs = parseAbsoluteValue(resetAt, now);
		if (delayMs !== undefined) return { delayMs, source: "header", raw: `x-ratelimit-reset: ${resetAt}`, kind: "window" };
	}

	return undefined;
}

/** `retry-after` is either a number of seconds or an HTTP date. */
function parseRetryAfterValue(value: string, now: number): number | undefined {
	const trimmed = value.trim();
	const seconds = Number.parseFloat(trimmed);
	if (Number.isFinite(seconds) && /^[0-9.]+$/.test(trimmed)) {
		return sanitize(seconds * 1000);
	}
	const date = Date.parse(trimmed);
	if (Number.isFinite(date)) return sanitize(date - now);
	return undefined;
}

/** Unix seconds, unix milliseconds, ISO timestamp, or HTTP date. */
function parseAbsoluteValue(value: string, now: number): number | undefined {
	const trimmed = value.trim();
	const numeric = Number.parseFloat(trimmed);
	if (Number.isFinite(numeric) && /^[0-9]+$/.test(trimmed)) {
		const ms = trimmed.length >= 13 ? numeric : numeric * 1000;
		return sanitize(ms - now);
	}
	const date = Date.parse(trimmed);
	if (Number.isFinite(date)) return sanitize(date - now);
	return undefined;
}

const DURATION_PATTERN = /(\d+(?:[.,]\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])/i;
const UNIT_MS: Record<string, number> = {
	ms: 1,
	millisecond: 1,
	milliseconds: 1,
	s: 1000,
	sec: 1000,
	secs: 1000,
	second: 1000,
	seconds: 1000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

/** `2m`, `1h30m`, `30 seconds`, `1.5 hours`. */
export function parseDuration(text: string): number | undefined {
	const matches = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])/gi)];
	if (matches.length === 0) return undefined;

	let total = 0;
	let matched = false;
	for (const match of matches) {
		const amount = Number.parseFloat((match[1] ?? "").replace(",", "."));
		const unit = (match[2] ?? "").toLowerCase();
		if (!Number.isFinite(amount) || unit.length === 0) continue;
		const factor = UNIT_MS[unit] ?? UNIT_MS[unit.replace(/s$/, "")];
		if (factor === undefined) continue;
		total += amount * factor;
		matched = true;
	}
	return matched ? sanitize(total) : undefined;
}

const TEXT_PATTERNS: { pattern: RegExp; kind: "duration" | "clock" | "absolute" }[] = [
	{ pattern: /reset(?:s)?\s+after\s+([0-9.,]+\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)[a-z0-9.,\s]*)/i, kind: "duration" },
	{ pattern: /retry\s+after\s+([0-9.,]+\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)[a-z0-9.,\s]*)/i, kind: "duration" },
	{ pattern: /try\s+again\s+in\s+([0-9.,]+\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)[a-z0-9.,\s]*)/i, kind: "duration" },
	{ pattern: /reset(?:s)?\s+in\s+([0-9.,]+\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)[a-z0-9.,\s]*)/i, kind: "duration" },
	{ pattern: /reset(?:s)?\s+(?:at\s+)?([A-Za-z]{3},?\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*(?:GMT|UTC)?)/i, kind: "absolute" },
	{ pattern: /reset(?:s)?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i, kind: "absolute" },
	// A bare clock time ("resets 6pm", "resets at 18:00"). Never the start of a date: the lookahead
	// stops "2099-01-01" from being read as the hour "20".
	{ pattern: /reset(?:s)?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?![\d-])/i, kind: "clock" },
	{ pattern: /\bretry-after:\s*([0-9]+)/i, kind: "duration" },
];

function parseTextHint(errorMessage: string, now: number): ResetHint | undefined {
	if (errorMessage.trim().length === 0) return undefined;

	for (const { pattern, kind } of TEXT_PATTERNS) {
		const match = pattern.exec(errorMessage);
		const captured = match?.[1]?.trim();
		if (!captured) continue;

		let delayMs: number | undefined;
		if (kind === "duration") {
			const cleaned = captured.replace(DURATION_PATTERN, "$1$2").trim();
			delayMs = parseDuration(cleaned) ?? (/^\d+$/.test(cleaned) ? Number.parseInt(cleaned, 10) * 1000 : undefined);
		} else if (kind === "absolute") {
			const parsed = Date.parse(captured);
			if (Number.isFinite(parsed)) delayMs = parsed - now;
		} else {
			delayMs = parseClockDelay(captured, now);
		}

		const sanitized = delayMs === undefined ? undefined : sanitize(delayMs);
		if (sanitized !== undefined) return { delayMs: sanitized, source: "text", raw: captured, kind: kind === "duration" ? "retry" : "window" };
	}

	return undefined;
}

/** `18:00`, `6pm`, `18` → the next occurrence of that wall-clock time. */
function parseClockDelay(value: string, now: number): number | undefined {
	const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.trim());
	if (!match) return undefined;

	let hours = Number.parseInt(match[1] ?? "", 10);
	const minutes = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
	const meridiem = match[3]?.toLowerCase();
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;
	if (minutes > 59) return undefined;
	if (meridiem === "pm" && hours < 12) hours += 12;
	if (meridiem === "am" && hours === 12) hours = 0;
	if (meridiem === undefined && hours > 23) return undefined;

	const nowDate = new Date(now);
	const target = new Date(now);
	target.setHours(hours, minutes, 0, 0);
	if (target.getTime() <= now) target.setDate(target.getDate() + 1);
	void nowDate;
	return target.getTime() - now;
}

function sanitize(delayMs: number): number | undefined {
	if (!Number.isFinite(delayMs)) return undefined;
	if (delayMs < 0) return 0;
	if (delayMs > MAX_SANE_DELAY_MS) return undefined;
	return Math.round(delayMs);
}

function headerLookup(headers: Record<string, string>): (name: string) => string | undefined {
	const normalized = new Map<string, string>();
	for (const [key, value] of Object.entries(headers)) normalized.set(key.toLowerCase(), value);
	return (name: string) => normalized.get(name);
}
