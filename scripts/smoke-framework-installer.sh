#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: The local public export and an isolated temporary Framework home.
# [OUTPUT]: A pass/fail smoke for fresh install, same-version replacement, state preservation, and uninstall.
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

echo "=== Framework installer smoke (isolated) ==="
if run_installer "$ROOT/scripts/install.sh" --archive "$ARCHIVE" --version "v$FRAMEWORK_VERSION" --sha256 "$SHA256" >/dev/null 2>&1; then
  bad "leading-v Framework version is rejected"
else
  ok "leading-v Framework version is rejected"
fi
run_installer "$ROOT/scripts/install.sh" --archive "$ARCHIVE" --version "$FRAMEWORK_VERSION" --sha256 "$SHA256"
if curl -sf "$BASE/health" >/dev/null; then ok "fresh install starts and is healthy"; else bad "fresh install health"; fi

mkdir -p "$RUNTIME/.runtime/observations" "$PERSIST/conf" "$PERSIST/data" "$WORK/packages" "$WORK/models"
printf '{"schema":"termux-os.observations.v1","observations":[{"id":"installer-sentinel"}]}\n' > "$RUNTIME/.runtime/observations/observations.v1.json"
printf 'runtime-log\n' > "$RUNTIME/framework.log"
printf 'configuration\n' > "$PERSIST/conf/user.conf"
printf 'persistent-data\n' > "$PERSIST/data/user.txt"
printf 'package-state\n' > "$WORK/packages/active.json"
printf 'model-state\n' > "$WORK/models/model.marker"
OBS_SHA="$(sha256sum "$RUNTIME/.runtime/observations/observations.v1.json" | awk '{print $1}')"

run_installer "$ROOT/scripts/upgrade.sh" --archive "$ARCHIVE" --version "$FRAMEWORK_VERSION" --sha256 "$SHA256" --force
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
