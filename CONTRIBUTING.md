# Contributing

## Layout

- `hermes-relay/` — Python half: Hermes platform plugin (`__init__.py`), shared
  protocol/UI builders (`relay_core.py`), gateway-free dev runner (`dev_main.py`).
- `dsh-relay-bundle/` — JS half: Cordis plugin — `src/protocol.js` (config +
  constants), `src/bridge.js` (loopback HTTP server), `src/index.js` (tool +
  answerer wiring).
- `tests/` — the two gates below. `install.sh` — operator installer (never run
  it in CI). `bin/dsh-relay` — the launch wrapper; it picks the dsh profile
  from `dshProfile` in the config file, else `DSH_RELAY_PROFILE`, else the
  shipped default `headless` (checked by `tests/relay_unit.py`).

## Gates (both must pass before a PR)

```sh
python3 tests/relay_unit.py
node tests/bridge_answer.mjs
```

`relay_unit.py` re-execs itself under a python that can `import discord` when
one is available; point it at your Hermes checkout with the `HERMES_VENV`
environment variable (an env value — never hardcode a personal path). The final
line must be `all relay_core / discord.py UI checks passed`, rc 0.

Syntax gates used in review:

```sh
python3 -m py_compile hermes-relay/*.py tests/relay_unit.py
bash -n install.sh bin/dsh-relay
node --check dsh-relay-bundle/src/protocol.js
node --check dsh-relay-bundle/src/bridge.js
node --check dsh-relay-bundle/src/index.js
```

## Invariants worth not breaking

- **One config file is the source of truth**
  (`~/.config/dsh-discord-relay/config.json`, `DSH_RELAY_CONFIG` override for
  tests). Both readers must demand the same required keys and fail with a hint
  naming the exact path — never a default channel, owner, or guess.
- Discord snowflakes stay **strings** in JS (they exceed `Number.MAX_SAFE_INTEGER`);
  the Python side converts to `int` at load.
- The bridge binds `127.0.0.1` only, compares the shared secret with
  `timingSafeEqual`, and never logs the secret.
- `ask_user_question` must **never hang**: every wait has a deadline, every
  pre-delivery failure calls `next()`, answered records are exactly-once
  (duplicate POSTs → `200 duplicate`).
- Keep the two `SETUP_HINT`s (Python + JS) and `config.example.json` in sync
  with what the loaders actually require.

## Test fixtures

Fake ids only: channel `111111111111111111`, owner `222222222222222222`, secret
`s3cret` / `replace-me`. Config fixtures are written to a `tempfile.mkdtemp`
directory and loaded via `DSH_RELAY_CONFIG`, with `hermes_env` pointed at a
nonexistent path so a machine's real `~/.hermes/.env` can never leak in.

## Fingerprint gate — no single operator's setup

Generic English is fine ("a coding agent", "your blockers channel"); anyone's
*specific* profile, channel name or private env file is not. Grep for your own
machine's names — written as placeholders here on purpose so this file cannot
trip its own gate:

```sh
grep -rnE "<your-dsh-profile-name>|<your-channel-name>|<legacy-env-file>" . \
  --exclude-dir=.git --exclude=node_modules --exclude-dir=__pycache__
```

Must output **nothing** (exit 1). The shipped defaults are choices, not
requirements: `headless` as the fallback profile, and no default channel at all.

## PII gate — a PR must introduce none

```sh
grep -rniE "<your-handle>|<your-user-id>|<your-channel-id>|<home-path-prefix>|<org-name>" . \
  --exclude-dir=.git --exclude=node_modules --exclude-dir=__pycache__
```

(Plug in your own handle, ids, home-path prefix and org name — written as
placeholders here on purpose, so this file cannot trip its own gate; it must
output **nothing**.) No
personal paths, ids, tokens or secrets in any tracked file — the real config
lives in `$HOME`, outside the repo, which is why no `.gitignore` entry is
needed for it.

## Style

Functions under ~60 lines with a single purpose; comments say *why*, not
*what*; the shared builders in `relay_core.py` must stay gateway-free (raw
REST + the dev runner reuse them).
