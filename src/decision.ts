/**
 * The decision: given the error that just ended a run, should this package
 * schedule a resume, report to the user, or stay out of the way?
 *
 * Only genuine rate-limit errors with a parseable reset hint are eligible.
 * Quota and billing errors are surfaced, never waited on.
 */

import type { AutoResumeConfig } from "./config.ts";
import { type ResetHint, parseResetHint } from "./reset-hint.ts";

export type ErrorKind = "rate-limit" | "quota" | "other";

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
 * Hard plan/account limits: waiting will not help, so these are reported.
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

export function classifyError(message: string | undefined): ErrorKind {
	if (!message || message.trim().length === 0) return "other";
	if (QUOTA_PATTERNS.some((pattern) => pattern.test(message))) return "quota";
	if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) return "rate-limit";
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
}

export type Decision =
	| { action: "schedule"; delayMs: number; hint: ResetHint; reason: string }
	| { action: "report"; reason: string; hint?: ResetHint }
	| { action: "ignore"; reason: string };

export function decideResume(input: DecisionInput): Decision {
	if (!input.config.enabled) return { action: "ignore", reason: "disabled" };

	const message = input.errorMessage?.trim();
	if (!message) return { action: "ignore", reason: "run ended without an error" };

	const hint = parseResetHint({ errorMessage: message, headers: input.headers, now: input.now });
	const kind = classifyError(message);

	if (kind === "quota") {
		return {
			action: "report",
			reason: "limit paket/kuota — menunggu tidak menolong",
			...(hint === undefined ? {} : { hint }),
		};
	}

	if (kind !== "rate-limit") return { action: "ignore", reason: "not a rate-limit error" };

	if (!hint) return { action: "report", reason: "rate limit tanpa info kapan reset" };

	const previous = input.lastScheduled;
	if (previous && input.awaitingOutcome && previous.errorText === message) {
		return { action: "report", reason: "lanjutan langsung gagal dengan error yang sama" };
	}
	if (previous && hint.delayMs > Math.max(previous.hintMs * 2, previous.hintMs + 5000)) {
		return {
			action: "report",
			reason: `hint reset makin jauh (${Math.round(previous.hintMs / 1000)}s → ${Math.round(hint.delayMs / 1000)}s)`,
			hint,
		};
	}
	if (input.config.maxWaitMs > 0 && hint.delayMs > input.config.maxWaitMs) {
		return { action: "report", reason: "reset lebih jauh dari batas tunggu", hint };
	}
	if (input.config.maxResumes > 0 && input.resumesDone >= input.config.maxResumes) {
		return { action: "report", reason: `sudah ${input.resumesDone} kali resume di sesi ini`, hint };
	}

	return { action: "schedule", delayMs: hint.delayMs, hint, reason: "rate limit dengan info reset" };
}
