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
│  in-process HTTP bridge    │ :8790-8809     │  relays the owner's click  │
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

2. **Install both halves into every dsh profile it can find:**

   ```sh
   ./install.sh                          # every profile under ~/.dsh/profiles
   ./install.sh --profiles alpha,beta    # or name the ones you want
   ./install.sh --uninstall              # reverse it; your config file stays
   ```

   It writes/keeps that config file (mode 600, secret and chosen `dshProfile`
   included), copies `hermes-relay` to `~/.hermes/plugins/dsh-discord-relay`,
   and adds `dsh-relay-bundle` to each profile. Covering one profile is what
   left every other session unable to ask, so all-of-them is the default; a
   profile that already lists the bundle is skipped, and a profile whose install
   fails is named while the others still finish. It never restarts anything (the
   running app and gateway pick the change up on their next restart) and prints
   no secret.

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
| `port` | no | loopback bridge **base** port, default `8790` |
| `portSpan` | no | size of the port window, default `20` (so `8790`-`8809`), capped at 64 |
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
(fail-fast if no relay polls, 90000), `DSH_RELAY_PORT_SPAN` (window size, 20).

The zcode lane adds three knobs, all operational rather than personal:
`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` (which provider config the route is read
from — the relay only reads it), `DSH_RELAY_ZCODE_STATE_DIR` (where a run's
per-process settings file and scratch state go, default `/tmp/zcode-relay`) and
`DSH_RELAY_ZCODE_ALLOW_UNPINNED=1` (run a build other than the one the event
mapping was validated against; see DECISIONS.md §13). `QFN_CLASS_LEASE_DIR`
relocates the shared capacity lease, which is how a test box isolates it.

## Relaying a zcode run (the qfn lane)

A qfn worker can run on zcode instead of dsh (`zcode-app-cli 3.18.2-47` /
`zcode-runtime 0.17.1`, the pair the mapping is validated against). This
replaces nothing on the dsh side: the same Discord plugin, the same one config
file and the same authenticated `127.0.0.1` bridge serve both, and dsh stays the
fallback lane.

```sh
node zcode-relay/bin/zcode-relay.mjs run \
  --prompt '…' --cwd /path/to/workspace \
  [--resume sess_…] [--job-id ID] [--mode build] \
  [--disallowed-tools 'Bash Edit Write'] [--deadline-ms 600000] [--hold-ms 20000]
```

- **Progress and one terminal outcome** come from the child's
  `--output-format stream-json` stream, mapped to a fixed vocabulary
  (`turn started`, `model streaming (n chunks)`, `running <tool>`,
  `turn completed — n tool calls`) and delivered by the existing poller as
  `⏳ zcode \`job\` · \`sess_…\` — …`, then exactly one terminal line:
  `✅ … completed — <excerpt> — usage: in/out/total, n requests`, or
  `❌ … FAILED (reason) — …`. Prompt text is never relayed, and an outcome that
  is not the adapter's own validated `ok: true` reads
  `FAILED (unverified_outcome)`. Completion needs exit 0 **and** a terminal
  `result` record, so a truncated stream, an empty response, a provider error,
  a signal, a deadline or a heartbeat-only stall is a failure with a named
  reason.
- **Owner questions reach the blockers channel once and come back once.** The
  run declares one stdio MCP server for its own process
  (`ZCODE_CLI_SETTINGS_FILE`), so the model's `ask_user_question` is a real tool
  call whose result is the owner's answer. A duplicate click stays idempotent,
  an answer that arrives after the run ended is a 404, and an undeliverable
  question fails with a code (`RELAY_NOT_POLLING`, `RELAY_ANSWER_TIMEOUT`)
  instead of hanging the worker.
- **One admitted qfn job per model class**, from the same file lease pairctl
  takes (`/tmp/qfn-class-lease`). A second run of the same class — any harness
  name, any provider alias — gets `turn_busy` and launches nothing; the lease
  is released only after the child is reaped.
- **The route, or nothing.** The effective provider id, model id and baseUrl
  are read read-only out of the pinned provider config and must be exactly
  `epyc` / `qwen38-flashnext` / `http://192.168.86.250:8086/v1`; the retired
  `:8080` is refused by host:port. No API key passes through the relay, and no
  global zcode setting is edited: the run's MCP declaration and session DB live
  in the host's state dir.

