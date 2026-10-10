/**
 * Configuration, read from its own file so nothing depends on Pi's settings
 * schema: `<agent dir>/auto-resume.json`. Unknown or malformed values fall back
 * to the defaults instead of failing.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_FILE_NAME = "auto-resume.json";

export interface AutoResumeConfig {
	/** Master switch. */
	enabled: boolean;
	/** Notify when a resume is scheduled and when it is sent. */
	notify: boolean;
	/** Sent verbatim after the marker prefix. */
	continuationPrompt: string;
	/** Refuse to wait longer than this. 0 means wait as long as the hint says. */
	maxWaitMs: number;
	/** Give up after this many resumes in one session. 0 means no limit. */
	maxResumes: number;
	/** Extra delay on top of the reset hint, so the limit has certainly lifted. */
	slackMs: number;
}

export const DEFAULT_CONTINUATION_PROMPT = [
	"Percobaan sebelumnya terhenti karena rate limit.",
	"Lanjutkan dari langkah terakhir, dan jangan ulangi tool call yang sudah berhasil.",
].join("\n");

export const DEFAULT_CONFIG: AutoResumeConfig = {
	enabled: true,
	notify: true,
	continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
	maxWaitMs: 0,
	maxResumes: 0,
	slackMs: 1500,
};

export function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	return override && override.length > 0 ? override : join(homedir(), ".pi", "agent");
}

export function configFilePath(agentDirectory: string = agentDir()): string {
	return join(agentDirectory, CONFIG_FILE_NAME);
}

export function parseConfig(raw: string | undefined): AutoResumeConfig {
	if (!raw || raw.trim().length === 0) return { ...DEFAULT_CONFIG };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
	if (parsed === null || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
	const record = parsed as Record<string, unknown>;

	const config: AutoResumeConfig = { ...DEFAULT_CONFIG };
	if (typeof record.enabled === "boolean") config.enabled = record.enabled;
	if (typeof record.notify === "boolean") config.notify = record.notify;
	if (typeof record.continuationPrompt === "string" && record.continuationPrompt.trim().length > 0) {
		config.continuationPrompt = record.continuationPrompt;
	}
	const maxWaitMs = toNonNegativeNumber(record.maxWaitMs);
	if (maxWaitMs !== undefined) config.maxWaitMs = maxWaitMs;
	const maxResumes = toNonNegativeNumber(record.maxResumes);
	if (maxResumes !== undefined) config.maxResumes = maxResumes;
	const slackMs = toNonNegativeNumber(record.slackMs);
	if (slackMs !== undefined) config.slackMs = slackMs;
	return config;
}

export function readConfig(path: string = configFilePath()): AutoResumeConfig {
	try {
		if (!existsSync(path)) return { ...DEFAULT_CONFIG };
		return parseConfig(readFileSync(path, "utf8"));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Write a config file, used by the package's own setup command. */
export function writeConfig(config: AutoResumeConfig, path: string = configFilePath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
	renameSync(temporary, path);
}

function toNonNegativeNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.round(value);
}
