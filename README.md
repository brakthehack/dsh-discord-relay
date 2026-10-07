# dsh-discord-relay

Ask your coding agent a question and answer it **from your phone** — as clickable
Discord buttons. Two halves share one loopback protocol: a Cordis plugin inside
each `dsh` process serves pending questions over `127.0.0.1`, and a Hermes
gateway plugin polls that bridge, posts the question with buttons to your
Discord channel, and posts your click back. The agent's `ask_user_question`
tool call simply waits for that round trip — and fails fast, never silently,
when the relay is not there.

```
dsh session (any profile)                       Hermes gateway
┌────────────────────────────┐    poll+POST   ┌────────────────────────────┐
│ dsh-relay-bundle (Cordis)  │◀──────────────▶│ hermes-relay (discord.py)  │
│  ask_user_question tool    │   127.0.0.1    │  posts message + buttons   │
│  in-process HTTP bridge    │   :8790        │  relays the owner's click  │
└────────────────────────────┘                └────────────────────────────┘
```

## Quickstart

1. **Create the one config file** (both halves read exactly this; it is never
   committed and `install.sh` creates it for you — this is the manual path):

   ```sh
   mkdir -p ~/.config/dsh-discord-relay
   cp config.example.json ~/.config/dsh-discord-relay/config.json
   chmod 600 ~/.config/dsh-discord-relay/config.json
   ```

   Fill it in (Discord **developer mode** → right-click the channel / your
   avatar → *Copy ID*):

   ```json
   {
     "channelId": "<discord channel id>",
     "ownerId": "<discord user id — the only one allowed to answer>",
     "secret": "<long random string, e.g. openssl rand -hex 24>",
     "port": 8790,
     "userAgent": "DiscordBot (https://example.com/dsh-discord-relay, 1.0)",
     "dshProfile": "<optional: the profile bin/dsh-relay should launch>"
   }
   ```

   `dshProfile` is a personal choice, not a requirement: omit it and the
   wrapper uses `$DSH_RELAY_PROFILE`, else the shipped default `headless`.

2. **Install both halves** into the dsh profile you want the relay in
   (arg 1 is a one-time choice; `headless` is the profile dsh ships and
   auto-initializes, so it is the zero-setup default):

   ```sh
   ./install.sh            # or: ./install.sh my-profile
   ```

   It writes/keeps that config file (mode 600, secret and chosen `dshProfile`
   included), copies `hermes-relay/` to `~/.hermes/plugins/dsh-discord-relay`,
   and adds `dsh-relay-bundle` to that one profile. It never restarts anything
   and prints no secret.

3. **Load the plugin**: restart the Hermes gateway (it imports discord.py from
   its own venv).

4. **Use it**:

   ```sh
   bin/dsh-relay "your task"
   ```

   The wrapper launches the profile recorded in the config file (see
   `dshProfile` below), so the bridge and the bundle are in scope.

   When the model calls `ask_user_question`, a message with clickable options
   appears in your channel, tagged for you. Click (or type via the modal); the
   agent continues with your answer.

## Configuration — one file, both halves

`~/.config/dsh-discord-relay/config.json` is the **single source of personal
truth**. Python (`hermes-relay/relay_core.py`) and JS
(`dsh-relay-bundle/src/protocol.js`) read the same file. A missing, unparsable
or incomplete file fails **loud** — the message names the path and prints a
setup hint; nothing is ever guessed.

| Key | Required | Meaning |
| --- | --- | --- |
| `channelId` | yes | Discord channel where questions land (string or int id) |
| `ownerId` | yes | the only user id allowed to answer; everyone else gets an ephemeral refusal |
| `secret` | yes* | shared relay secret (`x-relay-secret` header, constant-time compare) |
| `port` | no | loopback bridge port, default `8790` |
| `userAgent` | no | Discord API UA; keep it `DiscordBot (...)`-shaped |
| `dshProfile` | no | the dsh profile `bin/dsh-relay` launches (`install.sh` records the one it used) |

\* `secret` may alternatively come from `DSH_RELAY_SECRET` in the process
environment (plus `~/.hermes/.env`, which is the Hermes half's own documented
env file) — **the file wins** whenever both are present.

**Profile precedence** for `bin/dsh-relay`: `dshProfile` in the config file →
`DSH_RELAY_PROFILE` → `headless`. Which profile carries the bundle is an
operator choice, never a requirement: any profile works once
`dsh plugin --profile <profile> add file:<path>/dsh-relay-bundle` installed it.

Small environment knobs (optional, not personal): `DSH_RELAY_CONFIG` (config
file path — tests only), `DSH_RELAY_POLL_MS` (relay poll interval, 1500),
`DSH_RELAY_TIMEOUT_MS` (answer deadline, 600000), `DSH_RELAY_NO_POLL_MS`
(fail-fast if no relay polls, 90000).

## What "working" looks like

- `dsh` log: `bridge listening on http://127.0.0.1:8790`
- `curl -s http://127.0.0.1:8790/v1/health` → `{"ok":true,"pending":0,...}`
- Hermes log: `dsh-relay: polling http://127.0.0.1:8790 …`
- A question posts to the channel; clicking an option stamps the message with
  `✅ Answered: <answer>` and the agent continues within a second or two.

## Security model

- The bridge binds `127.0.0.1` only; no route is unauthenticated except
  `/v1/health` (liveness). Every read/write needs the `x-relay-secret` header,
  compared with `timingSafeEqual` after a length check; the secret is never
  logged.
- Only `ownerId` may answer: the relay checks the Discord user id of every
  interaction before touching the bridge; anyone else gets an ephemeral
  refusal and the bridge is never contacted.
- Answers are addressed by a 12-char per-question token, so a stale click on an
  old message can never answer a newer question.

## Failure behaviour (bounded, never a hang)

| Symptom | Meaning |
| --- | --- |
| `RELAY_UNCONFIGURED` | config file missing/unparsable or no `secret` — bridge never opens |
| `RELAY_BIND_FAILED` | port already taken by another process |
| `RELAY_NOT_POLLING` | no Hermes relay polled within `DSH_RELAY_NO_POLL_MS` — *the question was NOT delivered* |
| `RELAY_ANSWER_TIMEOUT` | relay is live but nobody answered within `DSH_RELAY_TIMEOUT_MS` |
| `ASK_ABORTED` / `RELAY_STOPPED` | the turn was cancelled / dsh exited with a question open |

Exactly-once semantics survive all of it: answered records are retained briefly
so a duplicate POST gets `200 {"status":"duplicate"}` instead of a 404, and
pre-delivery failures call `next()` so another answerer can still take the
request. Details: [`DECISIONS.md`](DECISIONS.md).

## Develop

```sh
python3 tests/relay_unit.py        # protocol/UI unit gate
node tests/bridge_answer.mjs       # bridge answer-semantics gate
```

End-to-end against the real channel (needs the config file + a bot token):

```sh
python3 hermes-relay/dev_main.py health
python3 hermes-relay/dev_main.py selftest --delete
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Troubleshooting

- **"does not exist" at startup** — create the config file (see Quickstart);
  both halves print the full hint, including the path they looked at.
- **Cloudflare 1010 when talking to Discord REST** — Discord rejects requests
  without a `DiscordBot (...)` User-Agent. Keep or set `userAgent` in the
  config file in that shape.
- **`RELAY_NOT_POLLING` right after install** — the gateway was not restarted,
  so the plugin is not loaded yet, or the plugin logged `dsh-discord-relay
  disabled:` — read that hint.
- **Buttons answer but you see nothing** — check the relay is posting into the
  channel in your config file (`channelId`), not a stale one.
