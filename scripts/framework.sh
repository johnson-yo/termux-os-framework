#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: Framework lifecycle, private credential recovery, and Termux network-ready runtime control.
# [POS]: scripts/framework.sh in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

set -u

RUNTIME="${FRAMEWORK_RUNTIME:-$HOME/.termux-os/framework}"
PERSIST="${FRAMEWORK_PERSIST:-/sdcard/termux-os/framework}"
CONF="${FRAMEWORK_CONFIG:-$PERSIST/conf/framework.v1.json}"
CONTROL="${FRAMEWORK_CONTROL:-$HOME/framework.sh}"
INSTALLED_ROOT="${PACKAGES_INSTALLED_DIR:-$HOME/.termux-os/packages}"
ASSET_ROOT="${FRAMEWORK_ASSET_ROOT:-/sdcard/termux-os/models}"
PACKAGE_CONTROL_ROOT="${PACKAGE_CONTROL_ROOT:-$PERSIST/package-control}"
BROWSER_SESSION_PATH="${BROWSER_SESSION_PATH:-$HOME/.termux-os/browser-sessions.v1.json}"
AUTH_FILE="${FRAMEWORK_AUTH_FILE:-$HOME/.termux-os/secrets/framework-auth.v1.json}"
PORT="${FRAMEWORK_PORT:-8980}"
BASE_URL="${FRAMEWORK_BASE_URL:-http://127.0.0.1:$PORT}"
PIDFILE="$RUNTIME/framework.pid"
LOGFILE="$RUNTIME/framework.log"
UPDATE_DIR="$PERSIST/updates"
STAGE_ROOT="$(dirname "$RUNTIME")/.framework-update-staging"

say() { echo "[framework] $*"; }
err() { echo "[framework] ERROR: $*" >&2; }
die() { err "$*"; exit 1; }

alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
port_up() { curl -sf -m 2 "$BASE_URL/health" >/dev/null 2>&1; }
current_build() { cat "$RUNTIME/.deploy-id" 2>/dev/null || echo unknown; }
admin_token() {
  auth_value admin_token
}
admin_password() {
  local password
  password="$(auth_value admin_password)"
  [ -n "$password" ] && printf '%s' "$password" || admin_token
}

auth_value() {
  local key="$1" value=""
  if [ -f "$CONF" ]; then
    value="$(node -e '
      const fs=require("fs");
      try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).auth?.[process.argv[2]]||"")); }
      catch { process.exit(1); }
    ' "$CONF" "$key" 2>/dev/null || true)"
  fi
  if [ -z "$value" ] && [ -f "$AUTH_FILE" ]; then
    value="$(node -e '
      const fs=require("fs");
      try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))[process.argv[2]]||"")); }
      catch { process.exit(1); }
    ' "$AUTH_FILE" "$key" 2>/dev/null || true)"
  fi
  printf '%s' "$value"
}

ensure_auth() {
  [ -n "$(admin_token)" ] && return 0
  [ -f "$RUNTIME/src/system/auth-file.mjs" ] || die "credential helper is missing from $RUNTIME"
  FRAMEWORK_AUTH_FILE="$AUTH_FILE" node "$RUNTIME/src/system/auth-file.mjs" ensure "$AUTH_FILE" >/dev/null \
    || die "could not create $AUTH_FILE"
  chmod 600 "$AUTH_FILE" 2>/dev/null || true
  say "created private credentials at $AUTH_FILE"
}

# 持久配置只在不存在時從 runtime default 建立；已存在絕不覆蓋。
# conf 只記錄「與本版預設不同的部分」。把整份預設複製進去看似方便，但那些值日後會被
# 當成使用者的選擇搬到新版本上，於是改預設永遠到不了已安裝的設備；Framework 啟動時
# 會把預設與這裡的覆蓋項合併，所以一個只有 schema 的檔案就是完整可用的配置。
ensure_config() {
  [ -f "$CONF" ] && return 0
  local def="$RUNTIME/config/defaults/framework.v1.json"
  [ -f "$def" ] || { say "default config 尚未部署，跳過配置初始化"; return 0; }
  mkdir -p "$(dirname "$CONF")"
  node -e '
    const fs = require("fs");
    const schema = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).schema;
    fs.writeFileSync(process.argv[2], `${JSON.stringify({ schema }, null, 2)}\n`);
  ' "$def" "$CONF" && say "已建立 $CONF"
}

cmd_bootstrap() {
  mkdir -p "$RUNTIME" "$PERSIST/conf" "$PERSIST/backups" "$PERSIST/history" "$UPDATE_DIR" "$STAGE_ROOT"
  touch "$RUNTIME/.framework-root" "$PERSIST/.persistent-root"
  ensure_config
  ensure_auth
  say "bootstrap 完成"
}

