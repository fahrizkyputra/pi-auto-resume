# pi-auto-resume

Continue a Pi session by itself after a rate limit. No more typing "lanjutkan" because the run stopped at a 429.

Pi already retries transient errors three times with a short backoff. When that budget is spent, the run stops and waits for you — even though the error usually says exactly when the limit lifts:

```
503: {"message":"[claude/claude-opus-5-5] [429]: {... "rate_limit_error" ...} (reset after 8s)"}
```

This package reads that hint, waits until the reset, and sends a marked continuation:

```
⚙ auto-resume (rate limit reset 14:32, menunggu 9s):
Percobaan sebelumnya terhenti karena rate limit.
Lanjutkan dari langkah terakhir, dan jangan ulangi tool call yang sudah berhasil.
```

## Install

```bash
pi install npm:@fahrizkyputra/pi-auto-resume
```

## When it acts

| Situation | What happens |
|---|---|
| Rate limit (429, `rate_limit_error`, "too many requests", "overloaded") **with** a reset hint, after Pi's own retries gave up | Waits for the reset (+1.5s slack), then sends the continuation |
| Rate limit **without** a reset hint | Stops and tells you — it does not guess |
| Quota / plan / billing limits (`insufficient_quota`, "usage limit", "out of budget", `MODEL_NOT_IN_PLAN`) | Reports only; waiting does not fix those |
| The resumed run immediately fails with the same error | Stops and reports: waiting did not help |
| The next reset hint is much further away (8s → 20m → 3h) | Stops and reports: the limit is getting worse |
| You type anything, press Esc, or switch session | The scheduled resume is cancelled |
| Pi is closed while waiting | The schedule is gone (nothing persists) |

Reset hints are read from `retry-after-ms`, `retry-after`, `x-ratelimit-reset-after`, and `x-ratelimit-reset` response headers first, then from the error text: `reset after 8s`, `retry after 30 seconds`, `try again in 2 minutes`, `resets at 18:00`, ISO timestamps.

While waiting, the status bar shows `⏳ limit: lanjut 14:32 (2m 10s)`, and you get a notification when the resume is scheduled and when it is sent.

## Commands

| Command | What it does |
|---|---|
| `/auto-resume` | Status: pending resume, resumes sent in this session, config path |
| `/auto-resume cancel` | Cancel the pending resume |
| `/auto-resume off` / `on` | Disable or enable (persisted to the config file) |
| `/auto-resume config` | Show the effective configuration |

## Configuration

`~/.pi/agent/auto-resume.json` (or `$PI_CODING_AGENT_DIR/auto-resume.json`). Every field is optional:

```json
{
  "enabled": true,
  "notify": true,
  "maxWaitMs": 0,
  "maxResumes": 0,
  "slackMs": 1500,
  "continuationPrompt": "Percobaan sebelumnya terhenti karena rate limit.\nLanjutkan dari langkah terakhir, dan jangan ulangi tool call yang sudah berhasil."
}
```

`maxWaitMs` and `maxResumes` default to `0`, meaning no limit: the package waits as long as the hint says. The loop guards above are what stop a pointless cycle.

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
```

## License

MIT
