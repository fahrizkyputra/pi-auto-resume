/**
 * Every user-facing string, in English and Indonesian.
 *
 * The continuation is sent as an ordinary user message with a visible marker,
 * so the transcript shows that it was the package, not the human, who spoke.
 * The marker itself is not translated: it is how the transcript is searched.
 */

export const AUTO_RESUME_MARKER = "⚙ auto-resume";

export type Language = "en" | "id";
export const LANGUAGES: readonly Language[] = ["en", "id"];
export const DEFAULT_LANGUAGE: Language = "en";

const LANGUAGE_ALIASES: Record<string, Language> = {
	en: "en",
	eng: "en",
	english: "en",
	id: "id",
	ind: "id",
	indonesia: "id",
	indonesian: "id",
	bahasa: "id",
};

/** Accepts `en`, `id`, and spelled-out names; anything else is undefined. */
export function parseLanguage(value: unknown): Language | undefined {
	if (typeof value !== "string") return undefined;
	return LANGUAGE_ALIASES[value.trim().toLowerCase()];
}

/** Why the package decided not to resume. Rendered per language. */
export type GiveUpReason =
	| { code: "quota" }
	| { code: "no-hint" }
	| { code: "same-error" }
	| { code: "growing-hint"; fromSeconds: number; toSeconds: number }
	| { code: "max-wait" }
	| { code: "max-resumes"; count: number }
	| { code: "retries-exhausted"; attempts: number };

export type CancelReason = "typed" | "aborted" | "command";

interface Strings {
	languageName: string;
	defaultPrompt: string;
	continuationHeader(resetClock: string, waited: string): string;
	scheduleNotice(clock: string, countdown: string): string;
	windowNotice(clock: string, countdown: string): string;
	longWaitNotice(clock: string, countdown: string): string;
	backoffNotice(clock: string, countdown: string, attempt: number, total: number): string;
	resumeNotice(waited: string): string;
	giveUpNotice(reason: string, resetClock?: string): string;
	giveUpReason(reason: GiveUpReason): string;
	cancelNotice(reason: string): string;
	cancelReason(reason: CancelReason): string;
	status(clock: string, countdown: string): string;
	nothingPending: string;
	enabledNotice(enabled: boolean, path: string): string;
	languageNotice(path: string): string;
	unknownLanguage(value: string): string;
	statusEnabled(enabled: boolean): string;
	statusPending(time: string): string;
	statusNoPending: string;
	statusResumes(count: number): string;
	noLimit: string;
}

