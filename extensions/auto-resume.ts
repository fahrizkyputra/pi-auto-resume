/**
 * @fahrizkyputra/pi-auto-resume — continue a session after a rate limit,
 * without a human typing "lanjutkan".
 *
 * Pi's own retry handles three quick attempts. When that budget runs out and
 * the error carries a reset hint, this package waits for the reset and sends a
 * marked continuation message.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AutoResumeConfig, configFilePath, readConfig, writeConfig } from "../src/config.ts";
import { AutoResumeController, type AutoResumeDeps } from "../src/controller.ts";

const STATUS_KEY = "auto-resume";
const STATUS_REFRESH_MS = 5000;

export default function autoResumeExtension(pi: ExtensionAPI) {
	let config: AutoResumeConfig = readConfig();
	let controller: AutoResumeController | undefined;
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	let lastErrorMessage: string | undefined;

	const clearStatusTimer = () => {
		if (statusTimer !== undefined) {
			clearInterval(statusTimer);
			statusTimer = undefined;
		}
	};

	const ensureStatusTimer = (ctx: ExtensionContext, currentController: AutoResumeController) => {
		if (statusTimer !== undefined) return;
		statusTimer = setInterval(() => {
			if (!currentController.pendingFireAt()) {
				clearStatusTimer();
				return;
			}
			currentController.refreshStatus();
		}, STATUS_REFRESH_MS);
		// Do not keep the process alive for a countdown.
		(statusTimer as { unref?: () => void }).unref?.();
		void ctx;
	};

	const makeController = (ctx: ExtensionContext): AutoResumeController => {
		const deps: AutoResumeDeps = {
			// Getter, so /auto-resume on|off takes effect without a new session.
			get config() {
				return config;
			},
			now: () => Date.now(),
			setTimer: (delayMs, fire) => {
				const handle = setTimeout(() => {
					fire();
					clearStatusTimer();
				}, delayMs);
				(handle as { unref?: () => void }).unref?.();
				return () => clearTimeout(handle);
			},
			sendContinuation: (text) => {
				pi.sendUserMessage(text);
			},
			notify: (message, type) => {
				ctx.ui.notify(message, type ?? "info");
			},
			setStatus: (text) => {
				ctx.ui.setStatus(STATUS_KEY, text);
			},
		};
		const instance = new AutoResumeController(deps);
		controller = instance;
		return instance;
	};

	pi.on("session_start", (_event, ctx) => {
		config = readConfig();
		lastErrorMessage = undefined;
		clearStatusTimer();
		const instance = makeController(ctx);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		instance.refreshStatus();
	});

	pi.on("after_provider_response", (event, ctx) => {
		void ctx;
		controller?.onProviderResponse(event.headers);
	});

	pi.on("message_end", (event, ctx) => {
		void ctx;
		const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
		if (message.role !== "assistant") return;
		if (message.stopReason === "error") {
			lastErrorMessage = message.errorMessage;
			return;
		}
		lastErrorMessage = undefined;
		controller?.noteNoError();
	});

	pi.on("agent_settled", (event, ctx) => {
		const instance = controller ?? makeController(ctx);
		if (event.aborted) {
			// Esc is a human decision: never resume an aborted run.
			instance.cancel("run dibatalkan", { silent: true });
			clearStatusTimer();
			return;
		}
		const decision = instance.onAgentSettled({ errorMessage: lastErrorMessage });
		if (decision.action === "schedule") ensureStatusTimer(ctx, instance);
	});

	// Human input always wins; our own message arrives with source "extension".
	pi.on("input", (event, ctx) => {
		void ctx;
		if (event.source === "extension") return;
		controller?.cancel("kamu mengetik");
		clearStatusTimer();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		void ctx;
		clearStatusTimer();
		controller?.shutdown();
	});

	pi.registerCommand("auto-resume", {
		description: "Show, cancel, or toggle automatic resume after a rate limit",
		getArgumentCompletions: (prefix) => {
			const options = ["status", "cancel", "on", "off", "config"];
			const filtered = options.filter((option) => option.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			const instance = controller ?? makeController(ctx);

			if (action === "cancel") {
				const had = instance.cancel("diminta lewat /auto-resume");
				if (!had) ctx.ui.notify("Tidak ada jadwal lanjut otomatis yang menunggu.", "info");
				clearStatusTimer();
				return;
			}

			if (action === "on" || action === "off") {
				config = { ...config, enabled: action === "on" };
				writeConfig(config);
				ctx.ui.notify(
					`Auto-resume ${config.enabled ? "aktif" : "nonaktif"} (${configFilePath()}).`,
					"info",
				);
				return;
			}

			if (action === "config") {
				ctx.ui.notify(
					[
						`file: ${configFilePath()}`,
						`enabled: ${config.enabled}`,
						`notify: ${config.notify}`,
						`maxWaitMs: ${config.maxWaitMs} (0 = tanpa batas)`,
						`maxResumes: ${config.maxResumes} (0 = tanpa batas)`,
						`slackMs: ${config.slackMs}`,
						"continuationPrompt:",
						config.continuationPrompt,
					].join("\n"),
					"info",
				);
				return;
			}

			const fireAt = instance.pendingFireAt();
			const lines = [
				`enabled: ${config.enabled}`,
				fireAt === undefined
					? "tidak ada jadwal yang menunggu"
					: `lanjut otomatis pukul ${new Date(fireAt).toTimeString().slice(0, 8)}`,
				`resume terkirim di sesi ini: ${instance.resumesSent()}`,
				`config: ${configFilePath()}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
