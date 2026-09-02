#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Termux login environment, the installed Framework controller, the current App token file,
#           and loopback ADB/SSHD endpoints.
# [OUTPUT]: One bounded, idempotent recovery run: SSHD and Framework recovery first, then bounded ADB recovery
#           that rediscovers adbd's TLS port by sweeping the kernel ephemeral range, appended to a per-boot log
#           (boot-<epoch>.log, newest two kept) reachable at the stable symlink.
# [POS]: scripts/termux-os-bootstrap.sh in termux-os-framework; the only boot bridge called by Termux .bashrc.
# [PROTOCOL]: Keep this English header synchronized with the runtime path, lock, recovery order, retry contract,
#           scan range, and the per-boot log retention.

# Android Termux does not provide /usr/bin/env.  Keep the file directly executable
# from .bashrc while retaining Bash for the implementation below.
if [ -z "${BASH_VERSION:-}" ]; then
  if [ -n "${PREFIX:-}" ] && [ -x "$PREFIX/bin/bash" ]; then
    exec "$PREFIX/bin/bash" "$0" "$@"
  fi
  if [ -n "${HOME:-}" ] && [ -x "${HOME%/files/home}/files/usr/bin/bash" ]; then
    exec "${HOME%/files/home}/files/usr/bin/bash" "$0" "$@"
  fi
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  exit 127
fi

set -u

TERMUX_PREFIX="${PREFIX:-}"
if [ -z "$TERMUX_PREFIX" ] && [ -n "${HOME:-}" ]; then
  case "$HOME" in
    */files/home) TERMUX_PREFIX="${HOME%/files/home}/files/usr" ;;
  esac
fi

export PATH="$TERMUX_PREFIX/bin:${PATH:-/system/bin:/system/xbin}"

ADB_BIN="${ADB_BIN:-$TERMUX_PREFIX/bin/adb}"
CURL_BIN="${CURL_BIN:-$TERMUX_PREFIX/bin/curl}"
PYTHON_BIN="${PYTHON_BIN:-$TERMUX_PREFIX/bin/python3}"
SSHD_BIN="${SSHD_BIN:-$TERMUX_PREFIX/bin/sshd}"
TIMEOUT_BIN="${TIMEOUT_BIN:-$TERMUX_PREFIX/bin/timeout}"
FLOCK_BIN="${FLOCK_BIN:-$TERMUX_PREFIX/bin/flock}"

STATE_DIR="${TERMUX_OS_BOOTSTRAP_STATE_DIR:-$HOME/.termux-os/bootstrap}"
LOG_LINK="$STATE_DIR/termux-os-bootstrap.log"
LOCK_FILE="$STATE_DIR/termux-os-bootstrap.lock"
# One log per boot, newest BOOT_LOGS_KEPT retained.  `uptime -s` is derived from
# `now - uptime` and jitters by one second across samples, so an existing log
# within BOOT_MATCH_TOLERANCE_SECONDS is treated as the same boot; without the
# tolerance a single boot would spawn several files and silently evict history.
BOOT_LOGS_KEPT=2
BOOT_MATCH_TOLERANCE_SECONDS=5
APP_TOKEN_FILE="${TERMUX_OS_APP_TOKEN_FILE:-/sdcard/termux-os/app-token}"
APP_BASE_URL="${TERMUX_OS_APP_BASE_URL:-http://127.0.0.1:8796}"
FRAMEWORK_BASE_URL="${TERMUX_OS_FRAMEWORK_BASE_URL:-http://127.0.0.1:8980}"
FRAMEWORK_CONTROL="${FRAMEWORK_CONTROL:-$HOME/framework.sh}"
FIXED_PORT=34202
FIXED_SERIAL="127.0.0.1:$FIXED_PORT"
SSHD_PORT=8022
# adbd's TLS port is an ordinary ephemeral port, so the sweep must cover exactly the
# kernel's range: /proc/sys/net/ipv4/ip_local_port_range reads 32768-60999 on the
# target, and is not readable by the Termux user, so the Linux default is hardcoded.
# Scanning below 32768 can never hit, and stopping at 49999 left 11000 ports (39% of
# the range) permanently undiscoverable.
SCAN_FIRST_PORT="${TERMUX_OS_BOOTSTRAP_SCAN_FIRST_PORT:-32768}"
SCAN_LAST_PORT="${TERMUX_OS_BOOTSTRAP_SCAN_LAST_PORT:-60999}"
# A full sweep measures 6.0s idle and about 10.6s under boot-time load, and each
# non-adb listener the sweep trips over costs up to three `timeout 3` probes.
RECOVERY_SCAN_SECONDS="${TERMUX_OS_BOOTSTRAP_SCAN_SECONDS:-20}"
RECOVERY_WIRELESS_SETTLE_SECONDS=3
RECOVERY_RETRY_WAIT_SECONDS=20
RECOVERY_ROUNDS=3
ADB_SERVER_START_SECONDS=15

