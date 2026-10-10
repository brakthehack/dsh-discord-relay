#!/usr/bin/env bash
# Gate: the installer covers EVERY profile it can find, is idempotent, and
# reverses cleanly. Runs in a scratch HOME against a stub `dsh` that mutates
# profile manifests the way the real one does - the real ~/.dsh, ~/.hermes and
# ~/.config are never touched.
# Run: bash tests/install_stub.sh
set -u
REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
S="$(mktemp -d "${TMPDIR:-/tmp}/dsh-relay-install.XXXXXX")"
trap 'rm -rf "$S"' EXIT
fail() { printf 'INSTALL-STUB-FAIL %s\n' "$1" >&2; exit 1; }

mkdir -p "$S/home/.dsh/profiles/alpha" "$S/home/.dsh/profiles/beta" "$S/bin"
for p in alpha beta; do
  printf '{"name":"dsh-profile-%s","dsh":{"profile":{"bundles":[]}}}\n' "$p" \
    > "$S/home/.dsh/profiles/$p/package.json"
done
cat > "$S/bin/dsh" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = plugin ] || { printf 'stub dsh: %s\n' "$*"; exit 0; }
profile='' action='' pkg=''
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile="${2:-}"; shift 2 ;;
    add|remove) action="$1"; shift ;;
    *) pkg="$1"; shift ;;
  esac
done
manifest="$HOME/.dsh/profiles/$profile/package.json"
[ -f "$manifest" ] || { echo "stub dsh: no profile $profile" >&2; exit 1; }
case "$action" in
  add) node -e 'const f=process.argv[1],n="dsh-relay-bundle";const j=JSON.parse(require("fs").readFileSync(f,"utf8"));const b=(((j.dsh||{}).profile)||{}).bundles||[];j.dsh=j.dsh||{};j.dsh.profile=j.dsh.profile||{};j.dsh.profile.bundles=b.includes(n)?b:b.concat(n);require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$manifest" ;;
  remove) grep -q dsh-relay-bundle "$manifest" || exit 1
    node -e 'const f=process.argv[1];const j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.dsh.profile.bundles=(j.dsh.profile.bundles||[]).filter(x=>x!=="dsh-relay-bundle");require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$manifest" ;;
esac
STUB
chmod +x "$S/bin/dsh"

run_install() {
  HOME="$S/home" PATH="$S/bin:$PATH" \
    DSH_RELAY_PROFILES_DIR="$S/home/.dsh/profiles" \
    DSH_BLOCKERS_CHANNEL=111111111111111111 DSH_RELAY_OWNER=222222222222222222 \
    DSH_RELAY_PORT=8790 \
    "$REPO/install.sh" "$@" >"$S/out.$PHASE" 2>&1
  printf 'rc %s\n' "$?" >> "$S/out.$PHASE"
}

has() { grep -q 'dsh-relay-bundle' "$S/home/.dsh/profiles/$1/package.json"; }
count() { grep -o 'dsh-relay-bundle' "$S/home/.dsh/profiles/$1/package.json" | wc -l | tr -d ' '; }

PHASE=install
run_install; rc=$(tail -1 "$S/out.install" | awk '{print $2}')
[ "$rc" = 0 ] || fail "install rc=$rc: $(tail -6 "$S/out.install")"
has alpha && has beta || fail "discovery missed a profile: $(cat "$S/out.install")"
grep -q 'profiles: alpha beta' "$S/out.install" || fail "default profile list is not everything discovered"
[ -f "$S/home/.config/dsh-discord-relay/config.json" ] || fail "no config file written"
mode="$(node -e 'process.stdout.write(((require("fs").statSync(process.argv[1]).mode)&0o777).toString(8))' \
  "$S/home/.config/dsh-discord-relay/config.json" 2>&1)"
[ "$mode" = 600 ] || fail "config file mode is [$mode], not 600"
grep -q '"port": 8790' "$S/home/.config/dsh-discord-relay/config.json" \
  || fail "DSH_RELAY_PORT did not reach the config file"

PHASE=again
run_install; rc=$(tail -1 "$S/out.again" | awk '{print $2}')
[ "$rc" = 0 ] || fail "second install rc=$rc"
[ "$(count alpha)" = 1 ] && [ "$(count beta)" = 1 ] || fail "not idempotent: alpha=$(count alpha) beta=$(count beta)"
grep -q 'already installed' "$S/out.again" || fail "second install did not recognise the existing bundle"

PHASE=uninstall
run_install --uninstall; rc=$(tail -1 "$S/out.uninstall" | awk '{print $2}')
[ "$rc" = 0 ] || fail "uninstall rc=$rc"
has alpha && fail "uninstall left the bundle in alpha"
has beta && fail "uninstall left the bundle in beta"
[ -d "$S/home/.hermes/plugins/dsh-discord-relay" ] && fail "uninstall left the hermes plugin in place"
[ -f "$S/home/.config/dsh-discord-relay/config.json" ] || fail "uninstall deleted the operator's config file"

PHASE=named
run_install --profiles alpha; rc=$(tail -1 "$S/out.named" | awk '{print $2}')
[ "$rc" = 0 ] || fail "--profiles rc=$rc"
has alpha || fail "--profiles alpha did not install alpha"
has beta && fail "--profiles alpha also touched beta"
run_install --uninstall --profiles alpha >/dev/null 2>&1 || fail "targeted uninstall failed"

printf 'installer: discovered 2 profiles, skipped a repeat, reversed cleanly, --profiles respected\n'
printf 'all install_stub checks passed\n'
