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

// ---- the new ways to decide: plan windows, backoff, long waits ---------------------------------------------

const GLM_5H = "429: Usage limit reached for 5 hour. Your limit will reset at 2026-03-11 19:26:43 (reset after 2s)";
const WEEKLY = "429: You've reached your weekly usage limit for your plan. Your limit resets at 2026-03-16T05:07:39.132Z. Please wait";
const NETWORK = "Stream ended without finish_reason";

test("a 5-hour window waits for its real end, not the gateway's 2 seconds, and says so", () => {
	const { controller, advance, sent, notices, statuses } = createHarness();
	const decision = controller.onAgentSettled({ errorMessage: GLM_5H });
	assert.equal(decision.action, "schedule");
	if (decision.action === "schedule") assert.equal(decision.reason, "window-reset");
	assert.match(notices.at(-1)?.message ?? "", /Usage limit: the plan window ends at \d{2}:\d{2} \(in 1h 26m\)/);
	assert.match(statuses.at(-1) ?? "", /^⏳ limit: resuming \d{2}:\d{2} \(1h 26m\)$/);

	advance(2000);
	assert.deepEqual(sent, [], "not after the gateway's 2 seconds");
	advance(3_600_000 + 26 * 60_000 + 44_000);
	assert.equal(sent.length, 1, "after the window really ends");
});

