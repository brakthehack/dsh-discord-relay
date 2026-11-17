#!/usr/bin/env bash
# Install both halves of the dsh -> Discord question relay.
#
#   1. config:      ~/.config/dsh-discord-relay/config.json (600) is the ONE
#                   personal config file both halves read; ids arrive here as
#                   one-time installer arguments and live in the FILE from then on
#   2. dsh side:    plugin add into EVERY profile that can host a session
#                   (default: every directory under $DSH_HOME/profiles), because
#                   a question asked from a profile without the bundle would be
#                   silently unanswered. Pass a list to narrow it (see --profiles)
#   3. Hermes side: copy the relay plugin into ~/.hermes/plugins
#   4. secret:      written into the config file; DSH_RELAY_SECRET in the
#                   process environment (and in ~/.hermes/.env, the Hermes
#                   half's own env file) stays a fallback the file overrides
#
# Idempotent: re-running updates the Hermes half and re-adds only the profiles
# missing the bundle. Prints the secret nowhere. Never restarts or signals any
# process. --uninstall removes the bundle from the profile set and the Hermes
# plugin directory, and leaves the personal config file alone.
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE="$REPO/dsh-relay-bundle"
HERMES_PLUGINS="$HOME/.hermes/plugins"
RELAY_TARGET="$HERMES_PLUGINS/dsh-discord-relay"
HERMES_ENV="$HOME/.hermes/.env"
# Where dsh keeps its profiles; overridable so the installer can be tested.
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILES_DIR="${DSH_RELAY_PROFILES_DIR:-$DSH_HOME_DIR/profiles}"

USAGE='usage: install.sh [--profiles a,b | PROFILE] [--port N] [--uninstall] [--dry-run]
       PROFILE / --profiles defaults to every existing profile in '"$PROFILES_DIR"'.
       env overrides: DSH_RELAY_PROFILE(S), DSH_RELAY_PORT, DSH_RELAY_DRY_RUN=1'

# Positional back-compat: arg 1 was the single profile, arg 2 the port.
POSITIONAL=()
UNINSTALL=0
PORT_SET=0
PORT="${DSH_RELAY_PORT:-8790}"
PROFILES="${DSH_RELAY_PROFILES:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --profiles) PROFILES="${2:-}"; shift 2 ;;
    --profiles=*) PROFILES="${1#*=}"; shift ;;
    --port) PORT="${2:-$PORT}"; PORT_SET=1; shift 2 ;;
    --port=*) PORT="${1#*=}"; PORT_SET=1; shift ;;
    --uninstall|--remove) UNINSTALL=1; shift ;;
    --dry-run|-n) DSH_RELAY_DRY_RUN=1; shift ;;
    -h|--help) printf '%s\n' "$USAGE"; exit 0 ;;
    --*) printf 'install: unknown option: %s\n%s\n' "$1" "$USAGE" >&2; exit 1 ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
