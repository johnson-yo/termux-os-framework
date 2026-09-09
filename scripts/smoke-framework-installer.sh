#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: The local public export and an isolated temporary Framework home.
# [OUTPUT]: A pass/fail smoke for fresh install, legacy cross-domain upgrade, state preservation, and uninstall.
# [POS]: scripts/smoke-framework-installer.sh in termux-os-framework.
# [PROTOCOL]: Keep destructive test paths inside the temporary workspace.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRAMEWORK_VERSION="$(node -p "require('./package.json').version" 2>/dev/null)"
WORK="${SMOKE_KEEP_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/framework-installer-smoke.XXXXXX")}"
HOME_FAKE="$WORK/home"
RUNTIME="$HOME_FAKE/.termux-os/framework"
PERSIST="$WORK/persist"
CONTROL="$HOME_FAKE/framework.sh"
ARCHIVE="$WORK/framework-source.tar.gz"
LEGACY_ARCHIVE="$WORK/framework-legacy-source.tar.gz"
PORT=$((24500 + $$ % 1000))
BASE="http://127.0.0.1:$PORT"
PASS=0
FAIL=0

ok() { echo "PASS $*"; PASS=$((PASS + 1)); }
bad() { echo "FAIL $*"; FAIL=$((FAIL + 1)); }
run_installer() {
  HOME="$HOME_FAKE" FRAMEWORK_RUNTIME="$RUNTIME" FRAMEWORK_PERSIST="$PERSIST" \
    FRAMEWORK_CONTROL="$CONTROL" FRAMEWORK_CONFIG="$PERSIST/conf/framework.v1.json" \
    FRAMEWORK_AUTH_FILE="$HOME_FAKE/.termux-os/secrets/framework-auth.v1.json" \
    FRAMEWORK_PORT="$PORT" FRAMEWORK_BASE_URL="$BASE" FRAMEWORK_ASSET_ROOT="$WORK/models" \
    PACKAGES_INSTALLED_DIR="$WORK/packages" FRAMEWORK_WORK_ROOT="$WORK/work" \
    bash "$@"
}
run_installer_without_signal_permission() {
  (
    kill() { return 1; }
    export -f kill
    run_installer "$@"
  )
}
cleanup() {
  if [ -f "$CONTROL" ]; then
    HOME="$HOME_FAKE" FRAMEWORK_RUNTIME="$RUNTIME" FRAMEWORK_PERSIST="$PERSIST" \
      FRAMEWORK_CONTROL="$CONTROL" FRAMEWORK_CONFIG="$PERSIST/conf/framework.v1.json" \
      FRAMEWORK_AUTH_FILE="$HOME_FAKE/.termux-os/secrets/framework-auth.v1.json" \
      FRAMEWORK_PORT="$PORT" FRAMEWORK_BASE_URL="$BASE" bash "$CONTROL" stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

npm run public:export >/dev/null
mkdir -p "$WORK/source"
cp -a "$ROOT/tmp/public-tree" "$WORK/source/framework"
tar -czf "$ARCHIVE" -C "$WORK/source" framework
SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"

# Reproduce the exact upgrade trap fixed by this release: the live Core has no
# authenticated shutdown route, and its installed controller has no handoff.
# The candidate installer must gain control before asking that legacy runtime
# to stop; otherwise a cross-domain signal denial makes it uninstallable.
mkdir -p "$WORK/legacy-source"
cp -a "$ROOT/tmp/public-tree" "$WORK/legacy-source/framework"
node - "$WORK/legacy-source/framework/scripts/framework.sh" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
fs.writeFileSync(file, `#!/bin/sh
if [ -z "\${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then exec bash "$0" "$@"; fi
  exit 127
fi
set -u
RUNTIME="\${FRAMEWORK_RUNTIME:-$HOME/.termux-os/framework}"
PERSIST="\${FRAMEWORK_PERSIST:-/sdcard/termux-os/framework}"
CONF="\${FRAMEWORK_CONFIG:-$PERSIST/conf/framework.v1.json}"
AUTH_FILE="\${FRAMEWORK_AUTH_FILE:-$HOME/.termux-os/secrets/framework-auth.v1.json}"
PORT="\${FRAMEWORK_PORT:-8980}"
BASE="\${FRAMEWORK_BASE_URL:-http://127.0.0.1:$PORT}"
PIDFILE="$RUNTIME/framework.pid"
LOGFILE="$RUNTIME/framework.log"
port_up() { curl -sf -m 2 "$BASE/health" >/dev/null 2>&1; }
cmd_bootstrap() { mkdir -p "$RUNTIME" "$PERSIST/conf" "$PERSIST/backups" "$PERSIST/history"; }
cmd_start() {
  port_up && return 1
  cd "$RUNTIME" || return 1
  HOST="\${FRAMEWORK_HOST:-}" PORT="$PORT" CONFIG="$CONF" FRAMEWORK_RUNTIME="$RUNTIME" \\
    FRAMEWORK_PERSIST="$PERSIST" FRAMEWORK_CONFIG="$CONF" FRAMEWORK_PORT="$PORT" \\
    FRAMEWORK_BASE_URL="$BASE" FRAMEWORK_AUTH_FILE="$AUTH_FILE" \\
    PACKAGES_INSTALLED_DIR="\${PACKAGES_INSTALLED_DIR:-$HOME/.termux-os/packages}" \\
    STAGE_DESIRED_PATH="$PERSIST/conf/stage.v1.json" \\
    nohup node src/server.mjs >"$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 60); do port_up && return 0; sleep 0.1; done
  return 1
}
cmd_stop() {
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
  for _ in $(seq 1 30); do port_up || { rm -f "$PIDFILE"; return 0; }; sleep 0.1; done
  return 1
}
cmd_restart() { cmd_stop && cmd_start; }
cmd_health() { port_up; }
case "\${1:-}" in
  bootstrap|start|stop|restart|health) "cmd_$1" ;;
  *) exit 1 ;;
esac
`);
fs.chmodSync(file, 0o700);
NODE
node - "$WORK/legacy-source/framework/src/server.mjs" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const needle = "url === '/api/admin/shutdown'";
if (!source.includes(needle)) throw new Error('shutdown route fixture anchor is missing');
fs.writeFileSync(file, source.replace(needle, "url === '/api/admin/legacy-shutdown'"));
NODE
tar -czf "$LEGACY_ARCHIVE" -C "$WORK/legacy-source" framework
LEGACY_SHA256="$(sha256sum "$LEGACY_ARCHIVE" | awk '{print $1}')"

echo "=== Framework installer smoke (isolated) ==="
if run_installer "$ROOT/scripts/install.sh" --archive "$ARCHIVE" --version "v$FRAMEWORK_VERSION" --sha256 "$SHA256" >/dev/null 2>&1; then
  bad "leading-v Framework version is rejected"
else
  ok "leading-v Framework version is rejected"
fi
run_installer "$ROOT/scripts/install.sh" --archive "$LEGACY_ARCHIVE" --version "$FRAMEWORK_VERSION" --sha256 "$LEGACY_SHA256"
if curl -sf "$BASE/health" >/dev/null; then ok "fresh install starts and is healthy"; else bad "fresh install health"; fi
LEGACY_SHUTDOWN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $(node -p "require('$HOME_FAKE/.termux-os/secrets/framework-auth.v1.json').admin_token")" \
  "$BASE/api/admin/shutdown")"
if [ "$LEGACY_SHUTDOWN_CODE" != 202 ]; then
  ok "legacy fixture has no authenticated shutdown route"
else
  bad "legacy fixture shutdown route returned $LEGACY_SHUTDOWN_CODE"
fi

mkdir -p "$RUNTIME/.runtime/observations" "$PERSIST/conf" "$PERSIST/data" "$WORK/packages" "$WORK/models"
printf '{"schema":"termux-os.observations.v1","observations":[{"id":"installer-sentinel"}]}\n' > "$RUNTIME/.runtime/observations/observations.v1.json"
printf 'runtime-log\n' > "$RUNTIME/framework.log"
printf 'configuration\n' > "$PERSIST/conf/user.conf"
printf 'persistent-data\n' > "$PERSIST/data/user.txt"
printf 'package-state\n' > "$WORK/packages/active.json"
printf 'model-state\n' > "$WORK/models/model.marker"
OBS_SHA="$(sha256sum "$RUNTIME/.runtime/observations/observations.v1.json" | awk '{print $1}')"

if run_installer_without_signal_permission "$ROOT/scripts/upgrade.sh" \
  --archive "$ARCHIVE" --version "$FRAMEWORK_VERSION" --sha256 "$SHA256" --force; then
  ok "upgrade succeeds without cross-domain signal permission"
else
  bad "upgrade succeeds without cross-domain signal permission"
fi
if cmp -s "$CONTROL" "$ROOT/tmp/public-tree/scripts/framework.sh"; then
  ok "candidate controller replaces the legacy controller before future updates"
else
  bad "candidate controller was not retained"
fi
if [ "$(sha256sum "$RUNTIME/.runtime/observations/observations.v1.json" | awk '{print $1}')" = "$OBS_SHA" ] \
  && [ -f "$PERSIST/conf/user.conf" ] && [ -f "$PERSIST/data/user.txt" ] \
  && [ -f "$WORK/packages/active.json" ] && [ -f "$WORK/models/model.marker" ]; then
  ok "upgrade preserves runtime and persistent boundaries"
else
  bad "upgrade preserves runtime and persistent boundaries"
fi

run_installer "$ROOT/scripts/uninstall.sh" --yes
if [ ! -e "$RUNTIME" ] && [ ! -e "$CONTROL" ] && [ -f "$PERSIST/conf/user.conf" ] \
  && [ -f "$PERSIST/data/user.txt" ] && [ -f "$WORK/packages/active.json" ] && [ -f "$WORK/models/model.marker" ]; then
  ok "uninstall removes runtime but preserves user boundaries"
else
  bad "uninstall boundary"
fi

printf '\nPASS=%s FAIL=%s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