now_ms() {
  date +%s%3N 2>/dev/null || printf '%s000\n' "$(date +%s)"
}

now_s() { date +%s 2>/dev/null || printf '0\n'; }

timestamp() { date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || date; }

mkdir -p "$STATE_DIR" 2>/dev/null || exit 1

boot_epoch() {
  local booted
  booted="$(uptime -s 2>/dev/null)" || return 1
  [ -n "$booted" ] || return 1
  date -d "$booted" +%s 2>/dev/null
}

boot_log_epochs() {
  ls -1 "$STATE_DIR"/boot-*.log 2>/dev/null \
    | sed -e 's|.*/boot-||' -e 's|\.log$||' \
    | grep -E '^[0-9]+$' \
    | sort -n
}

select_boot_log() {
  local newest delta
  BOOT_EPOCH="$(boot_epoch)" || BOOT_EPOCH=''
  case "$BOOT_EPOCH" in ''|*[!0-9]*) BOOT_EPOCH=0 ;; esac
  newest="$(boot_log_epochs | tail -n 1)"
  if [ -n "$newest" ] && [ "$BOOT_EPOCH" -gt 0 ]; then
    delta=$(( BOOT_EPOCH - newest ))
    [ "$delta" -lt 0 ] && delta=$(( -delta ))
    if [ "$delta" -le "$BOOT_MATCH_TOLERANCE_SECONDS" ]; then
      BOOT_EPOCH="$newest"
    fi
  fi
  LOG_FILE="$STATE_DIR/boot-$BOOT_EPOCH.log"
}

prune_boot_logs() {
  local epoch
  boot_log_epochs | sort -rn | tail -n +"$(( BOOT_LOGS_KEPT + 1 ))" | while IFS= read -r epoch; do
    [ -n "$epoch" ] && rm -f "$STATE_DIR/boot-$epoch.log" 2>/dev/null || true
  done
}

select_boot_log
# A pre-rotation deployment leaves a real file at the stable path.  Move it out of
# the boot-*.log namespace instead of deleting it, so pruning never counts it and
# no recorded history is lost when the scheme changes underneath a live device.
if [ -f "$LOG_LINK" ] && [ ! -L "$LOG_LINK" ]; then
  mv -f "$LOG_LINK" "$STATE_DIR/termux-os-bootstrap.log.legacy" 2>/dev/null || true
fi
# Create this boot's log before pruning: retention keeps the newest BOOT_LOGS_KEPT,
# and computing that over a set which does not yet contain the newest one leaves the
# oldest in place and settles at BOOT_LOGS_KEPT + 1 files.
# Create this boot's log before pruning: retention keeps the newest BOOT_LOGS_KEPT,
# and computing that over a set which does not yet contain the newest one leaves the
# oldest in place and settles at BOOT_LOGS_KEPT + 1 files.
: >>"$LOG_FILE" 2>/dev/null || true
prune_boot_logs
ln -sfn "$LOG_FILE" "$LOG_LINK" 2>/dev/null || true