The config file is the same one — `channelId`, `ownerId`, `secret`, and the
optional `port`/`portSpan`/`userAgent`. **No new keys are needed**, and the
zcode settings file never contains the secret: the MCP child reads the config
file itself. To prove the round trip by hand without a model in the loop:

```sh
node zcode-relay/bin/zcode-relay.mjs ask --question 'Ship it?' --option Yes --option No
```

## What "working" looks like

- `dsh` log: `bridge listening on http://127.0.0.1:8790` - each process takes
  the first free port in the window, so a second concurrent session logs
  `…:8791` and a third `…:8792`
- `for p in $(seq 8790 8809); do curl -s --max-time 1
  http://127.0.0.1:$p/v1/health; echo; done` → one line per live session:
  `{"ok":true,"relay":"dsh-bridge","protocol":1,"port":8790,"pending":0,…}`
- Hermes log: `dsh-discord-relay sweeping 127.0.0.1:8790-8809 for channel …`
  - one gateway serves every session, and an answer always goes back to the
  bridge that owns that question
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
| `RELAY_BIND_FAILED` | every port in the window is taken - raise `portSpan`, or free one; the error names the window |
| `RELAY_NOT_POLLING` | no Hermes relay polled within `DSH_RELAY_NO_POLL_MS` — *the question was NOT delivered* |
| `RELAY_ANSWER_TIMEOUT` | relay is live but nobody answered within `DSH_RELAY_TIMEOUT_MS` |
| `ASK_ABORTED` / `RELAY_STOPPED` | the turn was cancelled / dsh exited with a question open |

Exactly-once semantics survive all of it: answered records are retained briefly
so a duplicate POST gets `200 {"status":"duplicate"}` instead of a 404, and
when two answer surfaces exist (an app profile has its own question card and now
also this relay) the first answer wins and the other surface is dropped: a stale
Discord prompt then replies `404 no_such_pending_question`, never a wrong answer.
A question that could not be delivered says so in the tool result, naming the
window it tried. Details: [`DECISIONS.md`](DECISIONS.md) 9-12.

## Develop

```sh
python3 tests/relay_unit.py        # protocol/UI unit gate
node tests/bridge_answer.mjs       # bridge answer-semantics gate
node tests/ask_flow.mjs            # ask-path race + failure codes
node tests/bridge_ports.mjs        # bridge port-window gate
node tests/zcode_adapter.mjs       # zcode lane: correlation, one outcome,
                                   # question round trip, M2 lease, M1 route
python3 tests/zcode_relay_unit.py  # zcode events on the Discord half
```

`tests/relay_unit.py` needs the interpreter that has discord.py: run it with
that python, or set `HERMES_VENV=<venv that has it>`.

The zcode gates spawn no `zcode` process and open no provider connection: the
child is a scripted stream so every failure branch is deterministic, and the
question path is exercised with a real MCP child process against a simulated
poller. A live turn on the real route is deliberately not part of the suite —
it costs a qfn slot, so it is run as a supervised smoke outside the repo
(`zcode-relay/bin/zcode-relay.mjs run …`, see the lane section above).

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

- **dsh logged `bridge listening` but nothing arrives in the channel** — sweep
  the window: every live bridge answers `/v1/health` with
  `"relay":"dsh-bridge"`. A port that answers with something else is another
  service and is skipped, not fatal; no port answering at all means the bridge
  never opened (`RELAY_BIND_FAILED`) or the process is gone.
- **dsh logs `no userQuestions.registerProvider() here`** - expected for
  profiles the app did not launch: they have no in-process question card. The
  relay then answers through its own `ask_user_question` tool and, if the
  runtime dispatches it, the `user-questions/request` waterfall. The next log
  line names the routes it actually got (`routes: ...`), so read that
  instead of assuming.
- **gateway logs `capability_check … capability=tools.override decision=deny`
  on a timer** — the loader probes that capability from every plugin
  unconditionally. The relay does not ask for it (`capabilities: []`) because it
  overrides nobody's tool; the deny is the intended answer, not a failure. See
  [`DECISIONS.md`](DECISIONS.md) 12.
- **A prompt in the channel stops answering with `404`** — the same question was
  answered in the app first. First answer wins everywhere, and the loser is told
  so instead of resolving late; a duplicate POST gets `200 {"status":
  "duplicate"}`.