start_runtime() {
  alive && { err "已在運行 (pid $(cat "$PIDFILE"))"; return 1; }
  port_up && { err "端口 $PORT 已被其他進程佔用"; return 1; }
  [ -f "$RUNTIME/package.json" ] || { err "runtime 未部署: $RUNTIME"; return 1; }
  ensure_config
  [ -f "$CONF" ] || { err "缺少配置 $CONF"; return 1; }
  ensure_auth
  cd "$RUNTIME" || return 1
  # 正式 Package 唯一來源=Installed Root；PACKAGES_DEV_DIR 只供顯式舊開發入口，029 Dev Mount 走 API。
  HOST="${FRAMEWORK_HOST:-}" PORT="$PORT" CONFIG="$CONF" PACKAGES_INSTALLED_DIR="$INSTALLED_ROOT" \
    FRAMEWORK_RUNTIME="$RUNTIME" FRAMEWORK_PERSIST="$PERSIST" FRAMEWORK_CONFIG="$CONF" \
    FRAMEWORK_CONTROL="$CONTROL" FRAMEWORK_CONTROL_PATH="$CONTROL" FRAMEWORK_UPDATE_ROOT="$UPDATE_DIR" \
    FRAMEWORK_PORT="$PORT" FRAMEWORK_BASE_URL="$BASE_URL" \
    STAGE_DESIRED_PATH="$PERSIST/conf/stage.v1.json" \
    AUTH_AUDIT_PATH="$PERSIST/history/auth-login-failures.v1.jsonl" \
    FRAMEWORK_AUTH_FILE="$AUTH_FILE" \
    BROWSER_SESSION_PATH="$BROWSER_SESSION_PATH" \
    PACKAGE_CONTROL_ROOT="$PACKAGE_CONTROL_ROOT" \
    nohup node src/server.mjs >"$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 30); do
    port_up && { say "started (pid $(cat "$PIDFILE"))"; return 0; }
    sleep 0.5
  done
  err "啟動後 $PORT 未就緒，見 $LOGFILE"
  return 1
}

# 正常關閉前先讓 Stage Manager 停掉全部 managed services；server 已死則跳過。
stop_services() {
  port_up || return 0
  local token
  token="$(admin_token)"
  [ -n "$token" ] || return 0
  curl -s -m 30 -X POST -H "Authorization: Bearer $token" \
    "$BASE_URL/api/stage/stop-all" >/dev/null 2>&1 || true
}

stop_runtime() {
  local pid cwd
  stop_services
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
  # 兼容 030 前 npm wrapper PID：只清 cwd 真正在本 runtime 的 server，禁止全局 pkill 誤殺別的 fixture。
  for pid in $(pgrep -f 'node src/server\.mjs' 2>/dev/null || true); do
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    [ "$cwd" = "$RUNTIME" ] && kill "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 20); do port_up || break; sleep 0.25; done
  if port_up; then
    err "端口 $PORT 仍被佔用，stop 失敗"
    return 1
  fi
  rm -f "$PIDFILE"
  say "stopped"
}

cmd_start() { start_runtime || exit 1; }
cmd_stop() { stop_runtime || exit 1; }
cmd_restart() { stop_runtime && start_runtime || exit 1; }

cmd_status() {
  alive && say "process: running (pid $(cat "$PIDFILE"))" || say "process: not running"
  port_up && say "port $PORT: healthy" || say "port $PORT: not responding"
  say "deploy-id: $(current_build)"
  say "config: $([ -f "$CONF" ] && echo present || echo missing)"
  if [ -f "$UPDATE_DIR/state.v1.json" ]; then
    say "last-update: $(tr -d '\n' < "$UPDATE_DIR/state.v1.json")"
  fi
}

cmd_logs() { tail -n 100 "$LOGFILE" 2>/dev/null || say "無日誌 ($LOGFILE)"; }

cmd_health() {
  alive || die "進程不存在"
  curl -sf -m 3 "$BASE_URL/health" && echo || die "/health 失敗"
}

cmd_credentials() {
  ensure_auth
  FRAMEWORK_AUTH_FILE="$AUTH_FILE" node "$RUNTIME/src/system/auth-file.mjs" show "$AUTH_FILE"
}

# Local recovery path: Termux access is already administrator access.  This command
# deliberately works only with the private credential file; environment/config-managed
# credentials must be changed at their source instead of creating an ineffective override.
cmd_reset_password() {
  if [ -n "${FRAMEWORK_ADMIN_PASSWORD:-}" ] || [ -n "${FRAMEWORK_ADMIN_TOKEN:-}" ]; then
    die "credentials are managed by FRAMEWORK_ADMIN_*; change the source configuration instead"
  fi
  local managed
  managed="$(node -e '
    const fs=require("fs");
    try { const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).auth||{};
      process.stdout.write(a.admin_password || a.admin_token ? "yes" : "no");
    } catch { process.stdout.write("no"); }
  ' "$CONF" 2>/dev/null || echo no)"
  [ "$managed" = no ] || die "credentials are managed by $CONF; change the source configuration instead"

  local password confirm
  if [ "${1:-}" = "--generate" ]; then
    password="$(AUTH_HELPER="$RUNTIME/src/system/auth-file.mjs" node --input-type=module -e \
      'const { generateAdminPassword } = await import(process.env.AUTH_HELPER); process.stdout.write(generateAdminPassword())')"
  else
    [ -t 0 ] || die "manual reset requires an interactive Termux shell; use --generate instead"
    IFS= read -r -s -p "New Framework login password (min 16 chars): " password; echo
    IFS= read -r -s -p "Repeat new Framework login password: " confirm; echo
    [ "$password" = "$confirm" ] || die "password confirmation does not match"
  fi
  [ "${#password}" -ge 16 ] || die "password must contain at least 16 characters"
  printf '%s' "$password" | FRAMEWORK_AUTH_FILE="$AUTH_FILE" AUTH_HELPER="$RUNTIME/src/system/auth-file.mjs" node --input-type=module -e '
    import fs from "node:fs";
    let value="";
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", async () => {
      const { writeAuthFile } = await import(process.env.AUTH_HELPER);
      writeAuthFile(process.env.FRAMEWORK_AUTH_FILE, { admin_password: value });
    });
  ' || die "could not write private credentials"
  if alive || port_up; then
    cmd_restart
  fi
  say "login password reset; the new password is printed once below"
  printf 'new_password=%s\n' "$password"
}

