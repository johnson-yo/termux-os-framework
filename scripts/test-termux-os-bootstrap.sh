#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: The Framework source tree and temporary command fixtures.
# [OUTPUT]: Syntax, security-boundary, lock, and fixed-path smoke checks for termux-os-bootstrap.
# [POS]: scripts/test-termux-os-bootstrap.sh in termux-os-framework.
# [PROTOCOL]: Keep the smoke fixture bounded and independent of a device or package runtime.

set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BOOT="$ROOT/scripts/termux-os-bootstrap.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

bash -n "$BOOT"
grep -q 'FIXED_PORT=34202' "$BOOT"
grep -q 'SSHD_PORT=8022' "$BOOT"
grep -q 'FRAMEWORK_BASE_URL=.*8980' "$BOOT"
grep -q 'FLOCK_BIN.*-n\|flock.*-n' "$BOOT"
grep -q 'adb.*tcpip' "$BOOT"
grep -q 'adb-wireless-debugging/enable' "$BOOT"
grep -q 'adb-wireless-debugging/disable' "$BOOT"
grep -q 'RECOVERY_RETRY_WAIT_SECONDS=20' "$BOOT"
grep -q 'RECOVERY_WIRELESS_SETTLE_SECONDS=3' "$BOOT"
grep -q 'RECOVERY_ROUNDS=3' "$BOOT"
grep -q 'log_adb_round' "$BOOT"
grep -q 'rearm_wireless' "$BOOT"
! grep -q 'wireless_enabled' "$BOOT"
grep -q 'rearm_disable_requested' "$BOOT"
grep -q 'rearm_enable_requested' "$BOOT"
grep -q 'LAST_ADB_ROUND_RESULT=rearm_failed' "$BOOT"
! grep -Eq 'cached_port|save_port|adb-port' "$BOOT"
# The adb build on the target answers `mdns services` with "unknown host service",
# so the path could never yield a candidate, yet it cost 3s of the round budget on a
# cold adb server.  Keep it deleted.
! grep -qi 'mdns' "$BOOT"
# A cold `adb start-server` costs ~3.05s against a 3s per-call cap, so the one-time
# daemon start must happen outside run_with_timeout or every probe after a boot dies.
grep -q 'ensure_adb_server' "$BOOT"
grep -q 'ADB_SERVER_START_SECONDS=15' "$BOOT"
grep -q 'start-server' "$BOOT"
! grep -q 'run_with_timeout .*start-server' "$BOOT"
grep -q 'SCAN_FIRST_PORT=.*32768' "$BOOT"
grep -q 'SCAN_LAST_PORT=.*60999' "$BOOT"
SSHD_CALL="$(grep -n '^if ensure_sshd' "$BOOT" | cut -d: -f1)"
FRAMEWORK_CALL="$(grep -n '^if ! ensure_framework' "$BOOT" | cut -d: -f1)"
ADB_CALL="$(grep -n '^if adb_fast_path' "$BOOT" | tail -n 1 | cut -d: -f1)"
[ "$SSHD_CALL" -lt "$FRAMEWORK_CALL" ]
[ "$FRAMEWORK_CALL" -lt "$ADB_CALL" ]
if grep -Eq 'sudo|setprop|stop adbd|start adbd|8765|5555|termux-speech|hf-model-manager|npu-top' "$BOOT"; then
  echo "bootstrap contains a forbidden root/legacy/business-service path" >&2
  exit 1
fi

mkdir -p "$TMP/bin" "$TMP/h"
printf '%s\n' '#!/bin/sh' 'case "$*" in' '  *get-state*) printf "device\\n" ;;' 'esac' 'exit 0' >"$TMP/bin/adb"
printf '%s\n' '#!/bin/sh' 'case "$*" in' '  *health*) exit 0 ;;' 'esac' 'exit 0' >"$TMP/bin/curl"
printf '%s\n' '#!/bin/sh' 'if [ "${2:-}" = "127.0.0.1" ] && [ "${3:-}" = "8022" ]; then exit 0; fi' 'exit 1' >"$TMP/bin/python3"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$TMP/bin/sshd"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$TMP/h/framework.sh"
chmod 755 "$TMP/bin/adb" "$TMP/bin/curl" "$TMP/bin/python3" "$TMP/bin/sshd" "$TMP/h/framework.sh"

