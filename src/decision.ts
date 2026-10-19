/**
 * The decision: given the error that just ended a run, should this package
 * schedule a resume, report to the user, or stay out of the way?
 *
 * - A rate limit with a reset time waits for it, and a plan window (5 hours, a week) with a real
 *   end time waits for that moment, however long.
 * - A rate limit without any time, and transient network/stream failures, are retried on a
 *   short backoff a few times, then reported.
 * - Money problems (empty balance, billing, subscription, model not in the plan) are reported:
 *   waiting does not fix them.
 */

import type { AutoResumeConfig } from "./config.ts";
import type { GiveUpReason } from "./messages.ts";
import { type ResetHint, parseResetHint } from "./reset-hint.ts";

export type ErrorKind = "rate-limit" | "quota" | "transient" | "other";

import { DEFAULT_BACKOFF_MS } from "./config.ts";

/** The default pauses between retries of an error that carries no time. Configurable as `backoffMs`. */
export const BACKOFF_MS: readonly number[] = DEFAULT_BACKOFF_MS;

/**
 * Same families Pi itself treats as retryable, so the package reacts to exactly
 * the errors the built-in retry also considered transient.
 */
const RATE_LIMIT_PATTERNS: RegExp[] = [
	/rate[_\s-]?limit/i,
	/rate[_\s-]?limited/i,
	/too many requests/i,
	/overloaded/i,
	/server_busy/i,
	/servers are currently busy/i,
	/currently experiencing high demand/i,
	/model is at capacity/i,
	/try again later/i,
	/try again in/i,
	/\b429\b/,
	/exceeded request buffer limit while retrying upstream/i,
];

/**
 * Money and plan problems: waiting will not help, so these are reported. A usage limit that
 * comes back with an end time (5-hour and weekly windows) is NOT here: see `isWindowLimit`.
 * Mirrors Pi's non-retryable limit patterns.
 */
const QUOTA_PATTERNS: RegExp[] = [
	/usage[\s_-]?limit/i,
	/quota/i,
	/out of budget/i,
	/available balance/i,
	/insufficient/i,
	/billing/i,
	/subscription/i,
	/credit balance/i,
	/monthly limit/i,
	/model_not_in_plan/i,
	/not in (?:your |the )?plan/i,
];

/**
 * Failures of the connection or the stream, not of the account: retrying shortly usually works.
 * `reset after Ns` can be attached to these by the gateway; it is only its own retry pause.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
	/stream ended without finish_reason/i,
	/stream stall/i,
	/^terminated$/i,
	/connection error/i,
	/connection lost/i,
	/upstream connection lost/i,
	/fetch failed/i,
	/fetch connect timeout/i,
	/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR_SOCKET|socket hang up|other side closed/i,
	/request timed out/i,
	/gateway request failed/i,
	/temporarily unavailable/i,
	/\b50[234]\b.*(?:bad gateway|service unavailable|gateway time-?out)/i,
];

/** Money, plan, or credential problems that a retry cannot fix, even when they say "rate limit". */
const HARD_PATTERNS: RegExp[] = [
	/available balance/i,
	/insufficient/i,
	/billing/i,
	/subscription/i,
	/credit balance/i,
	/out of budget/i,
	/model_not_in_plan/i,
	/not in (?:your |the )?plan/i,
	/monthly limit/i,
	/authentication_error|invalid[_\s-]?api[_\s-]?key|oauth access token has expired/i,
];

/**
 * A plan window that names the moment it ends: "Usage limit reached for 5 hour. Your limit will
 * reset at <date time>", or "weekly usage limit ... resets at <time>". Only hour, day, and week
 * windows count. A monthly limit, a billing cycle, and an empty balance do not: they are a
 * decision for the user, not something to wait out. A gateway's "reset after 8s" is not a window.
 */
export function isWindowLimit(message: string, hint: ResetHint | undefined): boolean {
	if (hint?.kind !== "window") return false;
	if (/monthly|per month|billing|balance|credit|subscription|quota/i.test(message)) return false;
	return /\b\d+[\s-]?hours?\b|\b(?:5|five)[\s-]?h(?:ou)?r\b|weekly|\bweek\b|daily|\bper day\b|rate[_\s-]?limit/i.test(message);
}

export function classifyError(message: string | undefined): ErrorKind {
	if (!message || message.trim().length === 0) return "other";
	if (HARD_PATTERNS.some((pattern) => pattern.test(message))) return "quota";
	if (QUOTA_PATTERNS.some((pattern) => pattern.test(message))) return "quota";
	if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) return "rate-limit";
	if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return "transient";
	return "other";
}

