# dsh-relay-bundle

Cordis plugin for DeepSeek Harness. One module, three jobs:

1. **`ask_user_question` tool** — the model-facing way to stop and ask the human.
   Parameters: `questions[]` with `id`, `question`, optional `header`,
   `options[{label, description}]`, `multi_select`. Output:
   `{ answers: [{ id, selected: string[], custom? }] }`.
2. **Answerer** — takes over the `'user-questions/request'` waterfall, so any
   in-process questioner (this tool, or another plugin's ask path) is answered
   over Discord instead of failing with `NO_PROVIDER`.
3. **Bridge** — an HTTP server bound to `127.0.0.1` inside the dsh process that
   the Hermes relay polls.

Plain JS ESM, no build step, no dependencies: `@deepseek-ai/dsh-tools`
(`defineTool`) resolves from the profile's own `node_modules`.

## Install

From the repo checkout, into whichever profile should answer over Discord —
the choice is the operator's; `headless` is simply the profile dsh ships:

```sh
PROFILE="${DSH_RELAY_PROFILE:-headless}"
dsh plugin --profile "$PROFILE" add "file:$(pwd)/dsh-relay-bundle"
```

Activate per process with `bin/dsh-relay`, which launches the profile named by
`dshProfile` in the shared config file (what `install.sh` records), else
`DSH_RELAY_PROFILE`, else `headless`. The bridge reads its secret and port from
that same file — `~/.config/dsh-discord-relay/config.json` (see
[`../README.md`](../README.md)); `DSH_RELAY_SECRET` in the process environment
is only a fallback that the file wins over, and `DSH_RELAY_CONFIG` just
relocates the file for tests. A profile that mounts `userQuestions` but should
NOT ask over Discord simply does not get this bundle; the service stays
available to in-process callers.

## Bridge protocol (loopback, `x-relay-secret` required)

| Route | Purpose |
| --- | --- |
| `GET /v1/health` | unauthenticated liveness: `{ok, pending, last_poll_age_ms}` |
| `GET /v1/pending` | questions waiting for a human (also records the poll heartbeat) |
| `POST /v1/answer` | settle one question: `{token}` or `{request_id, question_id}`, plus `selected: string[]` and/or `custom` |

Answer semantics match the tool contract: for a single-select question a typed
`custom` overrides `selected`; for a multi-select it supplements it.

## Failure modes (all bounded, all surfaced as tool errors)

| Code | When |
| --- | --- |
| `RELAY_UNCONFIGURED` | config file missing/unparsable or it has no `secret` — the bridge never opens |
| `RELAY_BIND_FAILED` | port already taken |
| `RELAY_NOT_POLLING` | nothing polled within `DSH_RELAY_NO_POLL_MS` (default 90 s) |
| `RELAY_ANSWER_TIMEOUT` | no answer within `DSH_RELAY_TIMEOUT_MS` (default 10 min) |
| `ASK_ABORTED` | the agent's turn was cancelled |
| `RELAY_STOPPED` | dsh shut down while a question was open |

Pre-delivery failures (`RELAY_UNCONFIGURED`, `RELAY_BIND_FAILED`,
`RELAY_STOPPED`, `RELAY_NOT_POLLING`) call `next()`, so another answerer — a
local TTY prompt, for instance — can still claim the request. Once a question has
reached a human it is never delegated twice.

See [`../DECISIONS.md`](../DECISIONS.md) for the seam evidence and
[`../README.md`](../README.md) for the end-to-end picture.
