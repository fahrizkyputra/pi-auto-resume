import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, configFilePath, effectivePrompt, parseConfig, readConfig, writeConfig } from "../src/config.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("defaults are unbounded, English, with no custom prompt", () => {
	assert.equal(DEFAULT_CONFIG.maxWaitMs, 0);
	assert.equal(DEFAULT_CONFIG.maxResumes, 0);
	assert.equal(DEFAULT_CONFIG.enabled, true);
	assert.equal(DEFAULT_CONFIG.language, "en");
	assert.equal(DEFAULT_CONFIG.continuationPrompt, undefined);
	assert.match(effectivePrompt(DEFAULT_CONFIG), /do not repeat tool calls that already succeeded/);
});

test("language picks the built-in prompt", () => {
	assert.match(effectivePrompt(parseConfig('{"language":"id"}')), /jangan ulangi tool call yang sudah berhasil/);
	assert.equal(parseConfig('{"language":"Indonesian"}').language, "id", "spelled-out names work");
	assert.equal(parseConfig('{"language":"english"}').language, "en");
	assert.equal(parseConfig('{"language":"fr"}').language, "en", "unknown languages fall back to English");
});

test("a custom prompt wins over the language default", () => {
	const config = parseConfig('{"language":"id","continuationPrompt":"Keep going."}');
	assert.equal(effectivePrompt(config), "Keep going.");
});

test("the Indonesian default that 0.1.0 wrote to disk is not treated as custom", () => {
	const legacy = JSON.stringify({
		enabled: true,
		continuationPrompt:
			"Percobaan sebelumnya terhenti karena rate limit.\nLanjutkan dari langkah terakhir, dan jangan ulangi tool call yang sudah berhasil.",
	});
	const config = parseConfig(legacy);
	assert.equal(config.continuationPrompt, undefined);
	assert.equal(config.language, "en");
	assert.match(effectivePrompt(config), /do not repeat tool calls/);
});

test("parseConfig merges valid fields and ignores bad ones", () => {
	const config = parseConfig(
		JSON.stringify({ enabled: false, maxWaitMs: 60000, maxResumes: -1, slackMs: "x", continuationPrompt: "  " }),
	);
	assert.equal(config.enabled, false);
	assert.equal(config.maxWaitMs, 60000);
	assert.equal(config.maxResumes, 0, "negative falls back to default");
	assert.equal(config.slackMs, DEFAULT_CONFIG.slackMs);
	assert.equal(config.continuationPrompt, undefined, "blank prompt falls back to the language default");
});

test("garbage and missing files give defaults", () => {
	assert.deepEqual(parseConfig("not json"), DEFAULT_CONFIG);
	assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG);
	assert.deepEqual(readConfig("/nonexistent/auto-resume.json"), DEFAULT_CONFIG);
});

test("write/read round trip in the agent directory", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-auto-resume-config-"));
	dirs.push(dir);
	const path = configFilePath(dir);
	assert.equal(path, join(dir, "auto-resume.json"));
	writeConfig({ ...DEFAULT_CONFIG, enabled: false, maxResumes: 2, language: "id" }, path);
	const config = readConfig(path);
	assert.equal(config.enabled, false);
	assert.equal(config.maxResumes, 2);
	assert.equal(config.language, "id");
	assert.equal("continuationPrompt" in JSON.parse(readFileSync(path, "utf8")), false, "default prompt is not written");
});
