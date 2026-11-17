# DECISIONS

Findings that shaped the implementation, and the choices they forced.

## 1. discord.py 2.7.1 interaction dispatch (read from the vendored source)

Sources: `<hermes-checkout>/.venv/lib/python3.11/site-packages/discord/`
(`state/state.py`, `ui/view.py`, `interactions.py`, `abc.py`).

- `state/state.py:814-831 parse_interaction_create`:
  - `type == 3` (component) → `self._view_store.dispatch_view(component_type, custom_id, interaction)`
  - `type == 5` (modal submit) → `self._view_store.dispatch_modal(custom_id, interaction, components, resolved)`
  - then **always** `self.dispatch('interaction', interaction)`.
  ⇒ Both a View callback *and* any `on_interaction` listener see the same click.
- `ui/view.py:940 ViewStore.add_view` keys each **dispatchable** child as
  `dispatch_info[(item.type.value, item.custom_id)]` under `self._views[message_id]`
  (fallback bucket `self._views.get(None)`), plus compiled regex patterns for dynamic
  items. `ui/view.py:1054 dispatch_view` looks the **exact full custom_id** up (no prefix
  splitting) — so `dshr:<token>:<index>` must be registered verbatim, and two prompts can
  never cross-talk because the token is inside the id.
- `abc.py:1710` (`Messageable.send`): after the POST, `state.store_view(view, ret.id)`.
  ⇒ Non-persistent views sent by *this* client do get callbacks, in-process, for the
  lifetime of the client. No `discord.ui.View` persistence (`add_view`) is required for
  our flow because a prompt is answered within one gateway session; a prompt that
  outlives it is handled by the `on_interaction` backstop instead.
- `interactions.py:1309` (`Interaction.response.send_modal`) → `state.store_view(modal)`
  keyed by `modal.custom_id` in `_modals`; `dispatch_modal` reaches `modal._dispatch_submit`
  → `on_submit`. ⇒ The "Type your own answer" modal is routed the same way as buttons.
- `View(timeout=None)` is never unregistered; `ViewStore` only syncs
  `_synced_message_views` when a message id exists. ⇒ Live prompt views use
  `timeout=None` (the dsh side owns the deadline), and post-resolution views are sent
  with every button `disabled=True`.

**Consequence (wiring choice).** Button/modal callbacks are the *only* code path that
POSTs an answer, so a click cannot double-answer through `on_interaction`. The global
`on_interaction` listener is observability/UX only: an ephemeral "no longer live" notice
for relay custom_ids whose view is gone. Exactly-once is enforced twice more: the
per-prompt `resolved`/`in_flight` flags in `hermes-relay/__init__.py`, and the bridge's
idempotent `POST /v1/answer` (a second answer returns HTTP 200 `status:"duplicate"` with
the first answer, so the relay re-stamps instead of erroring).

## 2. Bridge auth and endpoints

- Both halves read one shared secret and one bridge port from the single personal
  config file `~/.config/dsh-discord-relay/config.json` (default port `8790`;
  `DSH_RELAY_SECRET` survives only as an env fallback the file wins over). The
  secret travels as header `x-relay-secret`, compared with `timingSafeEqual`
  after a length check. `GET /v1/health` is the only unauthenticated route
  (liveness only: `{ok, pending, last_poll_age_ms}`), which lets the dsh side log
  "relay not polling" without leaking anything.
- `GET /v1/pending` stamps `lastPollAt`; that single signal is what makes
  fail-fast possible: if nobody ever polls, `ask_user_question` errors after
  `DSH_RELAY_NO_POLL_MS` (default 90 s) with "the question was NOT delivered" instead of
  sitting for 10 minutes. Once a relay has polled, the deadline becomes
  `DSH_RELAY_TIMEOUT_MS` (default 10 min) and the error says the owner did not answer.
  Either way the tool call fails cleanly — never lost, never hanging forever.
- The bridge binds `127.0.0.1` only and never logs the secret. Answer identity is the
  12-char `token` (fallback lookup: `request_id` + `question_id`) so a stale click on an
  old message cannot answer a newer question by coincidence.

