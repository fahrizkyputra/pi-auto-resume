/**
 * One jcode session, watched over its own harness-API connection.
 *
 * jcode retries a rate limit by itself (up to 8 provider calls, then the TUI's
 * own few resends). When that budget is spent the turn ends with a
 * `turn_stopped` event that carries the provider's error text. That is the
 * moment the Pi extension handles with `agent_settled`: the same controller
 * decides, waits (a plan window by its real end), and sends the marked
 * continuation into the session.
 *
 * Event mapping:
 * - `turn_stopped` (not `interrupted`)  → onAgentSettled(error text)
 * - `turn_stopped` reason `interrupted` → cancel ("aborted"), silently
 * - a new turn starting while a resume waits (the user typed, or the TUI's own
 *   short retry) → the wait is dropped silently and that turn decides: if it
 *   stops on the limit again, a new wait is scheduled; if it finishes, nothing
 *   is owed. Our own continuation's turn does not count as a new turn.
 * - `turn_done` of a turn that did not stop → noteNoError()
 */

import { type AutoResumeConfig } from "../src/config.ts";
import { AutoResumeController } from "../src/controller.ts";
import type { Frame } from "./api.ts";

export interface WatcherDeps {
	sessionId: string;
	config: () => AutoResumeConfig;
	now: () => number;
	setTimer: (delayMs: number, fire: () => void) => () => void;
	send: (text: string) => void;
	notify: (message: string, type: "info" | "warning" | "error") => void;
	/** The watcher's pending state changed (for the status file). */
	onChange?: () => void;
}

const TURN_START = new Set(["connection_phase", "message_accepted"]);

export class SessionWatcher {
	readonly controller: AutoResumeController;
	private stoppedThisTurn = false;
	private turnActive = false;
	/** Our own continuation was just sent; the turn it starts is not a human typing. */
	private ownSendPending = false;

	private readonly deps: WatcherDeps;

	constructor(deps: WatcherDeps) {
		this.deps = deps;
		const self = this;
		this.controller = new AutoResumeController({
			get config() {
				return deps.config();
			},
			now: deps.now,
			setTimer: (delayMs, fire) =>
				deps.setTimer(delayMs, () => {
					fire();
					deps.onChange?.();
				}),
			sendContinuation: (text) => {
				self.ownSendPending = true;
				deps.send(text);
			},
			notify: (message, type) => deps.notify(message, type ?? "info"),
			setStatus: () => deps.onChange?.(),
		});
	}

	pendingFireAt(): number | undefined {
		return this.controller.pendingFireAt();
	}

	handle(frame: Frame): void {
		if (frame.session_id !== undefined && frame.session_id !== this.deps.sessionId) return;
		const ev = frame.ev ?? "";

		if (TURN_START.has(ev) || (ev === "session_status" && frame.status === "running")) {
			if (!this.turnActive) {
				this.turnActive = true;
				this.stoppedThisTurn = false;
				if (this.ownSendPending) this.ownSendPending = false;
				else if (this.controller.pendingFireAt() !== undefined) {
					this.controller.cancel("typed", { silent: true });
					this.deps.onChange?.();
				}
			}
			return;
		}

		if (ev === "turn_stopped") {
			this.stoppedThisTurn = true;
			this.turnActive = false;
			if (frame.reason === "interrupted") {
				this.controller.cancel("aborted", { silent: true });
				this.deps.onChange?.();
				return;
			}
			const message = typeof frame.message === "string" ? frame.message : undefined;
			this.controller.onAgentSettled(message === undefined ? {} : { errorMessage: message });
			this.deps.onChange?.();
			return;
		}

		if (ev === "turn_done") {
			if (!this.stoppedThisTurn) this.controller.noteNoError();
			this.turnActive = false;
			this.stoppedThisTurn = false;
		}
	}

	close(): void {
		this.controller.shutdown();
	}
}
