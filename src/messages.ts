/**
 * Text formatting for the resume message and the status bar.
 *
 * The continuation is sent as an ordinary user message with a visible marker,
 * so the transcript shows that it was the package, not the human, who spoke.
 */

export const AUTO_RESUME_MARKER = "⚙ auto-resume";

export function formatClock(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatCountdown(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

export function formatWaited(ms: number): string {
	return formatCountdown(ms);
}

export interface ContinuationInput {
	prompt: string;
	resetAt: number;
	waitedMs: number;
	now: number;
}

/** `⚙ auto-resume (rate limit reset 14:32, menunggu 12s): <prompt>` */
export function formatContinuation(input: ContinuationInput): string {
	const resetText = formatClock(input.resetAt);
	const waitedText = formatWaited(input.waitedMs);
	return `${AUTO_RESUME_MARKER} (rate limit reset ${resetText}, menunggu ${waitedText}):\n${input.prompt}`;
}

export function formatScheduleNotice(fireAt: number, now: number): string {
	return `Rate limit: mencoba lanjut otomatis pukul ${formatClock(fireAt)} (${formatCountdown(fireAt - now)} lagi). Ketik apa pun untuk membatalkan.`;
}

export function formatResumeNotice(waitedMs: number): string {
	return `Rate limit: pesan lanjutan dikirim setelah menunggu ${formatWaited(waitedMs)}.`;
}

export function formatGiveUpNotice(reason: string, hintAt?: number): string {
	const when = hintAt === undefined ? "" : ` Limit disebut reset pukul ${formatClock(hintAt)}.`;
	return `Rate limit: tidak dilanjutkan otomatis (${reason}).${when} Ketik apa pun untuk melanjutkan sendiri.`;
}

export function statusText(fireAt: number, now: number): string {
	return `⏳ limit: lanjut ${formatClock(fireAt)} (${formatCountdown(fireAt - now)})`;
}