[ -x "$FLOCK_BIN" ] || exit 1
exec 9>"$LOCK_FILE" || exit 1
if ! "$FLOCK_BIN" -n 9; then
  exit 0
fi

RUN_ID="$(date +%s 2>/dev/null || printf '0')-$$"
RUN_STARTED="$(now_ms)"

log() {
  printf 'timestamp=%s run_id=%s stage=%s result=%s elapsed_ms=%s error_code=%s\n' \
    "$(timestamp)" "$RUN_ID" "$1" "$2" "${3:-0}" "${4:-0}" >>"$LOG_FILE"
}

log_adb_round() {
  printf 'timestamp=%s run_id=%s stage=adb_recovery round=%s result=%s elapsed_ms=%s error_code=%s\n' \
    "$(timestamp)" "$RUN_ID" "$1" "$2" "${3:-0}" "${4:-0}" >>"$LOG_FILE"
}

# Free-form trailing fields; the fixed-width loggers above cannot carry the scan
# geometry, and a run that only records "no_candidate" cannot be retraced later.
log_adb_detail() {
  printf 'timestamp=%s run_id=%s stage=adb_recovery round=%s result=%s %s\n' \
    "$(timestamp)" "$RUN_ID" "$1" "$2" "$3" >>"$LOG_FILE"
}

log_adb_retry_wait() {
  printf 'timestamp=%s run_id=%s stage=adb_recovery round=%s result=retry_wait wait_s=%s elapsed_ms=0 error_code=0\n' \
    "$(timestamp)" "$RUN_ID" "$1" "$RECOVERY_RETRY_WAIT_SECONDS" >>"$LOG_FILE"
}

stage_start() {
  STAGE="$1"
  STAGE_STARTED="$(now_ms)"
}

stage_end() {
  local elapsed
  elapsed=$(( $(now_ms) - STAGE_STARTED ))
  log "$STAGE" "$1" "$elapsed" "${2:-0}"
}

log boot started 0 0
printf 'timestamp=%s run_id=%s stage=boot_session result=opened boot_epoch=%s boot_time=%s log_file=%s scan_first=%s scan_last=%s scan_budget_s=%s settle_s=%s rounds=%s retry_wait_s=%s elapsed_ms=0 error_code=0\n' \
  "$(timestamp)" "$RUN_ID" "$BOOT_EPOCH" \
  "$(date -d "@$BOOT_EPOCH" '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || printf 'unknown')" \
  "$LOG_FILE" "$SCAN_FIRST_PORT" "$SCAN_LAST_PORT" "$RECOVERY_SCAN_SECONDS" \
  "$RECOVERY_WIRELESS_SETTLE_SECONDS" "$RECOVERY_ROUNDS" "$RECOVERY_RETRY_WAIT_SECONDS" >>"$LOG_FILE"

command_path() {
  [ -x "$1" ] && printf '%s\n' "$1" && return 0
  command -v "$2" 2>/dev/null || true
}

ADB_BIN="$(command_path "$ADB_BIN" adb)"
CURL_BIN="$(command_path "$CURL_BIN" curl)"
PYTHON_BIN="$(command_path "$PYTHON_BIN" python3)"
SSHD_BIN="$(command_path "$SSHD_BIN" sshd)"
TIMEOUT_BIN="$(command_path "$TIMEOUT_BIN" timeout)"