env \
  HOME="$TMP/h" \
  PREFIX=/usr \
  ADB_BIN="$TMP/bin/adb" \
  CURL_BIN="$TMP/bin/curl" \
  PYTHON_BIN="$TMP/bin/python3" \
  SSHD_BIN="$TMP/bin/sshd" \
  TIMEOUT_BIN="$(command -v timeout)" \
  FLOCK_BIN="$(command -v flock)" \
  FRAMEWORK_CONTROL="$TMP/h/framework.sh" \
  "$BOOT"

grep -q 'stage=adb_server result=ready' "$TMP/h/.termux-os/bootstrap/termux-os-bootstrap.log"
grep -q 'stage=adb_fast_path result=ready' "$TMP/h/.termux-os/bootstrap/termux-os-bootstrap.log"
grep -q 'stage=framework_health result=healthy' "$TMP/h/.termux-os/bootstrap/termux-os-bootstrap.log"
grep -q 'stage=overall result=success' "$TMP/h/.termux-os/bootstrap/termux-os-bootstrap.log"
! grep -q 'stage=adb_recovery' "$TMP/h/.termux-os/bootstrap/termux-os-bootstrap.log"

exec 8>"$TMP/h/.termux-os/bootstrap/termux-os-bootstrap.lock"
flock -n 8
env HOME="$TMP/h" PREFIX=/usr ADB_BIN="$TMP/bin/adb" CURL_BIN="$TMP/bin/curl" \
  PYTHON_BIN="$TMP/bin/python3" SSHD_BIN="$TMP/bin/sshd" \
  TIMEOUT_BIN="$(command -v timeout)" FLOCK_BIN="$(command -v flock)" \
  FRAMEWORK_CONTROL="$TMP/h/framework.sh" "$BOOT"
echo "PASS termux-os-bootstrap contract/fast-path/lock smoke"

mkdir -p "$TMP/retry/bin" "$TMP/retry/h"
printf '%s\n' '#!/bin/sh' 'case "$*" in' '  *get-state*) printf "offline\\n" ;;' 'esac' 'exit 1' >"$TMP/retry/bin/adb"
printf '%s\n' '#!/bin/sh' 'case "$*" in *--config*) cfg=$(cat) ;; *) cfg="$*" ;; esac' 'printf "%s\\n" "$cfg" >>"$CURL_LOG"' 'case "$cfg" in' '  *\/health*) exit 0 ;;' '  *adb-wireless-debugging*) echo '\''{"data":{"adb_wifi_enabled":true}}'\'' ;;' 'esac' 'exit 0' >"$TMP/retry/bin/curl"
printf '%s\n' '#!/bin/sh' 'if [ "${1:-}" = "-c" ]; then exec /usr/bin/python3 "$@"; fi' 'exit 1' >"$TMP/retry/bin/python3"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$TMP/retry/bin/sshd"
printf '%s\n' '#!/bin/sh' 'printf "%s\\n" "$*" >>"$SLEEP_LOG"; exit 0' >"$TMP/retry/bin/sleep"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$TMP/retry/h/framework.sh"
chmod 755 "$TMP/retry/bin/adb" "$TMP/retry/bin/curl" "$TMP/retry/bin/python3" \
  "$TMP/retry/bin/sshd" "$TMP/retry/bin/sleep" "$TMP/retry/h/framework.sh"
