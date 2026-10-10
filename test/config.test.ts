import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEFAULT_CONFIG, configFilePath, parseConfig, readConfig, writeConfig } from "../src/config.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("defaults are unbounded with the agreed prompt", () => {
	assert.equal(DEFAULT_CONFIG.maxWaitMs, 0);
	assert.equal(DEFAULT_CONFIG.maxResumes, 0);
	assert.equal(DEFAULT_CONFIG.enabled, true);
	assert.match(DEFAULT_CONFIG.continuationPrompt, /jangan ulangi tool call yang sudah berhasil/);
});

test("parseConfig merges valid fields and ignores bad ones", () => {
	const config = parseConfig(
		JSON.stringify({ enabled: false, maxWaitMs: 60000, maxResumes: -1, slackMs: "x", continuationPrompt: "  " }),
	);
	assert.equal(config.enabled, false);
	assert.equal(config.maxWaitMs, 60000);
	assert.equal(config.maxResumes, 0, "negative falls back to default");
	assert.equal(config.slackMs, DEFAULT_CONFIG.slackMs);
	assert.equal(config.continuationPrompt, DEFAULT_CONFIG.continuationPrompt, "blank prompt falls back");
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
	writeConfig({ ...DEFAULT_CONFIG, enabled: false, maxResumes: 2 }, path);
	const config = readConfig(path);
	assert.equal(config.enabled, false);
	assert.equal(config.maxResumes, 2);
});