if [ -z "$PROFILES" ] && [ ${#POSITIONAL[@]} -gt 0 ]; then
  PROFILES="${POSITIONAL[0]}"
  [ "$PORT_SET" -eq 0 ] && [ -n "${POSITIONAL[1]:-}" ] && PORT="${POSITIONAL[1]}"
fi

DRY="${DSH_RELAY_DRY_RUN:-0}"
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

[ -d "$BUNDLE/src" ] || die "bundle not found at $BUNDLE"
command -v dsh >/dev/null 2>&1 || die "dsh not on PATH"

# --- profile set ------------------------------------------------------------
# One profile cannot cover a machine: the app launches the profiles it launched,
# terminal jobs use others, and the bundle is per profile. Missing profiles
# are created by `dsh plugin add` itself; profiles that do not exist yet are
# still installed into when named, so a later session start finds the relay.
split_profiles() { # comma/space separated -> one per line, trimmed, deduped
  printf '%s\n' "${1//,/ }" | tr ' ' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
    | awk 'NF && !seen[$0]++'
}

discover_profiles() {
  [ -d "$PROFILES_DIR" ] || return 0
  find "$PROFILES_DIR" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null \
    | sed "s|.*/||" | sort
}

PROFILE_LIST=""
if [ -n "$PROFILES" ]; then
  PROFILE_LIST="$(split_profiles "$PROFILES")"
else
  PROFILE_LIST="$(discover_profiles)"
  if [ -z "$PROFILE_LIST" ]; then
    PROFILE_LIST="headless"
    printf 'install: no profiles under %s yet; installing "headless" (dsh creates it on demand)\n' "$PROFILES_DIR" >&2
  fi
fi

printf 'dsh-discord-relay %s\n' "$([ "$UNINSTALL" -eq 1 ] && echo uninstall || echo install)"
printf '  dsh profiles: %s\n' "$(printf '%s ' $PROFILE_LIST)"

profile_has_bundle() { # best-effort read of a profile manifest
  local manifest="$PROFILES_DIR/$1/package.json"
  [ -f "$manifest" ] || return 1
  grep -q 'dsh-relay-bundle' "$manifest"
}

# --- uninstall --------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  for profile in $PROFILE_LIST; do
    if [ "$DRY" = "1" ]; then
      printf '  [dry-run] dsh plugin --profile %s remove dsh-relay-bundle\n' "$profile"
      continue
    fi
    if dsh plugin --profile "$profile" remove dsh-relay-bundle >/dev/null 2>&1; then
      printf '  dsh profile %s: dsh-relay-bundle removed\n' "$profile"
    else
      printf '  dsh profile %s: nothing to remove (or dsh declined); continuing\n' "$profile"
    fi
  done
  if [ "$DRY" = "1" ]; then
    printf '  [dry-run] rm -rf %s\n' "$RELAY_TARGET"
  elif [ -e "$RELAY_TARGET" ]; then
    rm -rf "$RELAY_TARGET"
    printf '  hermes plugin removed: %s\n' "$RELAY_TARGET"
  fi
  printf '\nLeft in place on purpose (your data): %s and %s\n' \
    "$HOME/.config/dsh-discord-relay/config.json" "$HERMES_ENV"
  printf 'Restart the Hermes gateway and any running dsh session to pick this up.\n'
  exit 0
fi

# --- env file helpers -------------------------------------------------------
env_get() { # env_get <file> <key>
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -1
}

env_put() { # env_put <file> <key> <value>   (append when absent)
  local file="$1" key="$2" value="$3"
  if [ "$DRY" = "1" ]; then
    printf '  [dry-run] would ensure %s in %s\n' "$key" "$file"
    return 0
  fi
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
SECRET="$(env_get "$HERMES_ENV" DSH_RELAY_SECRET)"
if [ -z "$SECRET" ]; then
  if [ "$DRY" = "1" ]; then
    SECRET="<dry-run>"
    printf '  [dry-run] would generate a DSH_RELAY_SECRET\n'
  else
    SECRET="$(openssl rand -hex 24)"
    printf '  generated a new DSH_RELAY_SECRET\n'
  fi
else
  printf '  reusing the existing DSH_RELAY_SECRET\n'
fi
if [ "$DRY" != "1" ]; then umask 077; fi
env_put "$HERMES_ENV" DSH_RELAY_SECRET "$SECRET"
[ "$DRY" = "1" ] || chmod 600 "$HERMES_ENV"

# --- 1b. the personal config file (the ONE source of truth; never committed) --
# channelId/ownerId are this machine's operator ids and belong in the FILE, not
# in the environment or in code. install.sh takes them as one-time installer
# arguments (env DSH_BLOCKERS_CHANNEL / DSH_RELAY_OWNER), writes them in, and
# from then on only the file is read. An existing file is never rewritten. The
# first installed profile is recorded as the optional "dshProfile" key that
# bin/dsh-relay reads back.
CONFIG_DIR="$HOME/.config/dsh-discord-relay"
CONFIG_FILE="$CONFIG_DIR/config.json"
CHANNEL_ID="${DSH_BLOCKERS_CHANNEL:-}"
OWNER_ID="${DSH_RELAY_OWNER:-}"
FIRST_PROFILE="$(printf '%s\n' "$PROFILE_LIST" | head -1)"
if [ "$DRY" = "1" ]; then
  [ -f "$CONFIG_FILE" ] \
    && printf '  [dry-run] would keep %s\n' "$CONFIG_FILE" \
    || printf '  [dry-run] would write %s (chmod 600)\n' "$CONFIG_FILE"
elif [ -f "$CONFIG_FILE" ]; then
  printf '  keeping existing %s (edit ids, port, profiles or secret there)\n' "$CONFIG_FILE"
else
  mkdir -p "$CONFIG_DIR"
  {
    printf '{\n'
    printf '  "secret": "%s",\n' "$SECRET"
    printf '  "dshProfile": "%s",\n' "$FIRST_PROFILE"
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
if [ "$DRY" != "1" ]; then
  grep -q '"channelId"' "$CONFIG_FILE" \
    || printf '  NOTE %s has no channelId - the relay stays disabled until you add one\n' "$CONFIG_FILE" >&2
  grep -q '"ownerId"' "$CONFIG_FILE" \
    || printf '  NOTE %s has no ownerId - the relay stays disabled until you add one\n' "$CONFIG_FILE" >&2
fi

# --- 2. dsh side (every profile that could host a session) -------------------
# Each profile is independent: a failure in one is reported and the rest still
# get the bundle, because "some sessions can be answered" is exactly the
# half-coverage this installer is here to remove.
FAILED=""
SKIPPED=""
for profile in $PROFILE_LIST; do
  if [ "$DRY" = "1" ]; then
    profile_has_bundle "$profile" \
      && printf '  [dry-run] dsh profile %s: already has the bundle\n' "$profile" \
      || printf '  [dry-run] dsh plugin --profile %s add file:%s\n' "$profile" "$BUNDLE"
    continue
  fi
  if profile_has_bundle "$profile"; then
    printf '  dsh profile %s: dsh-relay-bundle already installed\n' "$profile"
    continue
  fi
  log="$(mktemp -t dsh-relay-install)"
  if dsh plugin --profile "$profile" add "file:$BUNDLE" >"$log" 2>&1; then
    printf '  dsh profile %s: dsh-relay-bundle installed\n' "$profile"
  else
    printf '  dsh profile %s: FAILED\n' "$profile" >&2
    sed -n '1,8p' "$log" >&2
    FAILED="$FAILED $profile"
  fi
  rm -f "$log"
done
[ -z "$FAILED" ] || die "dsh plugin add failed for:$FAILED (every other profile is installed)"

# --- 3. Hermes side ---------------------------------------------------------
if [ "$DRY" = "1" ]; then
  printf '  [dry-run] would copy hermes-relay/ to %s\n' "$RELAY_TARGET"
else
  mkdir -p "$HERMES_PLUGINS"
  rm -rf "$RELAY_TARGET.tmp"
  mkdir -p "$RELAY_TARGET.tmp"
  cp "$REPO"/hermes-relay/__init__.py "$REPO"/hermes-relay/relay_core.py \
     "$REPO"/hermes-relay/plugin.yaml "$REPO"/hermes-relay/dev_main.py "$RELAY_TARGET.tmp/"
  rm -rf "$RELAY_TARGET"
  mv "$RELAY_TARGET.tmp" "$RELAY_TARGET"
  printf '  hermes plugin: %s\n' "$RELAY_TARGET"
fi

cat <<EOF

Next steps (owner):
  1. Personal settings live in ONE file (chmod 600, read by BOTH halves):
         ~/.config/dsh-discord-relay/config.json
     "channelId" = the channel you want questions delivered to, "ownerId" = the
     only user allowed to answer (Discord developer mode -> right-click -> Copy
     ID). If install.sh reported one missing, add it yourself - ids are never
     guessed for you. "dshProfile" = $FIRST_PROFILE: a profile the bundle went
     into, which bin/dsh-relay launches - that key wins over DSH_RELAY_PROFILE,
     and with neither set the wrapper uses "headless". The other installed
     profiles ($([ -n "$PROFILE_LIST" ] && printf '%s ' $PROFILE_LIST)) get the
     same relay without the wrapper, whenever dsh starts them.
     "port" is the BASE of a window ($PORT..$((PORT + 19))): every dsh process
     binds the first free port in it and the poller walks the window, so
     concurrent sessions each deliver. "portSpan" (default 20) sizes it.
     The secret is already in there; DSH_RELAY_SECRET in the process
     environment - and in ~/.hermes/.env, the Hermes half's own env file - is
     only a fallback the file wins over.
  2. Restart the Hermes gateway when convenient so it loads
     ~/.hermes/plugins/dsh-discord-relay.  This script did not touch it.
  3. Restart any dsh session that was already running: a profile that only just
     got the bundle serves questions from its next start.
  4. Start relayed sessions through the wrapper, which picks up that profile:
         $ $REPO/bin/dsh-relay "your task"
  5. Sanity check from any shell (one line per live dsh process):
         for p in \$(seq $PORT $((PORT + 19))); do curl -s --max-time 1 http://127.0.0.1:\$p/v1/health; done
      -> {"ok":true,"relay":"dsh-bridge","protocol":1,...}  means a bridge there
     is serving questions; anything else on a port is not one of ours.
EOF