printf '%s\n' 'fixture-token' >"$TMP/retry/token"
SLEEP_LOG="$TMP/retry/sleep.log"
export SLEEP_LOG
CURL_LOG="$TMP/retry/curl.log"
export CURL_LOG
env \
  HOME="$TMP/retry/h" \
  PREFIX="$TMP/retry" \
  PATH="$TMP/retry/bin:$PATH" \
  ADB_BIN="$TMP/retry/bin/adb" \
  CURL_BIN="$TMP/retry/bin/curl" \
  PYTHON_BIN="$TMP/retry/bin/python3" \
  SSHD_BIN="$TMP/retry/bin/sshd" \
  TIMEOUT_BIN="$(command -v timeout)" \
  FLOCK_BIN="$(command -v flock)" \
  FRAMEWORK_CONTROL="$TMP/retry/h/framework.sh" \
  TERMUX_OS_APP_TOKEN_FILE="$TMP/retry/token" \
  TERMUX_OS_BOOTSTRAP_SCAN_SECONDS=0 \
  "$BOOT"

RETRY_LOG="$TMP/retry/h/.termux-os/bootstrap/termux-os-bootstrap.log"
[ "$(grep -c 'stage=adb_recovery round=.* result=started' "$RETRY_LOG")" -eq 3 ]
[ "$(grep -c 'stage=adb_recovery round=.* result=no_candidate' "$RETRY_LOG")" -eq 3 ]
[ "$(grep -c 'stage=adb_recovery round=.* result=retry_wait wait_s=20' "$RETRY_LOG")" -eq 2 ]
! grep -q 'stage=adb_recovery round=3 result=retry_wait' "$RETRY_LOG"
[ "$(grep -c 'stage=adb_recovery round=.* result=rearm_disable_requested' "$RETRY_LOG")" -eq 3 ]
[ "$(grep -c 'stage=adb_recovery round=.* result=rearm_enable_requested' "$RETRY_LOG")" -eq 3 ]
[ "$(grep -c 'request = "POST"' "$CURL_LOG")" -eq 6 ]
[ "$(grep -c '^20$' "$SLEEP_LOG")" -eq 2 ]
[ "$(grep -c '^3$' "$SLEEP_LOG")" -eq 3 ]
[ "$(grep -c '^0.5$' "$SLEEP_LOG")" -eq 22 ]
grep -q 'stage=sshd result=degraded' "$RETRY_LOG"
grep -q 'stage=framework_health result=healthy' "$RETRY_LOG"
grep -q 'stage=overall result=degraded' "$RETRY_LOG"
echo "PASS termux-os-bootstrap retry/order/degraded contract"

mkdir -p "$TMP/round2/bin" "$TMP/round2/h"
printf '%s\n' \
  '#!/bin/sh' \
  'case "$*" in' \
  '  *get-state*)' \
  '    case "$*" in' \
  '      *127.0.0.1:34202*) [ -f "$FIXTURE_ROOT/fixed" ] && { printf "device\n"; exit 0; } ;;' \
  '      *127.0.0.1:33001*) [ -f "$FIXTURE_ROOT/candidate" ] && { printf "device\n"; exit 0; } ;;' \
  '    esac' \
  '    printf "offline\n"; exit 1 ;;' \
  '  *"tcpip 34202"*) : >"$FIXTURE_ROOT/fixed"; exit 0 ;;' \
  '  *"shell true"*) exit 0 ;;' \
  '  *connect*) exit 0 ;;' \
  'esac' \
  'exit 1' >"$TMP/round2/bin/adb"
printf '%s\n' \
  '#!/bin/sh' \
  'case "$*" in *health*) exit 0 ;; esac' \
  'case "$*" in *--config*) cfg=$(cat) ;; *) cfg="$*" ;; esac' \
  'printf "%s\n" "$cfg" >>"$CURL_LOG"' \
  'case "$cfg" in' \
  '  *"/adb-wireless-debugging/disable"*) exit 0 ;;' \
  '  *"/adb-wireless-debugging/enable"*)' \
  '    n=0; [ -r "$FIXTURE_ROOT/enables" ] && n=$(cat "$FIXTURE_ROOT/enables"); n=$((n + 1)); printf "%s\n" "$n" >"$FIXTURE_ROOT/enables"' \
  '    if [ "$RECOVERY_MODE" = round2 ] && [ "$n" -ge 2 ]; then : >"$FIXTURE_ROOT/candidate"; fi' \
  '    if [ "$FAIL_FIRST_ENABLE" = 1 ] && [ "$n" -eq 1 ]; then exit 1; fi' \
  '    exit 0 ;;' \
  '  *adb-wireless-debugging*) printf '\''{"data":{"adb_wifi_enabled":false}}\n'\'' ;;' \
  'esac' \
  'exit 0' >"$TMP/round2/bin/curl"