## 3. One plugin module mounts bridge + answerer + tool

The profile bundle patch is a single `- insert:` entry
(`{id: dsh-discord-relay, name: dsh-relay-bundle}`), i.e. **one** Cordis module
(`dsh-relay-bundle/src/index.js`) does all three jobs, instead of three plugin ids
pointing at subpaths. Reason: `{id, name}` resolves `name` from the profile's
`node_modules` package root; subpath plugin resolution (`dsh-relay-bundle/bridge`) was
never verified against a working exemplar, and a silently unmounted ask tool would break
the whole feature. `billion-context` (a real installed bundle) uses exactly this shape:
`package.json` with `"type":"module"`, `exports["./package.json"]`,
`files: [..., "dsh.bundle.patch.yml"]`, `dsh.bundle.patch`.

### The real answerer seam (dsh 0.2.0-rc.2)

`ctx.userQuestions.registerProvider` does **not** exist in the installed build —
the first gate failed with `TypeError: ctx.userQuestions.registerProvider is not a
function`. The answerer seam is a Cordis **waterfall event**:

* type: `'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent,
  next: () => Promise<AskUserQuestionAnswer>)` (`dsh-user-questions/lib/types/types.d.ts:145`,
  mirrored in `dsh-api-remotes/lib/types/remote-events.js:39`);
* dispatch (`dsh-user-questions/lib/index.js:681`) uses `scopeTarget(agent, agent)` and
  rejects `NO_PROVIDER` ("no user-questions answerer accepted the request") when nothing claims it;
* **`{ global: true }` is mandatory**: `cordis/lib/index.js:255-261` filters root-registered
  listeners out of an agent-scoped dispatch, so a plain `ctx.on(...)` listener is never asked;
* not calling `next()` vetoes the chain = we claimed the request. The plugin calls `next()` only
  for pre-delivery failures (`RELAY_UNCONFIGURED`, `RELAY_BIND_FAILED`, `RELAY_STOPPED`,
  `RELAY_NOT_POLLING`) so a local answerer can still respond — never after Discord has the question.
* `registerProvider` is kept as a preferred branch for newer sources (`typeof === 'function'`).

The tool itself goes through `ctx.userQuestions.ask(...)`, i.e. the same waterfall the plugin
listens on: one code path, and the answer shape is produced by the service, not hand-assembled.

### Schema and resolution

`inject = ['tools', 'userQuestions']` mirrors the reference tool
(`packages/interaction/tool-ask-user/src/index.ts`), whose schema I copied field for field
(`questions[]` with `id`, `question`, `header?`, `options?[{label, description}]`,
`multi_select?`; output `{answers:[{id, selected, custom?}]}`, `additionalProperties:false`,
`render` → JSON text). `multi_select` is mapped to `multiSelect` and `exec.agent` /
`exec.signal` are forwarded, because `ctx.userQuestions.ask()` validates the caller is the
live registry root (`CALLER_NOT_LIVE` / `DELEGATED_CALLER`).

