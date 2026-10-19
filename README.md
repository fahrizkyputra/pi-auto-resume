# pi-auto-resume

Continue a Pi session by itself after a rate limit. No more typing "lanjutkan" because the run stopped at a 429.

Pi already retries transient errors three times with a short backoff. When that budget is spent, the run stops and waits for you — even though the error usually says exactly when the limit lifts:

```
503: {"message":"[claude/claude-opus-5-5] [429]: {... "rate_limit_error" ...} (reset after 8s)"}
```

This package reads that hint, waits until the reset, and sends a marked continuation:

```
⚙ auto-resume (rate limit reset 14:32, waited 9s):
The previous attempt stopped because of a rate limit.
Continue from the last step, and do not repeat tool calls that already succeeded.
```

English is the default. Switch to Indonesian with `/auto-resume language id`.

## Install

```bash
pi install npm:@fahrizkyputra/pi-auto-resume
```

## When it acts

| Situation | What happens |
|---|---|
| Rate limit (429, `rate_limit_error`, "too many requests", "overloaded") **with** a reset hint, after Pi's own retries gave up | Waits for the reset (+1.5s slack), then sends the continuation |
| **Plan window** (5-hour or weekly): `Usage limit reached for 5 hour. Your limit will reset at 2026-08-12 17:11:22` | Waits until that real end, however long, then continues. A wait over 6 hours gets one extra notice with the day and time |
| Failure **with no time at all**: a rate limit that says nothing about when, or a network/stream failure (`Stream ended without finish_reason`, `terminated`, `Connection error`, `fetch failed`, `upstream connection lost`) | Retries on a growing pause, 30s, 1m, 2m, 5m, then stops and reports |
| Money and credential problems (`Insufficient Balance`, `insufficient_quota`, billing, subscription, a monthly limit, `MODEL_NOT_IN_PLAN`, an expired token) | Reports only; waiting does not fix those |
| The resumed run immediately fails with the same error | Stops and reports: waiting did not help |
| The next reset hint is much further away (8s → 20m → 3h) | Stops and reports: the limit is getting worse |
| You type anything, press Esc, or switch session | The scheduled resume is cancelled |
| Pi is closed while waiting | The schedule is gone (nothing persists) |

### Which time wins

9router (and some providers) put **two** times in one message:

```
Usage limit reached for 5 hour. Your limit will reset at 2026-08-12 17:11:22   ← the window really ends here
(reset after 2s)                                                                ← the gateway's own pause between retries
```

The `(reset after 2s)` is only how long the gateway waits before its own next try. Following it would resume 12 hours too early and fail again. So the order is: **a stated end of a plan window first**, then response headers (`retry-after-ms`, `retry-after`, `x-ratelimit-reset-after`, `x-ratelimit-reset`), then the other text hints (`reset after 8s`, `1m 4s`, `1h 2m 3s`, `try again in 2 minutes`, `resets at 18:00`). The gateway's pause is still used for ordinary rate limits, where it is the right wait.

A time written without a zone (`2026-08-12 17:11:22`) is read as **Beijing time (UTC+8)**: that is how Z.ai (GLM) writes it, and in 32 of 32 such errors in real sessions it was the only reading that made sense for a 5-hour window (read as UTC, none did). If a provider of yours writes another zone, set `zonelessOffsetHours`. A time written to the second counts as the end of that second, so the resume never lands just before the limit lifts. Times with an explicit zone (`Z`, `+07:00`, `UTC`) are always taken as written.

Waits of hours or days are safe: the timer checks the wall clock every 15 seconds, so a laptop that slept resumes on time and there is no 24.8-day limit of a plain timer.

While waiting, the status bar shows `⏳ limit: resuming 14:32 (2m 10s)`, and you get a notification when the resume is scheduled and when it is sent.

## Commands

| Command | What it does |
|---|---|
| `/auto-resume` | Status: pending resume, resumes sent in this session, config path |
| `/auto-resume cancel` | Cancel the pending resume |
| `/auto-resume off` / `on` | Disable or enable (persisted to the config file) |
| `/auto-resume language en` / `id` | Language of the continuation, notifications, and status bar (persisted) |
| `/auto-resume config` | Show the effective configuration |

## Configuration

`~/.pi/agent/auto-resume.json` (or `$PI_CODING_AGENT_DIR/auto-resume.json`). Every field is optional:

```json
{
  "enabled": true,
  "notify": true,
  "language": "en",
  "maxWaitMs": 0,
  "maxResumes": 0,
  "slackMs": 1500,
  "backoffMs": [30000, 60000, 120000, 300000],
  "zonelessOffsetHours": 8
}
```

`language` is `"en"` (default) or `"id"`. It sets every text the package produces: the continuation, the `⚙ auto-resume` header, notifications, and the status bar countdown.

| Language | Built-in continuation |
|---|---|
| `en` | The previous attempt stopped because of a rate limit. Continue from the last step, and do not repeat tool calls that already succeeded. |
| `id` | Percobaan sebelumnya terhenti karena rate limit. Lanjutkan dari langkah terakhir, dan jangan ulangi tool call yang sudah berhasil. |

Add `"continuationPrompt": "..."` to replace the built-in text with your own. A custom prompt is used as-is in either language; the header still follows `language`.

`maxWaitMs` and `maxResumes` default to `0`, meaning no limit: the package waits as long as the hint says, including until a weekly limit resets. Set `maxWaitMs` (for example `21600000` for 6 hours) if you would rather be told than wait that long. The loop guards above are what stop a pointless cycle.

`backoffMs` is the list of pauses for failures that carry no time, one per retry; when it runs out, the package reports. It restarts after any run that ends cleanly. `zonelessOffsetHours` is the UTC offset used for times written without a zone.

## Notes

- The package only acts after Pi reports `agent_settled` with an errored last message, so it never races Pi's built-in retry.
- Every resume is a normal turn and costs a model call.
- The continuation is an ordinary user message with the `⚙ auto-resume` marker, so the transcript shows it was not you.

## Development

```bash
npm install
npm test          # node:test, no Pi required
npm run typecheck
npm run test:e2e  # real Pi over RPC against a local server that answers 429, then succeeds
PI_AUTO_RESUME_LANGUAGE=id npm run test:e2e   # same check in Indonesian
```

## License

MIT