run_with_timeout() {
  if [ -x "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" 3 "$@"
  else
    "$@"
  fi
}

read_app_token() {
  [ -r "$APP_TOKEN_FILE" ] || return 1
  local token
  token="$(tr -d '\r\n' < "$APP_TOKEN_FILE" 2>/dev/null || true)"
  [ -n "$token" ] || return 1
  printf '%s' "$token"
}

# curl --config - keeps the Authorization value out of argv and out of bootstrap logs.
app_request() {
  local method="$1" path="$2" token
  token="$(read_app_token)" || return 1
  [ -x "$CURL_BIN" ] || return 1
  if [ "$method" = GET ]; then
    "$CURL_BIN" --silent --show-error --fail --max-time 4 --config - 2>/dev/null <<EOF
url = "$APP_BASE_URL$path"
header = "Authorization: Bearer $token"
EOF
  else
    "$CURL_BIN" --silent --show-error --fail --max-time 4 --config - 2>/dev/null <<EOF
url = "$APP_BASE_URL$path"
request = "POST"
header = "Authorization: Bearer $token"
header = "Content-Type: application/json"
data = "{}"
EOF
  fi
}

adb_run() { run_with_timeout "$ADB_BIN" "$@"; }

adb_probe() {
  local serial="$1" state
  [ -x "$ADB_BIN" ] || return 1
  adb_run connect "$serial" >/dev/null 2>&1 || true
  state="$(adb_run -s "$serial" get-state 2>/dev/null || true)"
  [ "$state" = device ] || return 1
  adb_run -s "$serial" shell true >/dev/null 2>&1
}

valid_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null
}

try_port() {
  local port="$1"
  valid_port "$port" || return 1
  if adb_probe "127.0.0.1:$port"; then
    DISCOVERED_SERIAL="127.0.0.1:$port"
    DISCOVERED_PORT="$port"
    return 0
  fi
  return 1
}

scan_ports() {
  local seconds="$1"
  [ -x "$PYTHON_BIN" ] || return 0
  "$PYTHON_BIN" - "$seconds" "$SCAN_FIRST_PORT" "$SCAN_LAST_PORT" <<'PY'
import os
import socket
import sys
import time

seconds = max(0.0, float(sys.argv[1]))
first = int(sys.argv[2])
last = int(sys.argv[3])
started = time.monotonic()
deadline = started + seconds


def sweep():
    reached = first - 1
    scanned = 0
    reason = "exhausted"
    for port in range(first, last + 1):
        if time.monotonic() >= deadline:
            reason = "deadline"
            break
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(min(0.02, max(0.001, deadline - time.monotonic())))
        try:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                print("PORT %d %d" % (port, int((time.monotonic() - started) * 1000)), flush=True)
        except OSError:
            pass
        finally:
            sock.close()
        reached = port
        scanned += 1
    # How far the sweep actually got is the fact a later reader needs: a miss caused
    # by a port above the range and one caused by the deadline are otherwise identical.
    print("END %d %d %d %s" % (reached, scanned, int((time.monotonic() - started) * 1000), reason), flush=True)


try:
    sweep()
except BrokenPipeError:
    # The reader stops at the first accepted candidate, so a closed pipe is the
    # normal success path.  Retarget stdout before exit or the interpreter prints
    # a second failure while flushing, on every Termux login.
    os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
PY
}

discover_temp_adb() {
  local deadline="$1" round="$2" port remaining line
  remaining=$(( deadline - $(now_s) ))
  log_adb_detail "$round" scan_begin \
    "first=$SCAN_FIRST_PORT last=$SCAN_LAST_PORT budget_s=$remaining elapsed_ms=0 error_code=0"
  [ "$remaining" -gt 0 ] || return 1
  while IFS= read -r line; do
    case "$line" in
      PORT\ *)
        port="${line#PORT }"; port="${port%% *}"
        log_adb_detail "$round" scan_open "port=$port at_ms=${line##* } elapsed_ms=0 error_code=0"
        [ "$(now_s)" -lt "$deadline" ] || return 1
        try_port "$port" && return 0
        log_adb_detail "$round" candidate_rejected "port=$port source=scan elapsed_ms=0 error_code=16"
        ;;
      END\ *)
        set -- $line
        log_adb_detail "$round" scan_end \
          "reached_port=$2 ports_scanned=$3 stop=$5 elapsed_ms=$4 error_code=0"
        ;;
    esac
  done < <(scan_ports "$remaining")
  return 1
}

