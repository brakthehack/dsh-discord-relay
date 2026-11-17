#!/usr/bin/env bash
# End-to-end proof for the relay coverage fix, runnable by anyone with dsh
# installed. It never touches a live profile, the live relay config, or the
# running gateway: everything happens in a scratch $DSH_HOME with dummy ids.
#
# What it proves, by execution:
#   1. coverage    — a profile that never had the relay (built from the shipped
#                    `headless` default) loads dsh-relay-bundle and binds a bridge.
#   2. repair      — the ask omits `questions[0].id`, the argument shape schema
#                    validation used to reject outright.
#   3. concurrency — two bridges in two processes ask at once; ONE poller sweeps
#                    the port window and each answer goes back to its own port.
# What it cannot prove: the Discord leg (needs the operator's bot token and
# channel) and a model choosing to call the tool (needs provider credentials,
# which a test lane has no business holding). Both are named in the report.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/dsh-relay-e2e.XXXXXX")"
export DSH_HOME="$SCRATCH/home"
export DSH_RELAY_CONFIG="$SCRATCH/relay.json"
export DSH_RELAY_E2E_DONE="$SCRATCH/done"
PORT="${DSH_RELAY_E2E_PORT:-8890}"
PROFILE=relay-e2e
rc_probe=1
rc_bridge=1
rc_poller=1
cleanup() {
  [ -n "${poller_pid:-}" ] && kill "$poller_pid" 2>/dev/null
  [ -n "${bridge_pid:-}" ] && kill "$bridge_pid" 2>/dev/null
  wait 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

printf '%s\n' "{\"channelId\":\"111111111111111111\",\"ownerId\":\"222222222222222222\",\"secret\":\"e2e-secret-please-ignore\",\"port\":$PORT,\"portSpan\":4}" >"$DSH_RELAY_CONFIG"
chmod 600 "$DSH_RELAY_CONFIG"

step() { printf '\n=== %s\n' "$*"; }
tail_it() { sed -e 's/^/  | /' "$1" | tail -n "${2:-14}"; }

step "build a scratch profile from the shipped headless default"
mkdir -p "$DSH_HOME/profiles"
dsh --profile "$PROFILE" --from-default-profile headless --dump-config >"$SCRATCH/create.log" 2>&1
echo "profile created: rc=$?"

step "install the relay bundle into it (the same command install.sh runs)"
dsh plugin --profile "$PROFILE" add "file:$REPO/dsh-relay-bundle" >"$SCRATCH/add-relay.log" 2>&1
rc_add=$?
echo "dsh plugin add dsh-relay-bundle: rc=$rc_add"
[ "$rc_add" -eq 0 ] || tail_it "$SCRATCH/add-relay.log" 8

step "install the ask probe (test fixture, never shipped by install.sh)"
dsh plugin --profile "$PROFILE" add "file:$REPO/tests/e2e-probe-bundle" >"$SCRATCH/add-probe.log" 2>&1
rc_add2=$?
echo "dsh plugin add dsh-relay-e2e-probe: rc=$rc_add2"
[ "$rc_add2" -eq 0 ] || tail_it "$SCRATCH/add-probe.log" 8

if [ "$rc_add" -ne 0 ] || [ "$rc_add2" -ne 0 ]; then
  echo "E2E-BLOCKED: the bundle could not be installed into a fresh profile"
  exit 1
fi

step "start a second bridge in its own process (concurrency partner)"
node "$REPO/tests/e2e_second_bridge.mjs" >"$SCRATCH/bridge2.log" 2>&1 &
bridge_pid=$!

step "start the poller (the Hermes half, minus Discord)"
python3 "$REPO/tests/e2e_poller.py" >"$SCRATCH/poller.log" 2>&1 &
poller_pid=$!

step "boot the profile: the probe asks, the poller answers"
dsh --profile "$PROFILE" headless "e2e proof: the probe plugin asks one question" \
  >"$SCRATCH/dsh.log" 2>&1
rc_dsh=$?
echo "dsh --profile $PROFILE headless: rc=$rc_dsh"

wait "$bridge_pid"; rc_bridge=$?
wait "$poller_pid"; rc_poller=$?

step "dsh side (probe + relay bridge)"
tail_it "$SCRATCH/dsh.log" 30
step "second bridge"
tail_it "$SCRATCH/bridge2.log" 6
step "poller (bridge-visible pending JSON)"
tail_it "$SCRATCH/poller.log" 14

probes=$(grep -c "PROBE-OK" "$SCRATCH/dsh.log" "$SCRATCH/bridge2.log" "$SCRATCH/poller.log" 2>/dev/null | awk -F: '{ s += $2 } END { print s + 0 }')
pending=$(grep -c "PENDING bridge=" "$SCRATCH/poller.log" 2>/dev/null || echo 0)
live=$(grep -o "live bridges seen: \[[^]]*\]" "$SCRATCH/poller.log" | tail -1)

step "verdict"
printf 'dsh rc=%s  bridge2 rc=%s  poller rc=%s  PROBE-OK=%s  PENDING=%s  %s\n' \
  "$rc_dsh" "$rc_bridge" "$rc_poller" "$probes" "$pending" "$live"
if [ "$rc_bridge" -eq 0 ] && [ "$rc_poller" -eq 0 ] && [ "$probes" -ge 3 ] && [ "$pending" -ge 1 ]; then
  echo "E2E-PASS one poller, two bridges, both questions answered on their own port"
  exit 0
fi
echo "E2E-FAIL see the tails above (the dsh rc may be a credential error: the"
echo "model leg needs a real API key; the probe's own PROBE-OK line is what matters)"
exit 1
