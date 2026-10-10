/**
 * The heart of the package: holds the pending schedule, applies the loop
 * guards, and drives the injected timer/notify/send operations.
 *
 * Everything it touches is injected, so the whole decide → wait → resume path
 * is testable with a fake clock and no Pi process.
 */

import { type AutoResumeConfig, effectivePrompt } from "./config.ts";
import { type Decision, type LastScheduled, decideResume } from "./decision.ts";
import {
	type CancelReason,
	formatCancelNotice,
	formatContinuation,
	formatGiveUpNotice,
	formatResumeNotice,
	formatScheduleNotice,
	statusText,
} from "./messages.ts";
import type { ResetHint } from "./reset-hint.ts";

export interface AutoResumeDeps {
	config: AutoResumeConfig;
	now(): number;
	/** Start a timer; returns a function that cancels it. */
	setTimer(delayMs: number, fire: () => void): () => void;
	/** Send the continuation as a marked user message. */
	sendContinuation(text: string): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(text: string | undefined): void;
}

interface PendingSchedule {
	fireAt: number;
	delayMs: number;
	hint: ResetHint;
	errorText: string;
	cancel: () => void;
}

export interface SettleInput {
	errorMessage?: string;
	headers?: Record<string, string>;
}

export class AutoResumeController {
	private deps: AutoResumeDeps;
	private pending: PendingSchedule | undefined;
	private lastScheduled: LastScheduled | undefined;
	private resumesDone = 0;
	private awaitingOutcome = false;
	private lastHeaders: Record<string, string> | undefined;

	constructor(deps: AutoResumeDeps) {
		this.deps = deps;
	}

	/** Response metadata from the provider layer, used for `retry-after`. */
	onProviderResponse(headers: Record<string, string> | undefined): void {
		this.lastHeaders = headers;
	}

	/** The provider response that followed: clear the header hint again. */
	noteNoError(): void {
		this.awaitingOutcome = false;
	}

	/** Called when the agent stopped and nothing else will continue it. */
	onAgentSettled(input: SettleInput = {}): Decision {
		const now = this.deps.now();
		const headers = input.headers ?? this.lastHeaders;
		const decision = decideResume({
			...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
			...(headers === undefined ? {} : { headers }),
			now,
			config: this.deps.config,
			...(this.lastScheduled === undefined ? {} : { lastScheduled: this.lastScheduled }),
			awaitingOutcome: this.awaitingOutcome,
			resumesDone: this.resumesDone,
		});

		if (decision.action === "ignore") return decision;

		if (decision.action === "report") {
			this.cancelPending();
			const hintAt =
				decision.hint === undefined ? undefined : now + decision.hint.delayMs;
			if (this.deps.config.notify) {
				this.deps.notify(formatGiveUpNotice(this.deps.config.language, decision.reason, hintAt), "warning");
			}
			this.deps.setStatus(undefined);
			return decision;
		}

		// A newer error replaces any schedule still waiting: the last decision wins.
		this.cancelPending();
		this.schedule(decision.delayMs, decision.hint, input.errorMessage ?? "", now);
		return decision;
	}

	/** Cancel on human input, abort, session switch, or shutdown. */
	cancel(reason: CancelReason, options: { silent?: boolean } = {}): boolean {
		const had = this.cancelPending();
		if (had && !options.silent && this.deps.config.notify) {
			this.deps.notify(formatCancelNotice(this.deps.config.language, reason), "info");
		}
		return had;
	}

	shutdown(): void {
		this.cancelPending();
	}

	status(): string | undefined {
		if (!this.pending) return undefined;
		return statusText(this.deps.config.language, this.pending.fireAt, this.deps.now());
	}

	refreshStatus(): void {
		this.deps.setStatus(this.status());
	}

	pendingFireAt(): number | undefined {
		return this.pending?.fireAt;
	}

	resumesSent(): number {
		return this.resumesDone;
	}

	private schedule(delayMs: number, hint: ResetHint, errorText: string, now: number): void {
		const slack = this.deps.config.slackMs;
		const totalDelay = delayMs + slack;
		const fireAt = now + totalDelay;
		const cancel = this.deps.setTimer(totalDelay, () => this.fire());
		this.pending = { fireAt, delayMs: totalDelay, hint, errorText, cancel };
		this.refreshStatus();
		if (this.deps.config.notify) {
			this.deps.notify(formatScheduleNotice(this.deps.config.language, fireAt, now), "info");
		}
	}

	private fire(): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;

		const now = this.deps.now();
		const waitedMs = pending.delayMs;
		this.resumesDone++;
		this.awaitingOutcome = true;
		this.lastScheduled = { errorText: pending.errorText, hintMs: pending.hint.delayMs };
		this.deps.setStatus(undefined);

		const config = this.deps.config;
		this.deps.sendContinuation(
			formatContinuation({ language: config.language, prompt: effectivePrompt(config), resetAt: now, waitedMs }),
		);
		if (config.notify) {
			this.deps.notify(formatResumeNotice(config.language, waitedMs), "info");
		}
	}

	private cancelPending(): boolean {
		if (!this.pending) return false;
		this.pending.cancel();
		this.pending = undefined;
		this.deps.setStatus(undefined);
		return true;
	}
}
