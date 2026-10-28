/**
 * Wall-clock timer shared by the Pi extension and the jcode daemon.
 */

/** How often a long wait re-checks the wall clock. Short enough that a sleeping laptop wakes up on time. */
export const WALL_CLOCK_TICK_MS = 15_000;

/**
 * A timer that fires at a wall-clock moment, not after a duration of timer time.
 *
 * Node timers run on a monotonic clock that stops while the machine sleeps, and a delay above
 * 24.8 days fires at once. A wait of hours or days (a 5-hour window, a weekly limit) needs
 * neither: this re-checks `Date.now()` every few seconds, so it fires on time after a sleep and
 * has no upper bound. `now` and the scheduler are injectable for tests.
 */
export function wallClockTimer(
	delayMs: number,
	fire: () => void,
	now: () => number = Date.now,
	schedule: (callback: () => void, ms: number) => { cancel: () => void } = (callback, ms) => {
		const handle = setTimeout(callback, ms);
		(handle as { unref?: () => void }).unref?.();
		return { cancel: () => clearTimeout(handle) };
	},
): () => void {
	const target = now() + delayMs;
	let cancelled = false;
	let current: { cancel: () => void } | undefined;
	const step = () => {
		if (cancelled) return;
		const remaining = target - now();
		if (remaining <= 0) {
			fire();
			return;
		}
		current = schedule(step, Math.min(remaining, WALL_CLOCK_TICK_MS));
	};
	step();
	return () => {
		cancelled = true;
		current?.cancel();
	};
}
