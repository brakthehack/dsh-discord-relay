#!/usr/bin/env bash
# Install both halves of the dsh -> Discord question relay.
#
#   1. config:      ~/.config/dsh-discord-relay/config.json (600) is the ONE
#                   personal config file both halves read; ids arrive here as
#                   one-time installer arguments and live in the FILE from then on
#   2. dsh side:    plugin add into ONE profile, chosen by you (arg 1, default
#                   "headless"); the choice is recorded as "dshProfile" in the
#                   config file so bin/dsh-relay launches the same one
#   3. Hermes side: copy the relay plugin into ~/.hermes/plugins
#   4. secret:      written into the config file; DSH_RELAY_SECRET in the
#                   process environment (and in ~/.hermes/.env, the Hermes
#                   half's own env file) stays a fallback the file overrides
#
# Idempotent. Prints the secret nowhere. Never restarts or signals any process.
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE="$REPO/dsh-relay-bundle"
HERMES_PLUGINS="$HOME/.hermes/plugins"
RELAY_TARGET="$HERMES_PLUGINS/dsh-discord-relay"
HERMES_ENV="$HOME/.hermes/.env"
# One-time installer arguments; the config file owns these values at runtime.
# "headless" is the profile dsh ships and auto-initializes, so the default
# install needs no profile setup first; pass your own as arg 1 if you prefer.
PROFILE="${DSH_RELAY_PROFILE:-${1:-headless}}"
PORT="${DSH_RELAY_PORT:-${2:-8790}}"

die() { printf 'install: %s\n' "$*" >&2; exit 1; }

[ -d "$BUNDLE/src" ] || die "bundle not found at $BUNDLE"
command -v dsh >/dev/null 2>&1 || die "dsh not on PATH"

# --- env file helpers -------------------------------------------------------
env_get() { # env_get <file> <key>
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -1
}

env_put() { # env_put <file> <key> <value>   (append when absent)
  local file="$1" key="$2" value="$3"
  mkdir -p "$(dirname -- "$file")"
  if [ -f "$file" ] && grep -q "^$key=" "$file"; then
    printf '  keeping existing %s in %s\n' "$key" "$file"
    return 0
  fi
  printf '%s=%s\n' "$key" "$value" >> "$file"
  printf '  wrote %s to %s\n' "$key" "$file"
}

# --- 1. shared secret -------------------------------------------------------
# The config file below is the source of truth. ~/.hermes/.env is written only
# because it is the Hermes half's documented env file; the dsh half falls back
# to DSH_RELAY_SECRET in its own process environment and nothing else.
printf 'dsh-discord-relay install\n'
SECRET="$(env_get "$HERMES_ENV" DSH_RELAY_SECRET)"
if [ -z "$SECRET" ]; then
  SECRET="$(openssl rand -hex 24)"
  printf '  generated a new DSH_RELAY_SECRET\n'
else
  printf '  reusing the existing DSH_RELAY_SECRET\n'
fi
umask 077
env_put "$HERMES_ENV" DSH_RELAY_SECRET "$SECRET"
chmod 600 "$HERMES_ENV"

# --- 1b. the personal config file (the ONE source of truth; never committed) --
# channelId/ownerId are this machine's operator ids and belong in the FILE, not
# in the environment or in code. install.sh takes them as one-time installer
# arguments (env DSH_BLOCKERS_CHANNEL / DSH_RELAY_OWNER), writes them in, and
# from then on only the file is read. An existing file is never rewritten. The
# chosen dsh profile is recorded the same way, as the optional "dshProfile" key
# that bin/dsh-relay reads back.
CONFIG_DIR="$HOME/.config/dsh-discord-relay"
CONFIG_FILE="$CONFIG_DIR/config.json"
CHANNEL_ID="${DSH_BLOCKERS_CHANNEL:-}"
OWNER_ID="${DSH_RELAY_OWNER:-}"
if [ -f "$CONFIG_FILE" ]; then
  printf '  keeping existing %s (edit ids, port, profile or secret there)\n' "$CONFIG_FILE"
