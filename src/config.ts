/**
 * Configuration, read from its own file so nothing depends on Pi's settings
 * schema: `<agent dir>/auto-resume.json`. Unknown or malformed values fall back
 * to the defaults instead of failing.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_LANGUAGE, type Language, defaultPrompt, parseLanguage } from "./messages.ts";

export const CONFIG_FILE_NAME = "auto-resume.json";

export interface AutoResumeConfig {
	/** Master switch. */
	enabled: boolean;
	/** Notify when a resume is scheduled and when it is sent. */
	notify: boolean;
	/** Language of the continuation, notifications, and status text. */
	language: Language;
	/**
	 * Custom continuation text, sent after the marker header. Undefined means
	 * the built-in prompt for `language`.
	 */
	continuationPrompt?: string;
	/** Refuse to wait longer than this. 0 means wait as long as the hint says. */
	maxWaitMs: number;
	/** Give up after this many resumes in one session. 0 means no limit. */
	maxResumes: number;
	/** Extra delay on top of the reset hint, so the limit has certainly lifted. */
	slackMs: number;
	/**
	 * Pauses between retries of an error that carries no time ("Stream ended without finish_reason",
	 * a rate limit that says nothing about when). One entry per retry; after the last, it reports.
	 */
	backoffMs: number[];
	/** Offset from UTC, in hours, of times written without a zone. 8 = Beijing, where Z.ai/GLM writes them. */
	zonelessOffsetHours: number;
}

export const DEFAULT_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000];

/**
 * 0.1.0 wrote its Indonesian default into the file on `/auto-resume on|off`.
 * That text is treated as "not customized", so changing the language works.
 */
const LEGACY_DEFAULT_PROMPT = [
	"Percobaan sebelumnya terhenti karena rate limit.",
	"Lanjutkan dari langkah terakhir, dan jangan ulangi tool call yang sudah berhasil.",
].join("\n");

export const DEFAULT_CONFIG: AutoResumeConfig = {
	enabled: true,
	notify: true,
	language: DEFAULT_LANGUAGE,
	maxWaitMs: 0,
	maxResumes: 0,
	slackMs: 1500,
	backoffMs: [...DEFAULT_BACKOFF_MS],
	zonelessOffsetHours: 8,
};

export function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	return override && override.length > 0 ? override : join(homedir(), ".pi", "agent");
}

export function configFilePath(agentDirectory: string = agentDir()): string {
	return join(agentDirectory, CONFIG_FILE_NAME);
}

function defaults(): AutoResumeConfig {
	const config: AutoResumeConfig = { ...DEFAULT_CONFIG, backoffMs: [...DEFAULT_BACKOFF_MS] };
	const fromEnvironment = toBackoff(backoffFromEnvironment());
	if (fromEnvironment !== undefined) config.backoffMs = fromEnvironment;
	return config;
}

export function parseConfig(raw: string | undefined): AutoResumeConfig {
	if (!raw || raw.trim().length === 0) return defaults();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return defaults();
	}
	if (parsed === null || typeof parsed !== "object") return defaults();
	const record = parsed as Record<string, unknown>;

	const config: AutoResumeConfig = defaults();
	if (typeof record.enabled === "boolean") config.enabled = record.enabled;
	if (typeof record.notify === "boolean") config.notify = record.notify;
	const language = parseLanguage(record.language);
	if (language !== undefined) config.language = language;
	if (
		typeof record.continuationPrompt === "string" &&
		record.continuationPrompt.trim().length > 0 &&
		record.continuationPrompt.trim() !== LEGACY_DEFAULT_PROMPT
	) {
		config.continuationPrompt = record.continuationPrompt;
	}
	const maxWaitMs = toNonNegativeNumber(record.maxWaitMs);
	if (maxWaitMs !== undefined) config.maxWaitMs = maxWaitMs;
	const maxResumes = toNonNegativeNumber(record.maxResumes);
	if (maxResumes !== undefined) config.maxResumes = maxResumes;
	const slackMs = toNonNegativeNumber(record.slackMs);
	if (slackMs !== undefined) config.slackMs = slackMs;
	const backoff = toBackoff(record.backoffMs) ?? toBackoff(backoffFromEnvironment());
	if (backoff !== undefined) config.backoffMs = backoff;
	if (typeof record.zonelessOffsetHours === "number" && Number.isFinite(record.zonelessOffsetHours) && Math.abs(record.zonelessOffsetHours) <= 14) {
		config.zonelessOffsetHours = record.zonelessOffsetHours;
	}
	return config;
}

/** `PI_AUTO_RESUME_BACKOFF_MS=1500,2500` lets a test shorten the ladder without touching the config file. */
function backoffFromEnvironment(): unknown {
	const raw = process.env.PI_AUTO_RESUME_BACKOFF_MS?.trim();
	return raw ? raw.split(",").map((part) => Number(part.trim())) : undefined;
}

/** A non-empty list of positive delays; anything else is ignored. An empty list would disable retries, which `enabled: false` already does. */
function toBackoff(value: unknown): number[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > 20) return undefined;
	const steps = value.map((item) => (typeof item === "number" && Number.isFinite(item) && item > 0 ? Math.round(item) : Number.NaN));
	return steps.some(Number.isNaN) ? undefined : steps;
}

export function readConfig(path: string = configFilePath()): AutoResumeConfig {
	try {
		if (!existsSync(path)) return parseConfig(undefined);
		return parseConfig(readFileSync(path, "utf8"));
	} catch {
		return parseConfig(undefined);
	}
}

/** The text actually sent: the custom prompt, or the built-in one for the language. */
export function effectivePrompt(config: AutoResumeConfig): string {
	return config.continuationPrompt ?? defaultPrompt(config.language);
}

/** Write a config file, used by `/auto-resume on|off|language`. */
export function writeConfig(config: AutoResumeConfig, path: string = configFilePath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	// Only persist a prompt the user actually customized.
	const { continuationPrompt, ...rest } = config;
	const stored = continuationPrompt === undefined ? rest : { ...rest, continuationPrompt };
	writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`);
	renameSync(temporary, path);
}

function toNonNegativeNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.round(value);
}
