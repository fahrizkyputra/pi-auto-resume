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
}

export interface ResetHintInput {
	errorMessage?: string;
	headers?: Record<string, string>;
	/** Milliseconds since epoch; defaults to Date.now(). */
	now?: number;
}

const MAX_SANE_DELAY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, guards against nonsense timestamps

export function parseResetHint(input: ResetHintInput): ResetHint | undefined {
	const now = input.now ?? Date.now();

	const fromHeader = parseHeaderHint(input.headers ?? {}, now);
	if (fromHeader) return fromHeader;

	return parseTextHint(input.errorMessage ?? "", now);
}

function parseHeaderHint(headers: Record<string, string>, now: number): ResetHint | undefined {
	const lookup = headerLookup(headers);

	const retryAfterMs = lookup("retry-after-ms");
	if (retryAfterMs !== undefined) {
		const ms = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(ms)) {
			const delayMs = sanitize(ms);
			if (delayMs !== undefined) return { delayMs, source: "header", raw: `retry-after-ms: ${retryAfterMs}` };
		}
	}

	const retryAfter = lookup("retry-after");
	if (retryAfter !== undefined) {
		const delayMs = parseRetryAfterValue(retryAfter, now);
		if (delayMs !== undefined) return { delayMs, source: "header", raw: `retry-after: ${retryAfter}` };
	}

	const resetAfter = lookup("x-ratelimit-reset-after");
	if (resetAfter !== undefined) {
		const seconds = Number.parseFloat(resetAfter);
		if (Number.isFinite(seconds)) {
			const delayMs = sanitize(seconds * 1000);
			if (delayMs !== undefined) return { delayMs, source: "header", raw: `x-ratelimit-reset-after: ${resetAfter}` };
		}
	}

	const resetAt = lookup("x-ratelimit-reset");
	if (resetAt !== undefined) {
		const delayMs = parseAbsoluteValue(resetAt, now);
		if (delayMs !== undefined) return { delayMs, source: "header", raw: `x-ratelimit-reset: ${resetAt}` };
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
	{ pattern: /reset(?:s)?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i, kind: "clock" },
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
		if (sanitized !== undefined) return { delayMs: sanitized, source: "text", raw: captured };
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