rearm_wireless() {
  local round="$1" round_started="$2"
  log_adb_round "$round" rearm_disable_requested "$(( $(now_ms) - round_started ))" 0
  if ! app_request POST /api/android/adb-wireless-debugging/disable >/dev/null; then
    log_adb_round "$round" rearm_disable_failed "$(( $(now_ms) - round_started ))" 12
    return 1
  fi
  sleep 0.5
  log_adb_round "$round" rearm_enable_requested "$(( $(now_ms) - round_started ))" 0
  if ! app_request POST /api/android/adb-wireless-debugging/enable >/dev/null; then
    log_adb_round "$round" rearm_enable_failed "$(( $(now_ms) - round_started ))" 13
    return 1
  fi
  sleep 0.5
}

wait_fixed() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    adb_probe "$FIXED_SERIAL" && return 0
    sleep 0.5
  done
  return 1
}

# A cold `adb start-server` measures 3.04-3.05s on the target while run_with_timeout
# caps every adb call at 3s, so the first probe after a boot is killed mid-start and
# leaves the daemon cold for the next one: each candidate then burns 3s and is
# rejected, including the real adbd port.  The margin is negative, not tight, so this
# never succeeds by luck.  Pay the one-time start once, outside that cap.
ensure_adb_server() {
  [ -x "$ADB_BIN" ] || return 1
  local rc=0
  stage_start adb_server
  if [ -x "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "$ADB_SERVER_START_SECONDS" "$ADB_BIN" start-server >/dev/null 2>&1 || rc=$?
  else
    "$ADB_BIN" start-server >/dev/null 2>&1 || rc=$?
  fi
  if [ "$rc" = 0 ]; then
    stage_end ready 0
    return 0
  fi
  stage_end degraded 19
  return 1
}

adb_fast_path() {
  ensure_adb_server || true
  stage_start adb_fast_path
  if adb_probe "$FIXED_SERIAL"; then
    stage_end ready 0
    return 0
  fi
  stage_end unavailable 10
  return 1
}

adb_recovery_round() {
  local round="$1" round_started deadline temp status
  LAST_ADB_ROUND_RESULT=started
  round_started="$(now_ms)"
  log_adb_round "$round" started 0 0
  if adb_probe "$FIXED_SERIAL"; then
    log_adb_round "$round" fixed_ready "$(( $(now_ms) - round_started ))" 0
    return 0
  fi
  if ! rearm_wireless "$round" "$round_started"; then
    LAST_ADB_ROUND_RESULT=rearm_failed
    return 1
  fi
  sleep "$RECOVERY_WIRELESS_SETTLE_SECONDS"
  deadline=$(( $(now_s) + RECOVERY_SCAN_SECONDS ))
  if ! discover_temp_adb "$deadline" "$round"; then
    LAST_ADB_ROUND_RESULT=no_candidate
    log_adb_round "$round" no_candidate "$(( $(now_ms) - round_started ))" 13
    return 1
  fi
  temp="$DISCOVERED_SERIAL"
  if ! adb_run -s "$temp" tcpip "$FIXED_PORT" >/dev/null 2>&1; then
    log_adb_round "$round" tcpip_failed "$(( $(now_ms) - round_started ))" 14
    return 1
  fi
  if ! wait_fixed; then
    log_adb_round "$round" fixed_unavailable "$(( $(now_ms) - round_started ))" 15
    return 1
  fi
  if ! app_request POST /api/android/adb-wireless-debugging/disable >/dev/null; then
    log_adb_round "$round" disable_failed "$(( $(now_ms) - round_started ))" 16
    return 1
  fi
  status="$(app_request GET /api/android/adb-wireless-debugging \
    | "$PYTHON_BIN" -c 'import json,sys; d=json.load(sys.stdin); print("1" if d.get("data",{}).get("adb_wifi_enabled") else "0")' \
    2>/dev/null || true)"
  if [ "$status" != 0 ] || ! adb_probe "$FIXED_SERIAL"; then
    log_adb_round "$round" disable_invalid "$(( $(now_ms) - round_started ))" 17
    return 1
  fi
  log_adb_round "$round" ready "$(( $(now_ms) - round_started ))" 0
  return 0
}

adb_repair() {
  local round
  stage_start adb_repair
  [ -x "$ADB_BIN" ] || { stage_end degraded 11; return 1; }
  for round in 1 2 3; do
    if adb_recovery_round "$round"; then
      stage_end ready 0
      return 0
    fi
    if [ "$round" -lt "$RECOVERY_ROUNDS" ]; then
      log_adb_retry_wait "$round"
      sleep "$RECOVERY_RETRY_WAIT_SECONDS"
    fi
  done
  stage_end degraded 18
  return 1
}

tcp_probe() {
  [ -x "$PYTHON_BIN" ] || return 1
  "$PYTHON_BIN" - "$1" "$2" <<'PY' >/dev/null 2>&1
import socket
import sys

sock = socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=1.0)
sock.close()
PY
}