`defineTool` is resolved with a top-level `await import('@deepseek-ai/dsh-tools')` so
registration stays synchronous inside the setup phase while a resolution failure degrades
to "no ask tool + loud log line" rather than a plugin that cannot load. The bundle
declares **no** dependencies on purpose (the package lives outside the profile tree, and
dsh resolves plugin imports from the profile's own install); the fallback if the gate
shows it unresolvable is a declared dependency on `@deepseek-ai/dsh-tools`.

## 4. Multiple choice is clickable; free text is a modal

`relay_core.build_components()` is the single source of truth for component payloads,
shared by the discord.py `View` path and the raw-REST dev path. It respects the real
budgets (button label 80 UTF-16 units, ≤25 items, ≤5 components per row / 5 rows) and
reserves room for the mandatory "Type your own answer" button plus, on multi-select
questions, a "Submit selection" button (options are truncated at 23 in that case; the
owner's answer is never wrong because of a dropped tail option — dropped options are visible in the
message text, so the owner is never asked to choose from a truncated list).
- Single select: one click answers. A typed modal answer **overrides** `selected`.
- Multi select: option buttons toggle local ✓ marks (an `edit_message(view=...)` repaint,
  no bridge traffic), `Submit selection` answers. A typed answer **supplements** them.
- Anyone but the configured `ownerId` clicking gets an ephemeral refusal and the bridge is
  never touched.

## 5. Dev mode without the gateway

`hermes-relay/dev_main.py` speaks raw Discord REST with stdlib only (the bot token is read
at call time from the env / `~/.hermes/.env` and never printed). It must send
`User-Agent: DiscordBot (...)` or Cloudflare answers 1010. `selftest` posts exactly one
`[relay self-test]` message with the real components of a live bridge question, re-reads it
via `GET /channels/{id}/messages/{id}` to verify components + the literal `<@…>` tag, and
`--delete` removes it (2xx expected). The plugin is never copied into `~/.hermes/plugins`
by this agent; `install.sh` is written but not run.

## 6. What the gates proved / fixed

Verbatim gate output is quoted in the final report; the fixes they forced:

1. **`registerProvider` absent** → waterfall listener + `{ global: true }` (§3). Gate 4 then
   resolved the blocked tool call from a plain `POST /v1/answer` and the agent replied
   `Green CONFIRMED` (`count=1`).
2. **Secret not exported** (`set -a` missing in the gate shell) → bridge correctly stayed closed;
   the observed model behaviour was a *refusal to fabricate an answer*, which is the desired
   failure shape and is quoted in the report.
3. **`bad_json` from curl inside a here-doc gate** — shell quoting of `-d "{...}"`, not the
   bridge; bodies are now built with `python3 -c json.dumps` into a variable.
4. **Single-select click was dropped** (`const chosen = single ? [] : selected` in
   `bridge.js #answer`) → now `const chosen = (custom !== '' && !record.multiSelect) ? [] : selected`,
   so a click survives and a typed answer still overrides it (proved in `tests/bridge_answer.mjs`).
5. **Duplicate answer 404'd** because the record was deleted in `finally` → answered records are
   `retain()`ed for `RETAIN_MS` (120 s, capped at 50) and pruned lazily; a late/duplicate POST now
   returns `200 {"status":"duplicate", "answer": …}` so the relay re-stamps instead of erroring,
   and unanswered records are dropped so they cannot be settled later.
6. **`load_config(env)` ignored the passed mapping** for every int var → `_env_int(source, …)`;
   `tests/relay_unit.py` pins the config-file wiring through temp fixtures loaded via
   `DSH_RELAY_CONFIG` (see §7).
7. **discord.py 2.7.1 is not in the 3.14 gateway interpreter** — it lives in the Hermes venv on
   python 3.11.15. The relay code stays 3.11-compatible (`from __future__ import annotations`),
   which the unit gate runs under.
8. **Wrong interpreter path typo** (`python-3.14.7+2024100901-…`) → rc 127; real path is
   `~/.hermes/tools/python-3.14.7+20260901-darwin-arm64/bin/python3`.

Message-level proof (gate 5, raw REST against the real channel): the posted message came back with
`component_rows=1`, `buttons=['Red','Green','Blue','Submit selection','Type your own answer']`,
`custom_ids=['dshr:<token>:0'… ':submit', ':custom']`, the literal owner tag present, and the answer
POST settling the live question (`status: resolved`, `selected: ['Green']`).

## 7. Personal settings live in ONE config file

Per-setting env vars scattered the operator identity across the caller's shell
and assorted env files, so an install could silently inherit
somebody else's inbox and the repo kept risking real ids in docs. Ruling: one
file — `~/.config/dsh-discord-relay/config.json` (chmod 600, never committed;
`DSH_RELAY_CONFIG` relocates it, tests only) — holding `channelId`, `ownerId`,
`secret`, optional `port` (8790) and `userAgent`. Both halves
(`hermes-relay/relay_core.py`, `dsh-relay-bundle/src/protocol.js`) read that
same file and fail loudly with the path and a setup hint on any gap;
`DSH_RELAY_SECRET` survives only as an env fallback the file overrides. A
later pass removed the extra dsh-side env file too: the secret chain is the
config file, then the process environment (plus Hermes' own env file, on the
Hermes half only, since Hermes is a declared integration).
Consequences: `install.sh` takes the ids as one-time arguments and writes them
into the file, the JS side keeps snowflake ids as strings (JSON.parse would
lose precision as ints), and a broken config soft-fails the Cordis plugin
(`RELAY_UNCONFIGURED` + logged hint) instead of crashing plugin load.

## 8. The relayed profile is the operator's choice

Nothing here may assume which dsh profile a person works in: one machine's
profile name is a fingerprint, not a requirement, and it made the install
unusable anywhere else. So the profile is an argument (`install.sh <profile>`,
or `DSH_RELAY_PROFILE`), it is recorded in the one config file as the optional
`dshProfile` key, and `bin/dsh-relay` resolves it in that order — file, then
env, then the shipped default `headless`, chosen because dsh auto-initializes
that profile and a first run therefore needs no setup. Any profile behaves
identically once `dsh plugin --profile <profile> add` installed the bundle into
it. Consequences: the wrapper is named for the relay rather than for one
workflow, `tests/relay_unit.py` pins the precedence instead of a person's
profile, and docs present `headless` as a default choice, never a requirement.

## 9. The relay owns its own tool and races the surface it finds

Coverage cannot mean "register a tool and hope": the app-launched profiles
already own the name `ask_user_question` (the app's own bundle mounts it, with
an in-process answer card), and `ctx.tools.register()` throws on a duplicate —
which is exactly how the first attempt at this install broke those profiles. So
the bundle takes the two seams dsh actually offers: a `tools/execute` waterfall
listener that returns a value without ever calling `next()` for
`ask_user_question` — that is ownership without registration, and because
argument validation lives *inside* the registered wrapper it never runs, which
is what finally kills finding 2 — and a `ctx.tools.get()` probe that registers
the tool only where nobody else owns it, so a headless profile still has a name
to call. `ctx.userQuestions.registerProvider()` is opportunistic for the same
reason: the slot is single-owner, plan-mode asks through it, and a
`DUPLICATE_PROVIDER` now means "there is a local card, race it" instead of
throwing during plugin mount.

The race is first-answer-wins across the two surfaces: the local card and the
Discord bridge run as rivals, whoever answers first settles the ask and the
loser is dropped (locally through the same abort path the app uses to cancel,
remotely by deleting the bridge token). Codes that mean "no local surface can
ask at all" (`NO_PROVIDER`, `ASK_MISSING_AGENT`, `CALLER_NOT_LIVE`,
`EMPTY_QUESTIONS`, `BAD_INTENT`) delegate: the bridge then *is* the answer path.
Consequences: an app session keeps its own card (invariant 4 — augmented, not
amputated); if the card wins, an already-posted Discord prompt goes stale and a
later click gets `404 no_such_pending_question` rather than recording an answer
nobody will read; a question whose arguments the model malformed is repaired
(`id` synthesized as `q1`, JSON-in-a-string parsed, `text`/`question` aliases)
and the repair is reported back to the asker instead of eating the question;
`questions` is `required`-free in the relay's own schema because a missing
argument is a question the model forgot to phrase, not a reason to lose one.