printf '%s\n' \
  '#!/bin/sh' \
  'if [ "$1" = "-c" ]; then exec /usr/bin/python3 "$@"; fi' \
  'if [ "$3" = "8022" ]; then exit 0; fi' \
  '[ -f "$FIXTURE_ROOT/candidate" ] && printf "PORT 33001 12\n"' \
  'printf "END 60999 28232 900 exhausted\n"' \
  'exit 0' >"$TMP/round2/bin/python3"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$TMP/round2/bin/sshd"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$*" >>"$SLEEP_LOG"; exit 0' >"$TMP/round2/bin/sleep"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$TMP/round2/h/framework.sh"
chmod 755 "$TMP/round2/bin/adb" "$TMP/round2/bin/curl" "$TMP/round2/bin/python3" \
  "$TMP/round2/bin/sshd" "$TMP/round2/bin/sleep" "$TMP/round2/h/framework.sh"
printf '%s\n' 'fixture-token' >"$TMP/round2/token"
env \
  HOME="$TMP/round2/h" \
  PREFIX="$TMP/round2" \
  PATH="$TMP/round2/bin:$PATH" \
  ADB_BIN="$TMP/round2/bin/adb" \
  CURL_BIN="$TMP/round2/bin/curl" \
  PYTHON_BIN="$TMP/round2/bin/python3" \
  SSHD_BIN="$TMP/round2/bin/sshd" \
  TIMEOUT_BIN="$(command -v timeout)" \
  FLOCK_BIN="$(command -v flock)" \
  FRAMEWORK_CONTROL="$TMP/round2/h/framework.sh" \
  TERMUX_OS_APP_TOKEN_FILE="$TMP/round2/token" \
  TERMUX_OS_BOOTSTRAP_SCAN_SECONDS=1 \
  FIXTURE_ROOT="$TMP/round2" \
  RECOVERY_MODE=round2 \
  FAIL_FIRST_ENABLE=1 \
  CURL_LOG="$TMP/round2/curl.log" \
  SLEEP_LOG="$TMP/round2/sleep.log" \
  "$BOOT"

ROUND2_LOG="$TMP/round2/h/.termux-os/bootstrap/termux-os-bootstrap.log"
[ "$(grep -c 'stage=adb_recovery round=.* result=started' "$ROUND2_LOG")" -eq 2 ]
[ "$(grep -c 'stage=adb_recovery round=.* result=rearm_disable_requested' "$ROUND2_LOG")" -eq 2 ]
[ "$(grep -c 'stage=adb_recovery round=.* result=rearm_enable_requested' "$ROUND2_LOG")" -eq 2 ]
[ "$(grep -c 'stage=adb_recovery round=1 result=rearm_enable_failed' "$ROUND2_LOG")" -eq 1 ]
[ "$(grep -c 'stage=adb_recovery round=2 result=ready' "$ROUND2_LOG")" -eq 1 ]
[ "$(grep -c 'stage=adb_recovery round=.* result=retry_wait wait_s=20' "$ROUND2_LOG")" -eq 1 ]
! grep -q 'stage=adb_recovery round=3 result=started' "$ROUND2_LOG"
[ "$(grep -c 'request = "POST"' "$TMP/round2/curl.log")" -eq 5 ]
[ "$(grep -c '^20$' "$TMP/round2/sleep.log")" -eq 1 ]
[ "$(grep -c '^3$' "$TMP/round2/sleep.log")" -eq 1 ]
[ "$(grep -c '^0.5$' "$TMP/round2/sleep.log")" -eq 3 ]
grep -q 'stage=adb_repair result=ready' "$ROUND2_LOG"
grep -q 'stage=overall result=success' "$ROUND2_LOG"
grep -q 'result=scan_begin first=32768 last=60999 budget_s=' "$ROUND2_LOG"
grep -q 'result=scan_open port=33001 at_ms=12' "$ROUND2_LOG"
echo "PASS termux-os-bootstrap round2-recovery/enable-failure contract"