else
  mkdir -p "$CONFIG_DIR"
  {
    printf '{\n'
    printf '  "secret": "%s",\n' "$SECRET"
    printf '  "dshProfile": "%s",\n' "$PROFILE"
    if [ -n "$CHANNEL_ID" ]; then printf '  "channelId": "%s",\n' "$CHANNEL_ID"; fi
    if [ -n "$OWNER_ID" ]; then printf '  "ownerId": "%s",\n' "$OWNER_ID"; fi
    printf '  "port": %s,\n' "$PORT"
    printf '  "userAgent": "DiscordBot (https://example.com/dsh-discord-relay, 1.0)"\n'
    printf '}\n'
  } > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  printf '  wrote %s (chmod 600)\n' "$CONFIG_FILE"
fi
# Never echo the ids themselves - say only what is still missing.
grep -q '"channelId"' "$CONFIG_FILE" \
  || printf '  NOTE %s has no channelId - the relay stays disabled until you add one\n' "$CONFIG_FILE" >&2
grep -q '"ownerId"' "$CONFIG_FILE" \
  || printf '  NOTE %s has no ownerId - the relay stays disabled until you add one\n' "$CONFIG_FILE" >&2
grep -q '"dshProfile"' "$CONFIG_FILE" \
  || printf '  NOTE %s has no dshProfile - the wrapper falls back to "headless"\n' "$CONFIG_FILE" >&2

# --- 2. dsh side (one profile, chosen by the operator) -----------------------
if dsh plugin --profile "$PROFILE" add "file:$BUNDLE" >/tmp/dsh-relay-install.log 2>&1; then
  printf '  dsh profile %s: dsh-relay-bundle installed\n' "$PROFILE"
else
  sed -n '1,20p' /tmp/dsh-relay-install.log >&2
  die "dsh plugin add failed (log: /tmp/dsh-relay-install.log)"
fi

# --- 3. Hermes side ---------------------------------------------------------
mkdir -p "$HERMES_PLUGINS"
if [ -e "$RELAY_TARGET" ]; then
  rm -rf "$RELAY_TARGET.tmp"
  mkdir -p "$RELAY_TARGET.tmp"
else
  mkdir -p "$RELAY_TARGET.tmp"
fi
cp "$REPO"/hermes-relay/__init__.py "$REPO"/hermes-relay/relay_core.py \
   "$REPO"/hermes-relay/plugin.yaml "$REPO"/hermes-relay/dev_main.py "$RELAY_TARGET.tmp/"
rm -rf "$RELAY_TARGET"
mv "$RELAY_TARGET.tmp" "$RELAY_TARGET"
printf '  hermes plugin: %s\n' "$RELAY_TARGET"

cat <<EOF

Next steps (owner):
  1. Personal settings live in ONE file (chmod 600, read by BOTH halves):
         ~/.config/dsh-discord-relay/config.json
     "channelId" = the channel you want questions delivered to, "ownerId" = the
     only user allowed to answer (Discord developer mode -> right-click -> Copy
     ID). If install.sh reported one missing, add it yourself - ids are never
     guessed for you. "dshProfile" = $PROFILE: the profile the bundle went
     into, which bin/dsh-relay launches - that key wins over
     DSH_RELAY_PROFILE, and with neither set the wrapper uses "headless".
     The secret is already in there; DSH_RELAY_SECRET in the process
     environment - and in ~/.hermes/.env, the Hermes half's own env file - is
     only a fallback the file wins over.
  2. Restart the Hermes gateway when convenient so it loads
     ~/.hermes/plugins/dsh-discord-relay.  This script did not touch it.
  3. Start relayed sessions through the wrapper, which picks up that profile:
         $ $REPO/bin/dsh-relay "your task"
  4. Sanity check from any shell:
         curl -s http://127.0.0.1:$PORT/v1/health
     -> {"ok":true,"pending":0,...}  means a dsh process is serving questions.
EOF
