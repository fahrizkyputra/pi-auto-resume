import assert from "node:assert/strict";
import { test } from "node:test";
import { type AutoResumeConfig, DEFAULT_CONFIG } from "../src/config.ts";
import { AutoResumeController } from "../src/controller.ts";

const RATE_LIMIT_8S = "503: [429] rate_limit_error ... (reset after 8s)";

function createHarness(config: Partial<AutoResumeConfig> = {}) {
	let now = Date.parse("2026-03-11T10:00:00.000Z");
	const timers: { at: number; fire: () => void; cancelled: boolean }[] = [];
	const sent: string[] = [];
	const notices: { message: string; type?: string }[] = [];
	const statuses: (string | undefined)[] = [];

	const controller = new AutoResumeController({
		config: { ...DEFAULT_CONFIG, slackMs: 1000, ...config },
		now: () => now,
		setTimer: (delayMs, fire) => {
			const timer = { at: now + delayMs, fire, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		sendContinuation: (text) => sent.push(text),
		notify: (message, type) => notices.push({ message, type }),
		setStatus: (text) => statuses.push(text),
	});

	const advance = (ms: number) => {
		now += ms;
		for (const timer of timers) {
			if (!timer.cancelled && timer.at <= now) {
				timer.cancelled = true;
				timer.fire();
			}
		}
	};

	return { controller, advance, sent, notices, statuses, timers };
}

test("waits for the hint plus slack, then sends a marked continuation", () => {
	const { controller, advance, sent, notices, statuses } = createHarness();

	const decision = controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	assert.equal(decision.action, "schedule");
	assert.match(statuses.at(-1) ?? "", /^⏳ limit: resuming \d{2}:\d{2} \(9s\)$/);
	assert.match(notices.at(-1)?.message ?? "", /resuming automatically at/);

	advance(8000);
	assert.deepEqual(sent, [], "slack keeps it from firing at exactly the reset");

	advance(1000);
	assert.equal(sent.length, 1);
	assert.match(sent[0] ?? "", /^⚙ auto-resume \(rate limit reset \d{2}:\d{2}, waited 9s\):\n/);
	assert.match(sent[0] ?? "", /do not repeat tool calls that already succeeded/);
	assert.equal(statuses.at(-1), undefined, "status cleared after sending");
	assert.equal(controller.resumesSent(), 1);
});

test("cancel stops a pending resume", () => {
	const { controller, advance, sent, notices } = createHarness();
	controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });

	assert.equal(controller.cancel("typed"), true);
	assert.match(notices.at(-1)?.message ?? "", /cancelled \(you typed\)/);

	advance(60_000);
	assert.deepEqual(sent, []);
	assert.equal(controller.cancel("command"), false);
});

test("a resume that fails the same way again is reported, not repeated", () => {
	const { controller, advance, sent, notices } = createHarness();
	controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	advance(9000);
	assert.equal(sent.length, 1);

	const second = controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	assert.equal(second.action, "report");
	assert.match(notices.at(-1)?.message ?? "", /not resuming automatically \(the resumed run failed with the same error\)/);
	advance(60_000);
	assert.equal(sent.length, 1);
});

test("after a clean answer, the same limit later is handled again", () => {
	const { controller, advance, sent } = createHarness();
	controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	advance(9000);
	controller.noteNoError();

	assert.equal(controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S }).action, "schedule");
	advance(9000);
	assert.equal(sent.length, 2);
});

test("a growing reset hint stops the cycle", () => {
	const { controller, advance } = createHarness();
	controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	advance(9000);
	controller.noteNoError();

	const decision = controller.onAgentSettled({ errorMessage: "rate limit (reset after 20m)" });
	assert.equal(decision.action, "report");
});

test("a header hint recorded from the provider response is used", () => {
	const { controller } = createHarness();
	controller.onProviderResponse({ "retry-after": "30" });
	const decision = controller.onAgentSettled({ errorMessage: "429 Too Many Requests" });
	assert.equal(decision.action, "schedule");
	if (decision.action === "schedule") assert.equal(decision.delayMs, 30_000);
});

test("notify: false keeps it quiet but still resumes", () => {
	const { controller, advance, sent, notices } = createHarness({ notify: false });
	controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	advance(9000);
	assert.equal(sent.length, 1);
	assert.deepEqual(notices, []);
});

test("a new error while waiting replaces the old schedule", () => {
	const { controller, advance, sent, timers } = createHarness();
	controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	controller.onAgentSettled({ errorMessage: "rate limit (reset after 10s)" });
	assert.equal(timers.filter((timer) => !timer.cancelled).length, 1);
	advance(11_000);
	assert.equal(sent.length, 1);
});

test("language id switches every text the controller produces", () => {
	const { controller, advance, sent, notices, statuses } = createHarness({ language: "id" });

	controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	assert.match(statuses.at(-1) ?? "", /^⏳ limit: lanjut \d{2}:\d{2} \(9s\)$/);
	assert.match(notices.at(-1)?.message ?? "", /mencoba lanjut otomatis pukul/);

	advance(9000);
	assert.match(sent[0] ?? "", /^⚙ auto-resume \(rate limit reset \d{2}:\d{2}, menunggu 9s\):\n/);
	assert.match(sent[0] ?? "", /jangan ulangi tool call yang sudah berhasil/);
	assert.match(notices.at(-1)?.message ?? "", /pesan lanjutan dikirim setelah menunggu 9s/);

	controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	assert.match(notices.at(-1)?.message ?? "", /tidak dilanjutkan otomatis \(lanjutan langsung gagal dengan error yang sama\)/);
});

test("a custom prompt overrides the language default, header still follows the language", () => {
	const { controller, advance, sent } = createHarness({ language: "id", continuationPrompt: "Go on please." });
	controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	advance(9000);
	assert.match(sent[0] ?? "", /, menunggu 9s\):\nGo on please\.$/);
});