const STRINGS: Record<Language, Strings> = {
	en: {
		languageName: "English",
		defaultPrompt: [
			"The previous attempt stopped because of a rate limit.",
			"Continue from the last step, and do not repeat tool calls that already succeeded.",
		].join("\n"),
		continuationHeader: (resetClock, waited) => `${AUTO_RESUME_MARKER} (rate limit reset ${resetClock}, waited ${waited}):`,
		scheduleNotice: (clock, countdown) =>
			`Rate limit: resuming automatically at ${clock} (in ${countdown}). Type anything to cancel.`,
		windowNotice: (clock, countdown) =>
			`Usage limit: the plan window ends at ${clock} (in ${countdown}). Resuming automatically then. Type anything to cancel.`,
		longWaitNotice: (clock, countdown) =>
			`This is a long wait: resuming at ${clock} (in ${countdown}). Keep this Pi session open until then, or type anything to cancel and continue yourself.`,
		backoffNotice: (clock, countdown, attempt, total) =>
			`Temporary failure with no reset time: retry ${attempt} of ${total} at ${clock} (in ${countdown}). Type anything to cancel.`,
		resumeNotice: (waited) => `Rate limit: continuation sent after waiting ${waited}.`,
		giveUpNotice: (reason, resetClock) =>
			`Rate limit: not resuming automatically (${reason}).${
				resetClock === undefined ? "" : ` The limit resets at ${resetClock}.`
			} Type anything to continue yourself.`,
		giveUpReason: (reason) => {
			switch (reason.code) {
				case "quota":
					return "plan/quota limit — waiting will not help";
				case "no-hint":
					return "rate limit without a reset time";
				case "same-error":
					return "the resumed run failed with the same error";
				case "growing-hint":
					return `reset time is getting longer (${reason.fromSeconds}s → ${reason.toSeconds}s)`;
				case "max-wait":
					return "reset is beyond the maximum wait";
				case "max-resumes":
					return `already resumed ${reason.count} times in this session`;
				case "retries-exhausted":
					return `still failing after ${reason.attempts} automatic retries`;
			}
		},
		cancelNotice: (reason) => `Rate limit: automatic resume cancelled (${reason}).`,
		cancelReason: (reason) =>
			reason === "typed" ? "you typed" : reason === "aborted" ? "run aborted" : "requested via /auto-resume",
		status: (clock, countdown) => `⏳ limit: resuming ${clock} (${countdown})`,
		nothingPending: "No automatic resume is pending.",
		enabledNotice: (enabled, path) => `Auto-resume ${enabled ? "enabled" : "disabled"} (${path}).`,
		languageNotice: (path) => `Auto-resume language: English (${path}).`,
		unknownLanguage: (value) => `Unknown language "${value}". Use: /auto-resume language en|id`,
		statusEnabled: (enabled) => `enabled: ${enabled}`,
		statusPending: (time) => `resuming automatically at ${time}`,
		statusNoPending: "no resume pending",
		statusResumes: (count) => `resumes sent this session: ${count}`,
		noLimit: "0 = no limit",
	},
	id: {
		languageName: "Bahasa Indonesia",
		defaultPrompt: [
			"Percobaan sebelumnya terhenti karena rate limit.",
			"Lanjutkan dari langkah terakhir, dan jangan ulangi tool call yang sudah berhasil.",
		].join("\n"),
		continuationHeader: (resetClock, waited) =>
			`${AUTO_RESUME_MARKER} (rate limit reset ${resetClock}, menunggu ${waited}):`,
		scheduleNotice: (clock, countdown) =>
			`Rate limit: mencoba lanjut otomatis pukul ${clock} (${countdown} lagi). Ketik apa pun untuk membatalkan.`,
		windowNotice: (clock, countdown) =>
			`Limit pemakaian: jendela paket berakhir pukul ${clock} (${countdown} lagi). Lanjut otomatis saat itu. Ketik apa pun untuk membatalkan.`,
		longWaitNotice: (clock, countdown) =>
			`Tunggunya lama: lanjut pukul ${clock} (${countdown} lagi). Biarkan sesi Pi ini tetap terbuka sampai saat itu, atau ketik apa pun untuk membatalkan dan lanjut sendiri.`,
		backoffNotice: (clock, countdown, attempt, total) =>
			`Gangguan sementara tanpa info reset: coba ulang ke-${attempt} dari ${total} pukul ${clock} (${countdown} lagi). Ketik apa pun untuk membatalkan.`,
		resumeNotice: (waited) => `Rate limit: pesan lanjutan dikirim setelah menunggu ${waited}.`,
		giveUpNotice: (reason, resetClock) =>
			`Rate limit: tidak dilanjutkan otomatis (${reason}).${
				resetClock === undefined ? "" : ` Limit disebut reset pukul ${resetClock}.`
			} Ketik apa pun untuk melanjutkan sendiri.`,
		giveUpReason: (reason) => {
			switch (reason.code) {
				case "quota":
					return "limit paket/kuota — menunggu tidak menolong";
				case "no-hint":
					return "rate limit tanpa info kapan reset";
				case "same-error":
					return "lanjutan langsung gagal dengan error yang sama";
				case "growing-hint":
					return `waktu reset makin jauh (${reason.fromSeconds}s → ${reason.toSeconds}s)`;
				case "max-wait":
					return "reset lebih jauh dari batas tunggu";
				case "max-resumes":
					return `sudah ${reason.count} kali resume di sesi ini`;
				case "retries-exhausted":
					return `masih gagal setelah ${reason.attempts} kali coba ulang otomatis`;
			}
		},
		cancelNotice: (reason) => `Rate limit: jadwal lanjut otomatis dibatalkan (${reason}).`,
		cancelReason: (reason) =>
			reason === "typed" ? "kamu mengetik" : reason === "aborted" ? "run dibatalkan" : "diminta lewat /auto-resume",
		status: (clock, countdown) => `⏳ limit: lanjut ${clock} (${countdown})`,
		nothingPending: "Tidak ada jadwal lanjut otomatis yang menunggu.",
		enabledNotice: (enabled, path) => `Auto-resume ${enabled ? "aktif" : "nonaktif"} (${path}).`,
		languageNotice: (path) => `Bahasa auto-resume: Bahasa Indonesia (${path}).`,
		unknownLanguage: (value) => `Bahasa "${value}" tidak dikenal. Pakai: /auto-resume language en|id`,
		statusEnabled: (enabled) => `aktif: ${enabled}`,
		statusPending: (time) => `lanjut otomatis pukul ${time}`,
		statusNoPending: "tidak ada jadwal yang menunggu",
		statusResumes: (count) => `resume terkirim di sesi ini: ${count}`,
		noLimit: "0 = tanpa batas",
	},
};

