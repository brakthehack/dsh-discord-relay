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