# ---------------------------------------------------------------------------
# A sweep that completes without a candidate must say how far it got: a port
# above the range and a deadline both end as "no_candidate" otherwise.
# ---------------------------------------------------------------------------
mkdir -p "$TMP/scan/bin" "$TMP/scan/h"
printf '%s\n' '#!/bin/sh' 'case "$*" in' '  *get-state*) printf "offline\n"; exit 1 ;;' 'esac' 'exit 1' >"$TMP/scan/bin/adb"
printf '%s\n' '#!/bin/sh' 'case "$*" in *health*) exit 0 ;; *--config*) cat >/dev/null ;; esac' 'exit 0' >"$TMP/scan/bin/curl"
printf '%s\n' '#!/bin/sh' 'if [ "$1" = "-c" ]; then exec /usr/bin/python3 "$@"; fi' 'if [ "$3" = "8022" ]; then exit 0; fi' 'printf "END 60999 28232 4870 exhausted\n"' 'exit 0' >"$TMP/scan/bin/python3"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$TMP/scan/bin/sshd"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$TMP/scan/bin/sleep"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$TMP/scan/h/framework.sh"
chmod 755 "$TMP/scan/bin/adb" "$TMP/scan/bin/curl" "$TMP/scan/bin/python3" \
  "$TMP/scan/bin/sshd" "$TMP/scan/bin/sleep" "$TMP/scan/h/framework.sh"
printf '%s\n' 'fixture-token' >"$TMP/scan/token"
env \
  HOME="$TMP/scan/h" \
  PREFIX="$TMP/scan" \
  PATH="$TMP/scan/bin:$PATH" \
  ADB_BIN="$TMP/scan/bin/adb" \
  CURL_BIN="$TMP/scan/bin/curl" \
  PYTHON_BIN="$TMP/scan/bin/python3" \
  SSHD_BIN="$TMP/scan/bin/sshd" \
  TIMEOUT_BIN="$(command -v timeout)" \
  FLOCK_BIN="$(command -v flock)" \
  FRAMEWORK_CONTROL="$TMP/scan/h/framework.sh" \
  TERMUX_OS_APP_TOKEN_FILE="$TMP/scan/token" \
  TERMUX_OS_BOOTSTRAP_SCAN_SECONDS=1 \
  "$BOOT"
SCAN_LOG="$TMP/scan/h/.termux-os/bootstrap/termux-os-bootstrap.log"
[ "$(grep -c 'result=scan_begin first=32768 last=60999 budget_s=1' "$SCAN_LOG")" -eq 3 ]
[ "$(grep -c 'result=scan_end reached_port=60999 ports_scanned=28232 stop=exhausted elapsed_ms=4870' "$SCAN_LOG")" -eq 3 ]
[ "$(grep -c 'result=no_candidate' "$SCAN_LOG")" -eq 3 ]
grep -q 'stage=boot_session result=opened boot_epoch=' "$SCAN_LOG"
grep -q 'scan_first=32768 scan_last=60999 scan_budget_s=1' "$SCAN_LOG"
echo "PASS termux-os-bootstrap scan-geometry contract"

# ---------------------------------------------------------------------------
# Per-boot log retention: one file per boot, newest two kept, stable symlink.
# ---------------------------------------------------------------------------
# The lock smoke above still holds fd 8; every later run under this HOME would
# exit on lock contention instead of exercising retention.
exec 8>&-
BOOTDIR="$TMP/h/.termux-os/bootstrap"
[ -L "$BOOTDIR/termux-os-bootstrap.log" ]
[ "$(ls -1 "$BOOTDIR"/boot-*.log | wc -l)" -eq 1 ]
CURRENT="$(readlink "$BOOTDIR/termux-os-bootstrap.log")"
[ "$(basename "$CURRENT")" = "$(basename "$(ls -1 "$BOOTDIR"/boot-*.log)")" ]