# 030：核心完整性不再等同於「端口打開」。首個 030 更新允許舊 build 沒有 integrity endpoint；
# 新 build 與 rollback 後一律要求 endpoint/schema/build 都對得上。
core_check() {
  local expected="${1:-$(current_build)}" allow_legacy="${2:-0}" token password body code
  local features browser_session package_manager cookie login csrf
  port_up || { err "core-check: /health 失敗"; return 1; }
  # 尚未認領憑證的設備上 /admin 會導向 Setup。要驗的是「入口在」，不是「入口是登入頁」——
  # 綁死 200 會讓每一次更新在剛裝好的設備上都失敗。
  local admin_code
  admin_code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE_URL/admin")"
  case "$admin_code" in
    200|302) ;;
    *) err "core-check: /admin 不可用 (http=$admin_code)"; return 1 ;;
  esac
  token="$(admin_token)"
  [ -n "$token" ] || { err "core-check: admin token 不可讀"; return 1; }
  body="$(curl -sf -m 8 -H "Authorization: Bearer $token" "$BASE_URL/api/admin/status")" \
    || { err "core-check: admin status 認證失敗"; return 1; }
  EXPECTED_BUILD="$expected" node -e '
    let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{try{
      const d=JSON.parse(s); process.exit(d.ok && d.deploy_id===process.env.EXPECTED_BUILD ? 0 : 1);
    }catch{process.exit(1)}})' <<<"$body" \
    || { err "core-check: admin status build 不符（expected=$expected）"; return 1; }
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H 'Authorization: Bearer definitely-wrong' \
      "$BASE_URL/api/admin/status")" = 401 ] \
    || { err "core-check: 錯誤 token 未被拒"; return 1; }

  features="$(curl -sf -m 5 "$BASE_URL/api/features")" \
    || { err "core-check: feature schema 不可讀"; return 1; }
  browser_session="$(node -e '
    let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{
      const d=JSON.parse(s);process.stdout.write(String(d.features?.browser_session??0));
    }catch{process.stdout.write("0")}})' <<<"$features")"
  package_manager="$(node -e '
    let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{
      const d=JSON.parse(s);process.stdout.write(String(d.features?.package_manager_web??0));
    }catch{process.stdout.write("0")}})' <<<"$features")"
  if [ "$browser_session" != 1 ] && [ "$allow_legacy" != 1 ]; then
    err "core-check: candidate 未提供 Browser Session feature"
    return 1
  fi
  if [ "$browser_session" = 1 ]; then
    password="$(admin_password)"
    cookie="$UPDATE_DIR/session-cookie.$$"
    body="$(ADMIN_PASSWORD="$password" node -e 'process.stdout.write(JSON.stringify({password:process.env.ADMIN_PASSWORD}))')"
    login="$(curl -sf -m 8 -c "$cookie" -H 'Content-Type: application/json' \
      --data "$body" "$BASE_URL/api/auth/login")" \
      || { err "core-check: Browser Login 失敗"; rm -f "$cookie"; return 1; }
    csrf="$(node -e '
      let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const d=JSON.parse(s);
      if(d.schema==="termux-os.browser-session.v1")process.stdout.write(d.csrf_token||"")}catch{}})' <<<"$login")"
    [ -n "$csrf" ] || { err "core-check: Browser Session schema/CSRF 缺失"; rm -f "$cookie"; return 1; }
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 -b "$cookie" \
      "$BASE_URL/admin/status/overview")" = 200 ] \
      || { err "core-check: Browser Session 無法打開 Overview"; rm -f "$cookie"; return 1; }
    if [ "$package_manager" = 1 ]; then
      curl -sf -m 10 -b "$cookie" "$BASE_URL/api/admin/package-manager" >"$UPDATE_DIR/package-manager-last.json" \
        || { err "core-check: Package Manager inventory 不可讀"; rm -f "$cookie"; return 1; }
      node -e 'const d=require(process.argv[1]);process.exit(d.ok
        &&d.schema==="termux-os.package-manager.v1"&&Array.isArray(d.packages)
        &&Array.isArray(d.jobs)?0:1)' "$UPDATE_DIR/package-manager-last.json" \
        || { err "core-check: Package Manager schema 無效"; rm -f "$cookie"; return 1; }
    fi
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 -b "$cookie" -X POST \
      -H "X-CSRF-Token: $csrf" "$BASE_URL/api/auth/logout")" = 200 ] \
      || { err "core-check: Browser Logout/CSRF 失敗"; rm -f "$cookie"; return 1; }
    rm -f "$cookie"
  fi

  code="$(curl -s -o "$UPDATE_DIR/integrity-last.json" -w '%{http_code}' -m 15 \
    -H "Authorization: Bearer $token" "$BASE_URL/api/admin/integrity")"
  if [ "$code" = 404 ] && [ "$allow_legacy" = 1 ]; then
    say "core-check: legacy build 無 /api/admin/integrity（只允許作為首次更新的舊版本）"
    return 0
  fi
  [ "$code" = 200 ] || { err "core-check: integrity HTTP $code"; return 1; }
  EXPECTED_BUILD="$expected" node -e '
    const fs=require("fs"); try {
      const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      process.exit(d.ok && d.schema==="termux-os.framework-integrity.v1"
        && d.checks?.framework_build?.deploy_id===process.env.EXPECTED_BUILD ? 0 : 1);
    } catch { process.exit(1) }' "$UPDATE_DIR/integrity-last.json" \
    || { err "core-check: integrity schema/結果/build 不符"; return 1; }
  return 0
}