ensure_sshd() {
  local attempt
  stage_start sshd
  if tcp_probe 127.0.0.1 "$SSHD_PORT"; then
    stage_end ready 0
    return 0
  fi
  [ -x "$SSHD_BIN" ] || { stage_end degraded 20; return 1; }
  "$SSHD_BIN" >/dev/null 2>&1 &
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
    tcp_probe 127.0.0.1 "$SSHD_PORT" && { stage_end recovered 0; return 0; }
    sleep 0.5
  done
  stage_end degraded 21
  return 1
}

framework_health() {
  [ -x "$CURL_BIN" ] || return 1
  "$CURL_BIN" --silent --show-error --fail --max-time 2 "$FRAMEWORK_BASE_URL/health" \
    >/dev/null 2>&1
}

ensure_framework() {
  local attempt
  stage_start framework_health
  if framework_health; then
    stage_end healthy 0
    return 0
  fi
  stage_end unavailable 30
  [ -f "$FRAMEWORK_CONTROL" ] || { log framework_controller missing 0 31; return 1; }
  stage_start framework_bootstrap
  if "$TERMUX_PREFIX/bin/bash" "$FRAMEWORK_CONTROL" bootstrap >/dev/null 2>&1; then
    stage_end ready 0
  else
    stage_end failed 32
  fi
  if ! framework_health; then
    stage_start framework_start
    if "$TERMUX_PREFIX/bin/bash" "$FRAMEWORK_CONTROL" start >/dev/null 2>&1; then
      stage_end requested 0
    else
      stage_end failed 33
    fi
  fi
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    framework_health && { log framework_recovery healthy 0 0; return 0; }
    sleep 0.5
  done
  log framework_recovery failed 0 34
  return 1
}

adb_ok=0
sshd_ok=0
if ensure_sshd; then
  sshd_ok=1
else
  log sshd overall_degraded 0 22
fi

if ! ensure_framework; then
  if adb_fast_path || adb_repair; then
    adb_ok=1
  else
    log adb overall_degraded 0 18
  fi
  log overall failed $(( $(now_ms) - RUN_STARTED )) 40
  exit 1
fi

if adb_fast_path; then
  adb_ok=1
elif adb_repair; then
  adb_ok=1
else
  log adb overall_degraded 0 18
fi

if [ "$adb_ok" = 1 ] && [ "$sshd_ok" = 1 ]; then
  log overall success $(( $(now_ms) - RUN_STARTED )) 0
else
  log overall degraded $(( $(now_ms) - RUN_STARTED )) 0
fi
exit 0