# A second run inside the same boot must append, never open a new file.
env HOME="$TMP/h" PREFIX=/usr ADB_BIN="$TMP/bin/adb" CURL_BIN="$TMP/bin/curl" \
  PYTHON_BIN="$TMP/bin/python3" SSHD_BIN="$TMP/bin/sshd" \
  TIMEOUT_BIN="$(command -v timeout)" FLOCK_BIN="$(command -v flock)" \
  FRAMEWORK_CONTROL="$TMP/h/framework.sh" "$BOOT"
[ "$(ls -1 "$BOOTDIR"/boot-*.log | wc -l)" -eq 1 ]
[ "$(grep -c 'stage=boot_session result=opened' "$BOOTDIR/termux-os-bootstrap.log")" -eq 2 ]

# The real shape: two boots already on disk and a third boot arriving.  Pruning must
# count the log this run is about to open, or the oldest survives and the directory
# settles at three.  The earlier fixture pre-created a third file and so never
# exercised this.
rm -f "$BOOTDIR"/boot-*.log
: >"$BOOTDIR/boot-1000000000.log"
: >"$BOOTDIR/boot-1000000001.log"
env HOME="$TMP/h" PREFIX=/usr ADB_BIN="$TMP/bin/adb" CURL_BIN="$TMP/bin/curl" \
  PYTHON_BIN="$TMP/bin/python3" SSHD_BIN="$TMP/bin/sshd" \
  TIMEOUT_BIN="$(command -v timeout)" FLOCK_BIN="$(command -v flock)" \
  FRAMEWORK_CONTROL="$TMP/h/framework.sh" "$BOOT"
[ "$(ls -1 "$BOOTDIR"/boot-*.log | wc -l)" -eq 2 ]
[ ! -f "$BOOTDIR/boot-1000000000.log" ]
[ -f "$BOOTDIR/boot-1000000001.log" ]
[ -s "$(readlink "$BOOTDIR/termux-os-bootstrap.log")" ]

# Older boots are evicted down to BOOT_LOGS_KEPT=2, newest first.
: >"$BOOTDIR/boot-1000000000.log"
: >"$BOOTDIR/boot-1000000001.log"
env HOME="$TMP/h" PREFIX=/usr ADB_BIN="$TMP/bin/adb" CURL_BIN="$TMP/bin/curl" \
  PYTHON_BIN="$TMP/bin/python3" SSHD_BIN="$TMP/bin/sshd" \
  TIMEOUT_BIN="$(command -v timeout)" FLOCK_BIN="$(command -v flock)" \
  FRAMEWORK_CONTROL="$TMP/h/framework.sh" "$BOOT"
[ "$(ls -1 "$BOOTDIR"/boot-*.log | wc -l)" -eq 2 ]
[ ! -f "$BOOTDIR/boot-1000000000.log" ]
[ -f "$BOOTDIR/boot-1000000001.log" ]

# A pre-rotation regular file is preserved outside the boot-*.log namespace.
rm -rf "$TMP/legacy"; mkdir -p "$TMP/legacy/h/.termux-os/bootstrap"
printf 'old-history\n' >"$TMP/legacy/h/.termux-os/bootstrap/termux-os-bootstrap.log"
cp "$TMP/h/framework.sh" "$TMP/legacy/h/framework.sh"
env HOME="$TMP/legacy/h" PREFIX=/usr ADB_BIN="$TMP/bin/adb" CURL_BIN="$TMP/bin/curl" \
  PYTHON_BIN="$TMP/bin/python3" SSHD_BIN="$TMP/bin/sshd" \
  TIMEOUT_BIN="$(command -v timeout)" FLOCK_BIN="$(command -v flock)" \
  FRAMEWORK_CONTROL="$TMP/legacy/h/framework.sh" "$BOOT"
grep -q 'old-history' "$TMP/legacy/h/.termux-os/bootstrap/termux-os-bootstrap.log.legacy"
[ -L "$TMP/legacy/h/.termux-os/bootstrap/termux-os-bootstrap.log" ]
echo "PASS termux-os-bootstrap per-boot log retention"