archive_sha() { sha256sum "$1" | awk '{print $1}'; }

verify_sha_sidecar() {
  local tarball="$1" sidecar="$2" expected actual
  [ -f "$tarball" ] || { err "archive 不存在: $tarball"; return 1; }
  [ -f "$sidecar" ] || { err "sha256 sidecar 不存在: $sidecar"; return 1; }
  expected="$(awk 'NR==1{print $1}' "$sidecar")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || { err "sha256 sidecar 格式錯誤"; return 1; }
  actual="$(archive_sha "$tarball")"
  [ "$actual" = "$expected" ] || { err "sha256 不符: expected=$expected actual=$actual"; return 1; }
}

check_archive_entries() {
  local tarball="$1" entry line type
  tar -tzf "$tarball" >/dev/null || { err "archive 不可讀"; return 1; }
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case "$entry" in framework|framework/|framework/*) ;; *) err "archive 頂層必須只有 framework/: $entry"; return 1 ;; esac
    case "/$entry/" in *"/../"*) err "archive 路徑不安全: $entry"; return 1 ;; esac
    case "$entry" in *"//"*) err "archive 路徑不安全: $entry"; return 1 ;; esac
    if [[ "$entry" = /* ]]; then err "archive 含絕對路徑: $entry"; return 1; fi
  done < <(tar -tzf "$tarball") || return 1
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    type="${line:0:1}"
    case "$type" in -|d) ;; *) err "archive 含禁止 entry type $type"; return 1 ;; esac
  done < <(LC_ALL=C tar -tvzf "$tarball") || return 1
}

check_space() {
  local tarball="$1" bytes free_kb need_kb
  bytes="$(wc -c < "$tarball")"
  free_kb="$(df -Pk "$(dirname "$RUNTIME")" | awk 'END{print $4}')"
  need_kb=$((bytes / 1024 * 3 + 51200))
  [ "$free_kb" -ge "$need_kb" ] \
    || { err "空間不足: need=${need_kb}KB free=${free_kb}KB"; return 1; }
}

UPDATE_ID=""
PREVIOUS_BUILD=""
CANDIDATE_BUILD=""
CANDIDATE_DIR=""
OLD_RUNTIME=""
SWAPPED=0
UPDATE_ACTIVE=0
UPDATE_SUCCESS=0
RECOVERY_DONE=0

write_state() {
  local stage="$1" status="$2" message="${3:-}" rollback="${4:-false}"
  mkdir -p "$UPDATE_DIR"
  STATE_FILE="$UPDATE_DIR/state.v1.json" UPDATE_ID="$UPDATE_ID" PREVIOUS_BUILD="$PREVIOUS_BUILD" \
    CANDIDATE_BUILD="$CANDIDATE_BUILD" UPDATE_STAGE="$stage" UPDATE_STATUS="$status" \
    UPDATE_MESSAGE="$message" UPDATE_ROLLBACK="$rollback" node <<'NODE'
const fs = require('fs');
const p = process.env.STATE_FILE;
let previous = null;
try { previous = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
const state = {
  schema: 'termux-os.framework-update-state.v1',
  update_id: process.env.UPDATE_ID,
  previous_build: process.env.PREVIOUS_BUILD || null,
  candidate_build: process.env.CANDIDATE_BUILD || null,
  stage: process.env.UPDATE_STAGE,
  status: process.env.UPDATE_STATUS,
  message: process.env.UPDATE_MESSAGE || null,
  rollback: process.env.UPDATE_ROLLBACK === 'true',
  started_at: previous?.update_id === process.env.UPDATE_ID ? previous.started_at : new Date().toISOString(),
  updated_at: new Date().toISOString(),
};
fs.writeFileSync(`${p}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
fs.renameSync(`${p}.tmp`, p);
NODE
}

# Web/CLI 都调用这个正式 preflight；把机器可读结果落在 updates 根，调用方不允许再刮人类日志。
write_preflight_result() {
  local status="$1" message="${2:-}" archive="${3:-}"
  PREFLIGHT_FILE="$UPDATE_DIR/preflight.v1.json" PREFLIGHT_ID="$UPDATE_ID" \
    PREFLIGHT_STATUS="$status" PREFLIGHT_MESSAGE="$message" PREFLIGHT_BUILD="$CANDIDATE_BUILD" \
    PREFLIGHT_ARCHIVE="$archive" node <<'NODE'
const fs = require('fs');
const file = process.env.PREFLIGHT_FILE;
const archive = process.env.PREFLIGHT_ARCHIVE;
let sha256 = null;
try { sha256 = archive ? require('crypto').createHash('sha256').update(fs.readFileSync(archive)).digest('hex') : null; } catch {}
fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({
  schema: 'termux-os.framework-preflight.v1',
  preflight_id: process.env.PREFLIGHT_ID,
  status: process.env.PREFLIGHT_STATUS,
  candidate_build: process.env.PREFLIGHT_BUILD || null,
  archive_sha256: sha256,
  message: process.env.PREFLIGHT_MESSAGE || null,
  checked_at: new Date().toISOString(),
}, null, 2)}\n`);
fs.renameSync(`${file}.tmp`, file);
NODE
}

append_history() {
  local result="$1" rollback="$2" message="${3:-}"
  STATE_FILE="$UPDATE_DIR/state.v1.json" HISTORY_FILE="$UPDATE_DIR/history.v1.jsonl" \
    RESULT="$result" ROLLBACK="$rollback" MESSAGE="$message" node <<'NODE'
const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
fs.appendFileSync(process.env.HISTORY_FILE, `${JSON.stringify({
  schema: 'termux-os.framework-update-history.v1',
  update_id: s.update_id, previous_build: s.previous_build, candidate_build: s.candidate_build,
  result: process.env.RESULT, rollback: process.env.ROLLBACK === 'true',
  message: process.env.MESSAGE || null, at: new Date().toISOString(),
})}\n`);
NODE
}

state_field() {
  node -e 'const fs=require("fs");try{const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    process.stdout.write(String(d[process.argv[2]]??""))}catch{}' "$UPDATE_DIR/state.v1.json" "$1"
}

save_previous_controller() {
  [ -f "$CONTROL" ] || { err "外置控制腳本不存在: $CONTROL"; return 1; }
  bash -n "$CONTROL" || { err "外置控制腳本語法錯誤: $CONTROL"; return 1; }
  say "trusted private controller verified: $CONTROL"
}

# SIGKILL/斷電無法跑 trap；下一次 update/rollback 取得鎖時按持久 state + previous runtime 自動收口。
acquire_update_lock() {
  local lock="$UPDATE_DIR/update.lock" pid stale_id stale_status
  if mkdir "$lock" 2>/dev/null; then
    printf '%s\n' "$$" > "$lock/pid"
    return 0
  fi
  pid="$(cat "$lock/pid" 2>/dev/null || true)"
  [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null \
    || { err "已有 Framework update 在執行 (pid $pid)"; return 1; }

  stale_id="$(state_field update_id)"
  stale_status="$(state_field status)"
  say "發現中斷的 update lock（id=${stale_id:-unknown}, status=${stale_status:-unknown}）"
  case "$stale_status" in
    success|failed|failed_rolled_back)
      [ -z "$stale_id" ] || {
        rm -rf "$(dirname "$RUNTIME")/.framework-previous-$stale_id" "$STAGE_ROOT/$stale_id"
      }
      ;;
    *)
      if [ -n "$stale_id" ] && [ -d "$(dirname "$RUNTIME")/.framework-previous-$stale_id" ]; then
        UPDATE_ID="$stale_id"
        PREVIOUS_BUILD="$(state_field previous_build)"
        CANDIDATE_BUILD="$(state_field candidate_build)"
        OLD_RUNTIME="$(dirname "$RUNTIME")/.framework-previous-$stale_id"
        SWAPPED=1
        RECOVERY_DONE=0
        recover_previous || return 1
        write_state interrupted failed_rolled_back "前次更新中斷；已恢復 $PREVIOUS_BUILD" true
        append_history failed true "interrupted update recovered on next invocation"
      else
        UPDATE_ID="${stale_id:-interrupted-unknown}"
        PREVIOUS_BUILD="$(current_build)"
        CANDIDATE_BUILD="$(state_field candidate_build)"
        write_state interrupted failed "前次更新在切換前中斷；live runtime 未改動" false
        append_history failed false "interrupted before switch"
      fi
      ;;
  esac
  rm -rf "$lock"
  mkdir "$lock" || return 1
  printf '%s\n' "$$" > "$lock/pid"
  UPDATE_ID=""
  PREVIOUS_BUILD=""
  CANDIDATE_BUILD=""
  OLD_RUNTIME=""
  SWAPPED=0
  RECOVERY_DONE=0
}

# 大模型/音頻資料只做 path+size+mtime inventory；小型配置與身份文件做內容 hash。
tree_inventory() {
  local root="$1"
  [ -d "$root" ] || { echo missing; return; }
  (
    cd "$root" || exit 1
    find . -type f -printf '%P\t%s\t%T@\n' | LC_ALL=C sort
  ) | sha256sum | awk '{print $1}'
}

tree_content() {
  local root="$1"
  [ -d "$root" ] || { echo missing; return; }
  (
    cd "$root" || exit 1
    while IFS= read -r -d '' file; do sha256sum "$file"; done \
      < <(find . -type f -print0 | LC_ALL=C sort -z)
  ) | sha256sum | awk '{print $1}'
}

installed_truth() {
  local root="$1"
  [ -d "$root" ] || { echo missing; return; }
  (
    cd "$root" || exit 1
    while IFS= read -r -d '' file; do sha256sum "$file"; done \
      < <(find . -type f \( -name active.json -o -name termux-os.package.json \) -print0 | LC_ALL=C sort -z)
  ) | sha256sum | awk '{print $1}'
}

# 邊界比對的是「使用者設了什麼」，不是檔案的位元組。新版本為自己新增的鍵不算越界，
# 使用者的值被改動仍然會被抓到——否則「conf 不許變」與「新版本需要新鍵」永遠互斥，
# 落後太多版的設備就再也更新不上去。Package 自己的 conf 仍逐位元組比對。
conf_fingerprint() {
  local dir="$PERSIST/conf" main="$PERSIST/conf/framework.v1.json"
  [ -d "$dir" ] || { echo missing; return; }
  {
    if [ -f "$main" ]; then
      node "$RUNTIME/scripts/conf-fingerprint.mjs" "$main" 2>/dev/null || printf unreadable
      printf '\n'
    fi
    (
      cd "$dir" || exit 1
      while IFS= read -r -d '' file; do
        case "$file" in ./framework.v1.json|./framework.v1.json.pre-*|./setup-state.v1.json) continue ;; esac
        sha256sum "$file"
      done < <(find . -type f -print0 | LC_ALL=C sort -z)
    )
  } | sha256sum | awk '{print $1}'
}

snapshot_boundaries() {
  local out="$1"
  {
    echo "installed_inventory=$(tree_inventory "$INSTALLED_ROOT")"
    echo "installed_truth=$(installed_truth "$INSTALLED_ROOT")"
    echo "persistent_conf=$(conf_fingerprint)"
    echo "persistent_data_root=$([ -d "$PERSIST/data" ] && echo present || echo missing)"
    echo "assets=$(tree_inventory "$ASSET_ROOT")"
    echo "observations=$(tree_content "$RUNTIME/.runtime/observations")"
  } > "$out"
}

active_dev_mounts() {
  local token response mounts=""
  token="$(admin_token)"
  response="$(curl -s -m 5 -H "Authorization: Bearer ${token:-x}" "$BASE_URL/api/dev/packages" 2>/dev/null || true)"
  if [ -n "$response" ]; then
    mounts="$(node -e '
      let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{try{
        const d=JSON.parse(s); process.stdout.write((d.mounts||[]).map(x=>x.package_id).join(","));
      }catch{}})' <<<"$response")"
  fi
  if [ -z "$mounts" ] && [ -f "$RUNTIME/.runtime/dev/packages.v1.json" ]; then
    mounts="$(node -e '
      const fs=require("fs"); try { const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      process.stdout.write((d.mounts||[]).map(x=>x.package_id).join(",")); } catch {}' \
      "$RUNTIME/.runtime/dev/packages.v1.json")"
  fi
  printf '%s' "$mounts"
}

ensure_no_dev_mounts() {
  local mounts
  mounts="$(active_dev_mounts)"
  [ -z "$mounts" ] || {
    err "active Dev Runtime: $mounts"
    err "請到 Packages → Workspace 停止挂载後再更新；Workspace 的專案不會被刪"
    return 1
  }
}

preflight_candidate() {
  local tarball="$1" sidecar="${2:-$1.sha256}" stage
  verify_sha_sidecar "$tarball" "$sidecar" || return 1
  check_archive_entries "$tarball" || return 1
  check_space "$tarball" || return 1
  UPDATE_ID="${UPDATE_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
  stage="$STAGE_ROOT/$UPDATE_ID"
  rm -rf "$stage"
  mkdir -p "$stage"
  tar -xzf "$tarball" -C "$stage" --no-same-owner --no-same-permissions || return 1
  CANDIDATE_DIR="$stage/framework"
  for f in package.json src/server.mjs scripts/framework.sh config/defaults/framework.v1.json .deploy-id; do
    [ -f "$CANDIDATE_DIR/$f" ] || { err "candidate 缺少 $f"; return 1; }
  done
  for f in .runtime framework.pid framework.log node_modules; do
    [ ! -e "$CANDIDATE_DIR/$f" ] || { err "candidate 不得攜帶 $f"; return 1; }
  done
  bash -n "$CANDIDATE_DIR/scripts/framework.sh" || { err "candidate framework.sh 語法錯誤"; return 1; }
  CANDIDATE_BUILD="$(tr -d '\r\n' < "$CANDIDATE_DIR/.deploy-id")"
  [ -n "$CANDIDATE_BUILD" ] || { err "candidate .deploy-id 為空"; return 1; }
  node -e 'const p=require(process.argv[1]); if(!p.scripts?.dev)process.exit(1)' \
    "$CANDIDATE_DIR/package.json" || { err "candidate package.json 缺 scripts.dev"; return 1; }
  say "preflight PASS: build=$CANDIDATE_BUILD sha=$(archive_sha "$tarball")"
}

cmd_preflight_update() {
  local tarball="${1:-}" sidecar="${2:-${1:-}.sha256}"
  UPDATE_ID="preflight-$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$UPDATE_DIR" "$STAGE_ROOT"
  if ! preflight_candidate "$tarball" "$sidecar"; then
    write_preflight_result failed "candidate validation failed" "$tarball"
    exit 1
  fi
  if ! ensure_no_dev_mounts; then
    write_preflight_result failed "active Dev Runtime prevents update" "$tarball"
    exit 1
  fi
  write_preflight_result success "candidate preflight passed" "$tarball"
  rm -rf "$STAGE_ROOT/$UPDATE_ID"
}

# 只有完整 core-check 通過的舊版本才能成為 last-good；失敗必須非零，禁止「跳過但繼續更新」。
cmd_backup() {
  mkdir -p "$PERSIST/backups" "$UPDATE_DIR"
  local build tar_tmp tar_final sha
  build="$(current_build)"
  core_check "$build" 1 || die "當前版本不健康，拒絕覆蓋 last-good"
  [ -f "$CONTROL" ] || die "外置控制腳本不存在: $CONTROL"
  bash -n "$CONTROL" || die "外置控制腳本語法錯誤: $CONTROL"
  tar_tmp="$PERSIST/backups/last-good.tar.gz.new"
  tar_final="$PERSIST/backups/last-good.tar.gz"
  # Android app sandboxes can reject following a contributor-only AGENTS.md
  # symlink when tar archives the runtime. It is not executable runtime state;
  # omit only that top-level link so last-good remains usable without root.
  tar -czf "$tar_tmp" -C "$RUNTIME" \
    --exclude node_modules --exclude .runtime --exclude framework.pid --exclude framework.log \
    --exclude './AGENTS.md' . \
    || die "last-good 歸檔失敗"
  tar -tzf "$tar_tmp" >/dev/null || die "last-good 歸檔不可讀"
  sha="$(archive_sha "$tar_tmp")"
  mv "$tar_tmp" "$tar_final"
  printf '%s  %s\n' "$sha" "$(basename "$tar_final")" > "$tar_final.sha256"
  LAST_GOOD_META="$PERSIST/backups/last-good.json" LAST_GOOD_BUILD="$build" \
    LAST_GOOD_SHA="$sha" node <<'NODE'
const fs = require('fs');
const p = process.env.LAST_GOOD_META;
const d = {
  schema: 'termux-os.framework-last-good.v1',
  created_at: new Date().toISOString(),
  deploy_id: process.env.LAST_GOOD_BUILD,
  archive_sha256: process.env.LAST_GOOD_SHA,
  health: 'passed',
};
fs.writeFileSync(`${p}.tmp`, `${JSON.stringify(d, null, 2)}\n`);
fs.renameSync(`${p}.tmp`, p);
NODE
  say "backup 完成 → $tar_final ($build)"
}

move_runtime_state() {
  local from="$1" to="$2" rel
  for rel in .runtime framework.log; do
    if [ -e "$from/$rel" ]; then
      rm -rf "$to/$rel"
      mv "$from/$rel" "$to/$rel"
    fi
  done
}

switch_candidate() {
  stop_runtime || return 1
  OLD_RUNTIME="$(dirname "$RUNTIME")/.framework-previous-$UPDATE_ID"
  rm -rf "$OLD_RUNTIME"
  mv "$RUNTIME" "$OLD_RUNTIME" || return 1
  if ! mv "$CANDIDATE_DIR" "$RUNTIME"; then
    mv "$OLD_RUNTIME" "$RUNTIME" || true
    return 1
  fi
  move_runtime_state "$OLD_RUNTIME" "$RUNTIME"
  touch "$RUNTIME/.framework-root"
  PIDFILE="$RUNTIME/framework.pid"
  LOGFILE="$RUNTIME/framework.log"
  SWAPPED=1
}

recover_previous() {
  [ "$RECOVERY_DONE" = 0 ] || return 0
  RECOVERY_DONE=1
  if [ "$SWAPPED" = 1 ] && [ -d "$OLD_RUNTIME" ]; then
    say "恢復舊 runtime $PREVIOUS_BUILD"
    stop_runtime || true
    move_runtime_state "$RUNTIME" "$OLD_RUNTIME"
    rm -rf "$RUNTIME"
    mv "$OLD_RUNTIME" "$RUNTIME" || { err "舊 runtime 無法復位"; return 1; }
    PIDFILE="$RUNTIME/framework.pid"
    LOGFILE="$RUNTIME/framework.log"
    start_runtime || { err "舊 runtime 復位後無法啟動"; return 1; }
    core_check "$PREVIOUS_BUILD" 1 || { err "舊 runtime 復位後 core-check 失敗"; return 1; }
  fi
  return 0
}

update_exit() {
  local code=$?
  trap - EXIT INT TERM HUP
  if [ "$UPDATE_ACTIVE" = 1 ] && [ "$UPDATE_SUCCESS" = 0 ]; then
    if [ "$SWAPPED" = 0 ]; then
      write_state failed failed "preflight/last-good 失敗；live runtime 未改動" false
      append_history failed false "live runtime unchanged"
    else
      recover_previous
      local recovered=$?
      if [ "$recovered" = 0 ]; then
        write_state rollback failed_rolled_back "candidate 失敗；已自動恢復 $PREVIOUS_BUILD" true
        append_history failed true "candidate 失敗；已自動恢復"
      else
        write_state rollback failed "candidate 與 rollback 均失敗，需人工介入" true
        append_history failed true "rollback failed"
      fi
    fi
  fi
  rm -rf "$STAGE_ROOT/$UPDATE_ID" 2>/dev/null || true
  rm -rf "$UPDATE_DIR/update.lock" 2>/dev/null || true
  exit "$code"
}

verify_private_controller() {
  [ -f "$CONTROL" ] || { err "外置控制腳本不存在: $CONTROL"; return 1; }
  bash -n "$CONTROL" || return 1
  say "private controller unchanged; trusted redeploy is required to replace $CONTROL"
}

cmd_update() {
  local tarball="${1:-}" sidecar="${2:-${1:-}.sha256}"
  [ -n "$tarball" ] || die "usage: framework.sh update <framework.tar.gz> [sha256]"
  mkdir -p "$UPDATE_DIR" "$STAGE_ROOT"
  acquire_update_lock || die "無法取得 Framework update lock"

  UPDATE_ID="$(date +%Y%m%d-%H%M%S)-$$"
  PREVIOUS_BUILD="$(current_build)"
  UPDATE_ACTIVE=1
  trap update_exit EXIT
  trap 'exit 130' INT TERM HUP
  write_state preflight running "驗證 candidate archive" false
  save_previous_controller || die "無法保存當前 controller"

  preflight_candidate "$tarball" "$sidecar" || die "candidate preflight 失敗"
  [ "$CANDIDATE_BUILD" != "$PREVIOUS_BUILD" ] || say "同 build 更新：仍執行完整驗證"
  ensure_no_dev_mounts || die "Dev Runtime active，更新未動現場"
  snapshot_boundaries "$UPDATE_DIR/$UPDATE_ID.before"

  write_state last_good running "保存健康舊版本" false
  cmd_backup

  write_state switch running "停止並原子切換 runtime" false
  switch_candidate || die "runtime 原子切換失敗"

  write_state start running "啟動 candidate" false
  start_runtime || die "candidate 啟動失敗"

  write_state post_check running "核心完整性與保留邊界" false
  core_check "$CANDIDATE_BUILD" 0 || die "candidate core-check 失敗"
  snapshot_boundaries "$UPDATE_DIR/$UPDATE_ID.after"
  cmp -s "$UPDATE_DIR/$UPDATE_ID.before" "$UPDATE_DIR/$UPDATE_ID.after" \
    || { diff -u "$UPDATE_DIR/$UPDATE_ID.before" "$UPDATE_DIR/$UPDATE_ID.after" >&2 || true;
      die "Installed/Persistent/Observations 邊界在更新中發生變化"; }

  verify_private_controller || die "private controller verification failed"
  write_state complete success "Framework update 完成" false
  append_history success false "post-check passed"
  UPDATE_SUCCESS=1
  rm -rf "$OLD_RUNTIME"
  say "update success: $PREVIOUS_BUILD → $CANDIDATE_BUILD"
}

last_good_build() {
  node -e 'const fs=require("fs");try{process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).deploy_id||"")}catch{}' \
    "$PERSIST/backups/last-good.json"
}

last_good_field() {
  node -e 'const fs=require("fs");try{const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    process.stdout.write(String(d[process.argv[2]]??""))}catch{}' \
    "$PERSIST/backups/last-good.json" "$1"
}

prepare_last_good() {
  local bak sha stage expected_archive
  bak="$PERSIST/backups/last-good.tar.gz"
  sha="$bak.sha256"
  verify_sha_sidecar "$bak" "$sha" || return 1
  expected_archive="$(last_good_field archive_sha256)"
  [ -n "$expected_archive" ] && [ "$(archive_sha "$bak")" = "$expected_archive" ] \
    || { err "last-good metadata/archive sha 不符"; return 1; }
  UPDATE_ID="${UPDATE_ID:-rollback-$(date +%Y%m%d-%H%M%S)-$$}"
  stage="$STAGE_ROOT/$UPDATE_ID"
  rm -rf "$stage"
  mkdir -p "$stage/framework"
  tar -xzf "$bak" -C "$stage/framework" --no-same-owner --no-same-permissions || return 1
  CANDIDATE_DIR="$stage/framework"
  CANDIDATE_BUILD="$(last_good_build)"
  [ -n "$CANDIDATE_BUILD" ] || { err "last-good metadata 缺 deploy_id"; return 1; }
  for f in package.json src/server.mjs scripts/framework.sh .deploy-id; do
    [ -f "$CANDIDATE_DIR/$f" ] || { err "last-good 缺 $f"; return 1; }
  done
  [ "$(tr -d '\r\n' < "$CANDIDATE_DIR/.deploy-id")" = "$CANDIDATE_BUILD" ] \
    || { err "last-good metadata/deploy-id 不符"; return 1; }
}

cmd_rollback() {
  mkdir -p "$UPDATE_DIR" "$STAGE_ROOT"
  acquire_update_lock || die "無法取得 Framework update lock"
  UPDATE_ID="rollback-$(date +%Y%m%d-%H%M%S)-$$"
  PREVIOUS_BUILD="$(current_build)"
  UPDATE_ACTIVE=1
  trap update_exit EXIT
  trap 'exit 130' INT TERM HUP

  write_state preflight running "驗證 last-good 與 trusted private controller" true
  save_previous_controller || die "無法保存當前 controller"
  ensure_no_dev_mounts || die "Dev Runtime active，rollback 未動現場"
  prepare_last_good || die "last-good 驗證失敗"
  snapshot_boundaries "$UPDATE_DIR/$UPDATE_ID.before"
  write_state switch running "切換到 last-good" true
  switch_candidate || die "last-good 原子切換失敗"
  start_runtime || die "last-good 啟動失敗"
  core_check "$CANDIDATE_BUILD" 1 || die "last-good core-check 失敗"
  snapshot_boundaries "$UPDATE_DIR/$UPDATE_ID.after"
  cmp -s "$UPDATE_DIR/$UPDATE_ID.before" "$UPDATE_DIR/$UPDATE_ID.after" \
    || die "rollback 改變 Installed/Persistent/Observations 邊界"
  verify_private_controller || die "private controller verification failed"
  write_state complete success "rollback 完成" true
  append_history success true "manual rollback"
  UPDATE_SUCCESS=1
  rm -rf "$OLD_RUNTIME"
  say "rollback success: $PREVIOUS_BUILD → $CANDIDATE_BUILD"
}

case "${1:-}" in
  bootstrap|start|stop|restart|status|logs|health|credentials|backup|rollback)
    "cmd_$1" "${@:2}"
    ;;
  reset-password) cmd_reset_password "${@:2}" ;;
  preflight-update) cmd_preflight_update "${@:2}" ;;
  update) cmd_update "${@:2}" ;;
  *)
    echo "usage: framework.sh {bootstrap|start|stop|restart|status|logs|health|credentials|reset-password [--generate]|backup|rollback|preflight-update <tar> [sha]|update <tar> [sha]}" >&2
    exit 1
    ;;
esac