test("a weekly limit schedules days ahead, with one extra notice naming the day", () => {
	const { controller, notices } = createHarness();
	const decision = controller.onAgentSettled({ errorMessage: WEEKLY });
	assert.equal(decision.action, "schedule");
	const warnings = notices.filter((notice) => notice.type === "warning");
	assert.equal(warnings.length, 1, "exactly one long-wait notice");
	assert.match(warnings[0]?.message ?? "", /long wait: resuming at \w{3}, \d+ \w{3} \d{2}:\d{2} \(in 4d|5d|115h|4d 19h/);
	assert.match(warnings[0]?.message ?? "", /Keep this Pi session open/);
});

test("a short rate limit gets no long-wait notice", () => {
	const { controller, notices } = createHarness();
	controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	assert.equal(notices.filter((notice) => notice.type === "warning").length, 0);
});

test("a failure with no time retries 30s, 1m, 2m, 5m, then reports", () => {
	const { controller, advance, sent, notices } = createHarness();
	const waits = [30_000, 60_000, 120_000, 300_000];
	for (let attempt = 0; attempt < waits.length; attempt++) {
		const decision = controller.onAgentSettled({ errorMessage: NETWORK });
		assert.equal(decision.action, "schedule", `attempt ${attempt + 1}`);
		if (decision.action === "schedule") assert.equal(decision.reason, "backoff");
		assert.match(notices.at(-1)?.message ?? "", new RegExp(`retry ${attempt + 1} of 4`));
		advance(waits[attempt]! + 1000);
		assert.equal(sent.length, attempt + 1);
	}
	const last = controller.onAgentSettled({ errorMessage: NETWORK });
	assert.equal(last.action, "report");
	assert.match(notices.at(-1)?.message ?? "", /still failing after 4 automatic retries/);
	assert.equal(sent.length, 4, "no fifth retry");
});

test("a clean run resets the retry count", () => {
	const { controller, advance } = createHarness();
	for (let attempt = 0; attempt < 3; attempt++) {
		controller.onAgentSettled({ errorMessage: NETWORK });
		advance(400_000);
	}
	controller.noteNoError();
	const decision = controller.onAgentSettled({ errorMessage: NETWORK });
	assert.equal(decision.action, "schedule");
	if (decision.action === "schedule") assert.equal(decision.delayMs, 30_000, "back to the first step");
});

test("the same transient error again climbs the ladder; the same rate limit again is a loop and stops", () => {
	const transient = createHarness();
	transient.controller.onAgentSettled({ errorMessage: NETWORK });
	transient.advance(31_000);
	const climbs = transient.controller.onAgentSettled({ errorMessage: NETWORK });
	assert.equal(climbs.action, "schedule", "step 2 of the ladder, not a loop");

	const limited = createHarness();
	limited.controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	limited.advance(9000);
	const stops = limited.controller.onAgentSettled({ errorMessage: RATE_LIMIT_8S });
	assert.equal(stops.action === "report" && stops.reason.code === "same-error", true, "a limit that did not lift is reported");
});

test("Esc and typing cancel a long wait just like a short one", () => {
	const { controller, advance, sent } = createHarness();
	controller.onAgentSettled({ errorMessage: WEEKLY });
	assert.equal(controller.cancel("typed"), true);
	advance(10 * 24 * 3_600_000);
	assert.deepEqual(sent, []);
});

test("money problems are still only reported", () => {
	const { controller, sent, notices } = createHarness();
	const decision = controller.onAgentSettled({ errorMessage: "Insufficient Balance (request_id: x)" });
	assert.equal(decision.action, "report");
	assert.match(notices.at(-1)?.message ?? "", /plan\/quota limit/);
	assert.deepEqual(sent, []);
});

// ---- Claude subscription behind 9router: the real reset comes from successful responses -------------

const NINE = (s: string) =>
	`503: {"message":"[claude/claude-opus-5-5] [429]: {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"rate_limit_error\\",\\"message\\":\\"This request would exceed your account's rate limit. Please try again later.\\"},\\"request_id\\":\\"req_X\\"} (reset after ${s})"}`;

test("REGRESSION 27 Oct: 9router's growing lock (16s, 18s, 58s) never makes it give up", () => {
	const { controller, advance, sent, notices } = createHarness();
	for (const seconds of ["16s", "18s", "58s", "1m 4s", "2m 8s", "5m"]) {
		const decision = controller.onAgentSettled({ errorMessage: NINE(seconds) });
		assert.equal(decision.action, "schedule", `after (reset after ${seconds})`);
		advance(10 * 60_000);
	}
	assert.ok(sent.length >= 6);
	assert.ok(!notices.some((notice) => /getting longer|makin jauh/.test(notice.message)), "no 'growing hint' give-up");
});

test("a reset learned from a successful response is used when the limit comes", () => {
	const { controller, advance, sent, notices } = createHarness();
	const now = Date.parse("2026-03-11T10:00:00.000Z");
	// Earlier, a successful response: the 5-hour window resets in 2 hours.
	controller.onProviderResponse(
		{
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
			"anthropic-ratelimit-unified-reset": String(now / 1000 + 2 * 3600),
			"anthropic-ratelimit-unified-status": "allowed",
		},
		200,
	);
	controller.noteNoError();
	const decision = controller.onAgentSettled({ errorMessage: NINE("9s") });
	assert.equal(decision.action, "schedule");
	if (decision.action === "schedule") {
		assert.equal(decision.reason, "window-reset");
		assert.equal(decision.delayMs, 2 * 3600 * 1000, "the window's real reset, not 9 seconds");
	}
	assert.match(notices.at(-1)?.message ?? notices.at(-2)?.message ?? "", /plan window ends/);
	advance(9_000 + 1000);
	assert.deepEqual(sent, [], "not after 9 seconds");
	advance(2 * 3600 * 1000);
	assert.equal(sent.length, 1);
});

test("a learned reset that already passed is not reused; it probes instead", () => {
	const { controller, advance } = createHarness();
	const now = Date.parse("2026-03-11T10:00:00.000Z");
	controller.onProviderResponse({ "anthropic-ratelimit-unified-reset": String(now / 1000 + 60) }, 200);
	// Two hours go by without another response: the stored reset is in the past now.
	advance(2 * 3600 * 1000);
	const decision = controller.onAgentSettled({ errorMessage: NINE("9s") });
	assert.equal(decision.action, "schedule");
	if (decision.action === "schedule") assert.equal(decision.reason, "probe");
});

test("with no known reset, a Claude limit probes every 5 minutes, without a retry cap", () => {
	const { controller, advance, sent } = createHarness();
	const waits: number[] = [];
	// 9router's lock doubles 2 s, 4 s … and stops at 5 minutes; past that it repeats "5m".
	const lock = (probe: number) => (2 ** (probe + 1) >= 300 ? "5m" : `${2 ** (probe + 1)}s`);
	for (let probe = 0; probe < 12; probe++) {
		const decision = controller.onAgentSettled({ errorMessage: NINE(lock(probe)) });
		assert.equal(decision.action, "schedule", `probe ${probe + 1}`);
		if (decision.action === "schedule") waits.push(decision.delayMs);
		advance(decision.action === "schedule" ? decision.delayMs + 2000 : 0);
	}
	assert.equal(sent.length, 12, "an hour of probing, never reported");
	assert.ok(waits.every((ms) => ms <= 5 * 60_000), "each wait at most 5 minutes");
	assert.ok(waits.slice(-3).every((ms) => ms === 5 * 60_000), "settles on one probe per 5 minutes");
});

test("a learned reset ends the probing: once known, it waits for that time", () => {
	const { controller, advance } = createHarness();
	const now = Date.parse("2026-03-11T10:00:00.000Z");
	controller.onAgentSettled({ errorMessage: NINE("9s") });
	advance(60_000);
	// Some response (a gateway that adds the headers to its error, or any success) carries the reset.
	controller.onProviderResponse({ "anthropic-ratelimit-unified-reset": String(now / 1000 + 3 * 3600) }, 503);
	const decision = controller.onAgentSettled({ errorMessage: NINE("16s") });
	assert.equal(decision.action, "schedule");
	if (decision.action === "schedule") assert.equal(decision.reason, "window-reset");
});

test("a clean answer after the window forgets the old reset", () => {
	const { controller, advance } = createHarness();
	const now = Date.parse("2026-03-11T10:00:00.000Z");
	controller.onProviderResponse({ "anthropic-ratelimit-unified-reset": String(now / 1000 + 600) }, 200);
	advance(700_000);
	controller.noteNoError();
	assert.equal(controller.knownReset(), undefined);
});