export interface LastScheduled {
	errorText: string;
	hintMs: number;
}

export interface DecisionInput {
	errorMessage?: string;
	headers?: Record<string, string>;
	now: number;
	config: AutoResumeConfig;
	/** The previous schedule, for the "waiting did not help" check. */
	lastScheduled?: LastScheduled;
	/** True while the run that followed our resume has not produced a clean answer yet. */
	awaitingOutcome: boolean;
	/** How many resumes were already sent in this session. */
	resumesDone: number;
	/** Retries in a row of errors that carry no time; reset by a run that ends cleanly. */
	backoffAttempts?: number;
}

export type ScheduleReason = "rate-limit-hint" | "window-reset" | "backoff";

export type Decision =
	| { action: "schedule"; delayMs: number; hint: ResetHint; reason: ScheduleReason; attempt?: number; attempts?: number }
	| { action: "report"; reason: GiveUpReason; hint?: ResetHint }
	| { action: "ignore"; reason: string };

export function decideResume(input: DecisionInput): Decision {
	if (!input.config.enabled) return { action: "ignore", reason: "disabled" };

	const message = input.errorMessage?.trim();
	if (!message) return { action: "ignore", reason: "run ended without an error" };

	const hint = parseResetHint({
		errorMessage: message,
		headers: input.headers,
		now: input.now,
		zonelessOffsetHours: input.config.zonelessOffsetHours,
	});
	const kind = classifyError(message);
	const window = isWindowLimit(message, hint);

	// Money and plan problems never get better by waiting. A usage limit with a real end time is
	// different: the plan window does end.
	if (kind === "quota" && !window) {
		return { action: "report", reason: { code: "quota" }, ...(hint === undefined ? {} : { hint }) };
	}

	if (kind === "other") return { action: "ignore", reason: "not a rate-limit error" };

	const previous = input.lastScheduled;
	// A resume that fails the same way at once is a loop. It does not apply to a transient failure
	// or a no-time rate limit: the same error again is exactly what the backoff ladder is for, and
	// its own step count ends it.
	const hasTime = hint !== undefined && (kind === "rate-limit" || window);
	if (hasTime && previous && input.awaitingOutcome && previous.errorText === message) {
		return { action: "report", reason: { code: "same-error" } };
	}

	// An error that carries a time to wait: use it. For a plan window it is the real end of the
	// window; for a rate limit it is the gateway's own pause. A transient failure ignores the
	// gateway's pause (it is not a limit) and backs off on its own schedule below.
	if (hasTime && hint) {
		if (!window && previous && hint.delayMs > Math.max(previous.hintMs * 2, previous.hintMs + 5000)) {
			return {
				action: "report",
				reason: { code: "growing-hint", fromSeconds: Math.round(previous.hintMs / 1000), toSeconds: Math.round(hint.delayMs / 1000) },
				hint,
			};
		}
		if (input.config.maxWaitMs > 0 && hint.delayMs > input.config.maxWaitMs) {
			return { action: "report", reason: { code: "max-wait" }, hint };
		}
		if (input.config.maxResumes > 0 && input.resumesDone >= input.config.maxResumes) {
			return { action: "report", reason: { code: "max-resumes", count: input.resumesDone }, hint };
		}
		return { action: "schedule", delayMs: hint.delayMs, hint, reason: window ? "window-reset" : "rate-limit-hint" };
	}

	// No usable time: a transient failure, or a rate limit that says nothing about when. Retry
	// on a short, growing pause a few times, then hand it back to the user.
	const ladder = input.config.backoffMs.length > 0 ? input.config.backoffMs : BACKOFF_MS;
	const attempts = input.backoffAttempts ?? 0;
	if (attempts >= ladder.length) {
		return { action: "report", reason: { code: "retries-exhausted", attempts }, ...(hint === undefined ? {} : { hint }) };
	}
	if (input.config.maxResumes > 0 && input.resumesDone >= input.config.maxResumes) {
		return { action: "report", reason: { code: "max-resumes", count: input.resumesDone } };
	}
	const delayMs = ladder[attempts] ?? ladder[ladder.length - 1] ?? 30_000;
	const synthetic: ResetHint = { delayMs, source: "text", raw: `no reset time; retry ${attempts + 1} of ${ladder.length}`, kind: "retry" };
	return { action: "schedule", delayMs, hint: synthetic, reason: "backoff", attempt: attempts + 1, attempts: ladder.length };
}