export function strings(language: Language): Strings {
	return STRINGS[language];
}

export function defaultPrompt(language: Language): string {
	return STRINGS[language].defaultPrompt;
}

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

export interface ContinuationInput {
	language: Language;
	prompt: string;
	resetAt: number;
	waitedMs: number;
}

/** `⚙ auto-resume (rate limit reset 14:32, waited 12s):\n<prompt>` */
export function formatContinuation(input: ContinuationInput): string {
	const header = STRINGS[input.language].continuationHeader(formatClock(input.resetAt), formatCountdown(input.waitedMs));
	return `${header}\n${input.prompt}`;
}

export function formatScheduleNotice(language: Language, fireAt: number, now: number): string {
	return STRINGS[language].scheduleNotice(formatClock(fireAt), formatCountdown(fireAt - now));
}

/** Waits longer than this get one extra notice, so a multi-day wait is never a surprise. */
export const LONG_WAIT_MS = 6 * 60 * 60 * 1000;

export type ScheduleKind = "rate-limit-hint" | "window-reset" | "backoff";

export function formatScheduleNoticeFor(
	language: Language,
	kind: ScheduleKind,
	fireAt: number,
	now: number,
	attempt?: { number: number; total: number },
): string {
	const text = STRINGS[language];
	const clock = formatClock(fireAt);
	const countdown = formatCountdown(fireAt - now);
	if (kind === "backoff" && attempt) return text.backoffNotice(clock, countdown, attempt.number, attempt.total);
	if (kind === "window-reset") return text.windowNotice(clock, countdown);
	return text.scheduleNotice(clock, countdown);
}

export function formatLongWaitNotice(language: Language, fireAt: number, now: number): string {
	return STRINGS[language].longWaitNotice(formatClockWithDay(fireAt, now), formatCountdown(fireAt - now));
}

/** `18:30`, or `Fri 18:30` when it is not today, so a wait of days names its day. */
export function formatClockWithDay(timestamp: number, now: number): string {
	const date = new Date(timestamp);
	const sameDay = date.toDateString() === new Date(now).toDateString();
	if (sameDay) return formatClock(timestamp);
	const day = date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
	return `${day} ${formatClock(timestamp)}`;
}

export function formatResumeNotice(language: Language, waitedMs: number): string {
	return STRINGS[language].resumeNotice(formatCountdown(waitedMs));
}

export function formatGiveUpNotice(language: Language, reason: GiveUpReason, resetAt?: number): string {
	const text = STRINGS[language];
	return text.giveUpNotice(text.giveUpReason(reason), resetAt === undefined ? undefined : formatClock(resetAt));
}

export function formatCancelNotice(language: Language, reason: CancelReason): string {
	const text = STRINGS[language];
	return text.cancelNotice(text.cancelReason(reason));
}

export function statusText(language: Language, fireAt: number, now: number): string {
	return STRINGS[language].status(formatClock(fireAt), formatCountdown(fireAt - now));
}