Both seams are therefore wired, and the mount log states which ones it got
instead of promising a listener the runtime may never call. What was measured on
this machine, in the e2e gate: an installed 0.1.1-rc.2 profile exposes
`ctx.userQuestions` with **no** `registerProvider` (so the provider branch is
`typeof`-gated, not assumed), and the dsh source tree checked out here contains
no emitter for `'user-questions/request'` either - while this file's own earlier
section cites that waterfall being dispatched in 0.2.0-rc.2. Two runtimes, two
different seams, neither verifiable from here: keep both, log the gap, and let
the tool path carry the proof.

## 10. Install covers every profile it can find

Finding 1 was one profile's worth of coverage, so the installer stopped taking
a single favorite: with no `--profiles` it installs into every profile directory
under `$DSH_HOME/profiles` (that is also the profile `dsh` itself resolves),
`--profiles a,b` narrows it, and one failing profile no longer aborts the others
— it names them and exits non-zero. It stays idempotent (a profile already
listing the bundle is skipped, not rewritten) and reversible (`--uninstall`
removes the bundle from every profile and deletes the installed copy, then says
plainly which files it left alone on purpose: the one config file and Hermes'
env file, both holding the operator's own settings). Consequences: a fresh
`install.sh` now covers every profile directory that exists under the operator's
`~/.dsh/profiles` in one pass, whatever they are called there; the deviation from the
original one-profile design is
only in the installer — `bin/dsh-relay` still resolves the operator's chosen
profile, because which profile a *person* launches is theirs, and what the relay
does in any of them is now identical.

## 11. One poller finds every bridge by health-probing a port window

Every dsh process binding the same fixed `127.0.0.1:8790` meant the second
process to start was silently undeliverable, and its ask waited for a human
nobody could reach. The fix is a window: each bridge takes the first free port
in `[port, port + portSpan)` (`portSpan`, default 20, capped at 64) and refuses
to pretend otherwise when the whole window is taken; the Discord half health-probes
the same window concurrently and trusts only a reply that identifies itself
(`relay: "dsh-bridge"`, matching `protocol`), caches the live set for five
seconds, polls every live bridge, and routes each answer back to the bridge that
owns its token. A registry/heartbeat file was rejected deliberately: it adds a
second source of truth about who is alive, liveness is exactly what a crashed
process lies about, and the health endpoint already answers both questions
while the shared secret still gates `/v1/pending`. Consequences: no new state on
disk; a bridge started after the poller is found within `poll_interval` + the
discovery TTL (~6.5 s worst case), inside the 90 s no-poll budget; a foreign
service squatting a port in the window is ignored rather than polled; and a
wrong secret keeps the bridge cached (a fixable config mistake, reported once
in a while instead of retried every tick) while any other failure drops it until
it re-identifies itself.

## 12. The `tools.override` capability check is expected noise

The gateway logs `capability_check plugin=dsh-discord-relay
capability=tools.override decision=deny` on every plugin load, and the check is
unconditional in `hermes_cli/plugins_loader.py` (`_track_tool_override_policy`
probes `_tool_override_allowed("")` for every plugin it loads), so no manifest in
this repo can silence it. The relay does not want that capability: overriding
another plugin's tool is how an answer surface gets replaced by the wrong one,
and the relay owns its path through `tools/execute` plus conditional
registration (§9) instead. So `plugin.yaml` now declares `capabilities: []` and
`provides_tools: []` — a decision written down rather than an omission — with a
comment pointing here so the log line reads as intended behavior. Consequences:
the deny line stays in the gateway log at its existing cadence (the one thing
this repo cannot change without touching Hermes), the manifest no longer
triggers the loader's "capabilities must be a list" warning, and anyone reading
the noise finds the reason in two steps.

---

## 13. GH-1868 step 5 — the zcode-facing surface (what the adapter may observe)

Ruling: `/Users/brak/code/agent-inbox-zcode/docs/rulings/GH-1868-zcode-lane-ruling.md`,
"Relay" in the minimal swap design, invariants M2/M6/M8/M9. Steps 1–4 landed in
`agent-inbox-zcode/DECISIONS.md` (§"GH-1868 — zcode lane" and "steps 2–3"); this
entry records only what is new on the relay side, and re-measures the identities
on the box instead of inheriting them.

**Executable / build identities (re-measured here).** `zcode` resolves to
`/opt/homebrew/bin/zcode` →
`/opt/homebrew/lib/node_modules/zcode-app-cli/bin/zcode.js`.
`zcode --version` → `zcode-app-cli 3.18.2-47` / `zcode-runtime 0.17.1` — the
same pinned pair steps 1–4 validated. The adapter pins that pair and refuses a
different one unless `DSH_RELAY_ZCODE_ALLOW_UNPINNED=1`, because every mapping
below is a property of this build's output.

**The supported surface is process + stdio + a per-process settings file.** The
package ships its own host contract
(`/opt/homebrew/lib/node_modules/zcode-app-cli/docs/HOST_INTEGRATION.md`,
contract version 1): hosts start the published `zcode` bin, pass argv through
unchanged, set the child cwd to the workspace, **consume both stdout and
stderr**, own the overall deadline, forward `SIGINT`/`SIGTERM`/`SIGHUP` on
cancellation, and record the final status. `vendor/` is explicitly *not* a
compatibility surface, so the adapter never opens it. `docs/HEADLESS.md` adds
the two rules M6 turns into code: with `--output-format stream-json`, completion
requires **exit 0 plus a terminal `result` record** ("a missing result is
incomplete even if the process reports status 0"), and cancellation statuses
130/143/129 are not success.

**Three observable surfaces, checked against the pinned build:**

| Surface | Evidence | Used for |
|---|---|---|
| `--output-format stream-json` (JSONL on stdout) | `HEADLESS.md:14-22`; string present in the installed package | progress events + terminal record |
| `--json` terminal record on stdout | step-1 receipt in `agent-inbox-zcode/DECISIONS.md` (`sessionId`, `response`, `usage{…}`, `projection.status`) | the terminal outcome + usage |
| `mcp.servers` under `ZCODE_CLI_SETTINGS_FILE` | `HOST_INTEGRATION.md:83` ("hooks, MCP servers and default tool permissions") + `CONFIGURATION.md:125-178` (`type: stdio` with `command`/`args`/`env`/`cwd`, `features.mcp: true`) | **the owner-question path** |

**The question path is real, and it is MCP — not a scraped approval.** The gap
the ruling left open ("if zcode lacks a usable question/permission response
mechanism, that is an unresolved parity gap") resolves in favour of parity: the
pinned build loads stdio MCP servers from a **per-process** settings file
selected by `ZCODE_CLI_SETTINGS_FILE`, which replaces the user settings file
rather than merging with `~/.zcode/cli/setting.json`. The adapter therefore
writes a scratch settings file declaring exactly one stdio MCP server — this
repo's `zcode-relay/mcp-server.mjs` — and the model's `ask_user_question` call
is a genuine tool call whose MCP result is the owner's answer.
`hooks.events.<Event>` exists in the same file, but nothing observed shows a
hook returning an answer to the model, so hooks are **not** the answer path;
building on them would be a guess about an unmeasured protocol, which the ruling
forbids. No deviation from the minimal design: the Hermes/Discord half and the
authenticated 127.0.0.1 bridge stay where they are, and only the DSH-facing
integration is replaced.

**Route discipline (M1) and credential discipline (M8).** The adapter reads the
effective route out of the pinned provider config
(`~/.zcode/v2/provider_config.json`, honouring
`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`) **read-only**, and launches only when the
provider id, model id and baseUrl are exactly `epyc` / `qwen38-flashnext` /
`http://192.168.86.250:8086/v1`; retired `:8080` is refused by host:port
equality, not by substring. The API key is never read into the adapter's memory,
argv, prompt, log or mailbox record — the child resolves its own credential from
the supported file, exactly as steps 1–4 left it. The relay secret stays in
`~/.config/dsh-discord-relay/config.json`; the MCP child reads that same file
instead of being handed the secret in argv or in the zcode settings file. No
global zcode default is edited: session state for a relayed run goes to a
host-owned `ZCODE_SESSION_DB_PATH` (a documented host integration point) and the
scratch settings file lives in the host's state dir.

**M2 shares the authority instead of inventing a second one.** The zcode lane's
`internal/pair/classlease.go` is the one-admitted-job-per-class authority on
this host: dir `/tmp/qfn-class-lease` (`QFN_CLASS_LEASE_DIR`), file
`class-<sha256(class)[0:16]>.lock`, `O_CREATE|O_EXCL`, record
`{class,pid,nonce,acquired,owner}`, reclaim only from a provably dead pid, class
key `provider|model|host:port` with the endpoint canonicalised to host:port. The
relay's `zcode-relay/classlease.js` implements the **same** directory, filename,
record and rules, so a relayed turn and a pairctl turn contend for the *same*
slot; capacity is released only after the child is reaped, and a deadline that
fires while the child is alive does not free it.

**One correlation identity.** One adapter process hosts one bridge, spawns one
qfn child, and that child's settings file contains only this MCP server, so a
question can only reach the run that asked it. The adapter stamps each pending
question with `request_id = job:<jobId>` and carries `session_id` from the
stream; the answer returns over the existing `/v1/answer` exactly-once path (§2),
which is where duplicate and stale answers are already handled.

---

## 14. GH-1868 steps 2–4 — what the adapter is, and the two things it does not claim

**The bridge grew one hook, not a second protocol.** `RelayBridge` gains
`handleExtension(req, res, route)`, which the base class answers with `false`,
and which `#handle` consults only after the constant-time secret check and only
after every existing route has declined. That is the whole shared-helper change:
the dsh half's routes, statuses, exactly-once answer rule, retention windows and
health shape are the same code with one extra `await` on a no-op, and the dsh
gates (`bridge_answer`, `ask_flow`, `bridge_ports`, `relay_unit`) pass with the
same output before and after. Everything zcode-specific — `POST /v1/ask`,
`GET /v1/events`, `publish()` stamping `job:<id>` — lives in the subclass.

**The question path is MCP because that is the mechanism zcode actually
offers.** A per-process `setting.json` under `ZCODE_CLI_SETTINGS_FILE` declares
one stdio server; the model's `ask_user_question` is then a real tool call whose
result is the owner's answer, and the answer still arrives through the inherited
`/v1/answer` exactly-once route. `mcp-server.mjs` holds no authority: it reads
the same supported config file for the secret (the settings file the child is
declared in contains port, job id and run token, never the secret) and reports
an undeliverable question as a tool error with the reason, never as an answer.

**Two things the adapter deliberately does *not* claim, so nobody reads silence
as support:**

1. *It relays runs it hosts.* A human-driven TUI session is not observed. The
   pinned build also exposes `hooks.events.<Event>` in that same settings file,
   and a hook could one day report progress or a permission decision — but no
   measured behaviour shows a hook returning an answer to the model, and the
   ruling forbids building on an unmeasured protocol. Wiring hooks is the
   obvious next step, not an existing feature.
2. *Permission prompts are not relayed as owner questions.* Headless zcode has
   no documented approval-response channel, so confinement is explicit instead:
   `--mode` and `--disallowed-tools` are passed on every launch and a mode name
   alone is never treated as evidence of confinement (M8). Owner interaction is
   the `ask_user_question` tool. If a future build documents an approval
   response, the place it lands is another extension route on this bridge.

**Bounded by construction, because a relay that hangs is worse than one that
lies.** Progress is capped (200 entries) and evicted first under flood; terminal
events are never evicted before the terminal cap, and the host holds its bridge
port until the poller has actually drained them or `--hold-ms` expires — a
missing gateway costs the events, never the exit. The runner consumes stdout and
stderr continuously with caps, owns the deadline, forwards SIGTERM then SIGKILL,
and excludes heartbeat records from the stall clock, because a stream of
heartbeats is exactly what would otherwise age into a fake success. The lease is
released after the child is reaped and never on a deadline alone.

**Gate receipts for these steps** (full text in the commit bodies):
`node tests/zcode_adapter.mjs` → `all zcode_adapter checks passed (50 checks)`
rc=0; `python3 tests/zcode_relay_unit.py` → `all zcode_relay_unit checks passed
(9 checks)` rc=0; the four pre-existing gates rc=0 unchanged; `node --check` rc=0
on every touched file; and one live qfn turn through the mapping path in a
scratch dir outside the repo, rc=0, terminal record
`response="\n\nPONG-RELAY-1868"`, `usage.source=provider`,
`projection.status=idle`, `sessionId=sess_90949c93-…`.
