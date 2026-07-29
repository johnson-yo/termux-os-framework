#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: The exports or executable behavior implemented by this file.
# [POS]: scripts/smoke-package-control.sh in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/tmp"
WORK="$(mktemp -d "$ROOT/tmp/package-control-smoke.XXXXXX")"
PORT=$((21500 + $$ % 1000))
BASE="http://127.0.0.1:$PORT"
COOKIE="$WORK/cookie.txt"
PASS=0
FAIL=0

ok() { echo "PASS $*"; PASS=$((PASS + 1)); }
bad() { echo "FAIL $*"; FAIL=$((FAIL + 1)); }

cleanup() {
  if [ "${FW_PID:-0}" -gt 1 ]; then kill "$FW_PID" 2>/dev/null || true; fi
  find "$WORK" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$WORK/home" "$WORK/release/github.termux-os.service.example-counter" \
  "$WORK/persist/conf" "$WORK/persist/data" "$WORK/tmp"
printf 'conf-stays\n' >"$WORK/persist/conf/sentinel"
printf 'data-stays\n' >"$WORK/persist/data/sentinel"
rsync -a --exclude AGENTS.md --exclude HANDOFF.md --exclude .sdk/ \
  "$ROOT/sdk/examples/service-basic/" \
  "$WORK/release/github.termux-os.service.example-counter/"
tar -czf "$WORK/example-counter.tar.gz" -C "$WORK/release" github.termux-os.service.example-counter

node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({
    schema:"termux-os-framework.conf.v1", device_name:"package-control-smoke",
    server:{host:"127.0.0.1",port:Number(process.argv[2])},
    auth:{admin_token:"smoke-password"},
    integrations:{app:{enabled:false,url:"http://127.0.0.1:1",token:""}}
  }, null, 2));
' "$WORK/config.json" "$PORT"

start_server() {
  HOME="$WORK/home" CONFIG="$WORK/config.json" PACKAGES_INSTALLED_DIR="$WORK/packages" \
    PACKAGE_CONTROL_ROOT="$WORK/control" FRAMEWORK_PERSIST_ROOT="$WORK/persist" \
    PACKAGE_JOB_TEST_DELAY_MS=300 TMPDIR="$WORK/tmp" \
    node "$ROOT/src/server.mjs" >"$WORK/framework.log" 2>&1 &
  FW_PID=$!
  for _ in $(seq 1 80); do
    curl -sf -m 1 "$BASE/health" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}

login() {
  rm -f "$COOKIE"
  curl -sf -c "$COOKIE" -H 'Content-Type: application/json' \
    --data '{"password":"smoke-password"}' "$BASE/api/auth/login" >"$WORK/login.json"
  CSRF="$(node -e 'process.stdout.write(require(process.argv[1]).csrf_token)' "$WORK/login.json")"
}

wait_api_job() {
  local id="$1" out="$2"
  for _ in $(seq 1 150); do
    curl -sf -b "$COOKIE" "$BASE/api/admin/package-manager/jobs/$id" >"$out" || true
    STATUS="$(node -e 'try{process.stdout.write(require(process.argv[1]).job.status)}catch{}' "$out" 2>/dev/null)"
    case "$STATUS" in success|failed) return 0 ;; esac
    sleep 0.1
  done
  return 1
}

wait_file_job() {
  local id="$1" file
  file="$WORK/control/jobs/$id.json"
  for _ in $(seq 1 150); do
    STATUS="$(node -e 'try{process.stdout.write(require(process.argv[1]).status)}catch{}' "$file" 2>/dev/null)"
    case "$STATUS" in success|failed) return 0 ;; esac
    sleep 0.1
  done
  return 1
}

echo "=== 030 Package Manager control smoke（隔离、不连手机）==="
echo "--- 1. API gate / inventory ---"
if start_server; then ok "temporary Framework started"; else bad "temporary Framework started"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/package-manager")"
if [ "$CODE" = 401 ]; then ok "Package Manager inventory requires auth"; else bad "inventory auth HTTP $CODE"; fi
login
curl -sf -b "$COOKIE" "$BASE/api/admin/package-manager" >"$WORK/inventory.json"
if node -e 'const d=require(process.argv[1]);process.exit(d.schema==="termux-os.package-manager.v1"
  &&Array.isArray(d.packages)&&Array.isArray(d.broken)&&Array.isArray(d.jobs)?0:1)' "$WORK/inventory.json"; then
  ok "machine-readable inventory schema"
else
  bad "machine-readable inventory schema"
fi

echo "--- 2. Upload / formal preflight ---"
CODE="$(curl -s -o "$WORK/no-csrf.json" -w '%{http_code}' -b "$COOKIE" \
  -H 'Content-Type: application/octet-stream' -H 'X-Filename: example-counter.tar.gz' \
  --data-binary "@$WORK/example-counter.tar.gz" "$BASE/api/admin/package-manager/uploads")"
if [ "$CODE" = 403 ]; then ok "upload without CSRF rejected"; else bad "upload without CSRF HTTP $CODE"; fi
CODE="$(curl -s -o "$WORK/bad-name.json" -w '%{http_code}' -b "$COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/octet-stream' -H 'X-Filename: not-a-release.zip' \
  --data-binary x "$BASE/api/admin/package-manager/uploads")"
if [ "$CODE" = 400 ] && grep -q invalid_archive_name "$WORK/bad-name.json"; then
  ok "non .tar.gz upload rejected"
else
  bad "non .tar.gz upload rejected"
fi
curl -sf -b "$COOKIE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/octet-stream' \
  -H 'X-Filename: example-counter.tar.gz' --data-binary "@$WORK/example-counter.tar.gz" \
  "$BASE/api/admin/package-manager/uploads" >"$WORK/upload.json"
UPLOAD_ID="$(node -e 'process.stdout.write(require(process.argv[1]).upload.id)' "$WORK/upload.json")"
CHECK_JOB="$(node -e 'process.stdout.write(require(process.argv[1]).job.id)' "$WORK/upload.json")"
if [ -n "$UPLOAD_ID" ] && [ -n "$CHECK_JOB" ]; then ok "upload creates persistent preflight job"; else bad "upload creates preflight job"; fi
wait_api_job "$CHECK_JOB" "$WORK/check-job.json" || true
curl -sf -b "$COOKIE" "$BASE/api/admin/package-manager" >"$WORK/checked.json"
if UPLOAD_ID="$UPLOAD_ID" node -e 'const d=require(process.argv[1]);const u=d.uploads.find(x=>x.id===process.env.UPLOAD_ID);
  process.exit(u?.status==="preflight_passed"&&u.identity?.id==="github.termux-os.service.example-counter"
  &&u.identity?.version==="0.1.0"&&u.preflight?.target?.verdict==="generic"?0:1)' "$WORK/checked.json"; then
  ok "formal check returns identity/target/dependencies"
else
  bad "formal check result"
fi
SHA="$(UPLOAD_ID="$UPLOAD_ID" node -e 'const d=require(process.argv[1]);process.stdout.write(d.uploads.find(x=>x.id===process.env.UPLOAD_ID).sha256)' "$WORK/checked.json")"
if [ "$SHA" = "$(sha256sum "$WORK/example-counter.tar.gz" | awk '{print $1}')" ]; then
  ok "upload Release SHA matches bytes"
else
  bad "upload Release SHA"
fi
if [ "$(find "$WORK/tmp" -maxdepth 1 -type d -name 'pkg-check-*' | wc -l)" -eq 0 ]; then
  ok "preflight temporary extraction cleaned"
else
  bad "preflight temporary extraction cleaned"
fi

echo "--- 3. Confirm + detached install across Framework restart ---"
CODE="$(curl -s -o "$WORK/wrong-sha.json" -w '%{http_code}' -b "$COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' --data '{"confirm_sha256":"wrong"}' \
  "$BASE/api/admin/package-manager/uploads/$UPLOAD_ID/install")"
if [ "$CODE" = 409 ] && grep -q confirmation_mismatch "$WORK/wrong-sha.json"; then
  ok "install rejects wrong Release confirmation"
else
  bad "install confirmation guard"
fi
SHA="$SHA" node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({confirm_sha256:process.env.SHA,confirm_unverified:true}))' "$WORK/install-body.json"
curl -sf -b "$COOKIE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  --data-binary "@$WORK/install-body.json" "$BASE/api/admin/package-manager/uploads/$UPLOAD_ID/install" >"$WORK/install-start.json"
INSTALL_JOB="$(node -e 'process.stdout.write(require(process.argv[1]).job.id)' "$WORK/install-start.json")"
kill "$FW_PID" 2>/dev/null || true
wait "$FW_PID" 2>/dev/null || true
FW_PID=0
if wait_file_job "$INSTALL_JOB" && node -e 'process.exit(require(process.argv[1]).status==="success"?0:1)' \
  "$WORK/control/jobs/$INSTALL_JOB.json"; then
  ok "detached install job survives Framework stop"
else
  bad "detached install job survives Framework stop"
fi
if start_server; then ok "Framework restarts after external job"; else bad "Framework restarts after job"; fi
login
curl -sf -b "$COOKIE" "$BASE/api/admin/package-manager" >"$WORK/installed.json"
if node -e 'const d=require(process.argv[1]);const p=d.packages.find(x=>x.id==="github.termux-os.service.example-counter");
  process.exit(p?.version==="0.1.0"&&p.loader_status==="loaded"
  &&d.jobs.some(j=>j.action==="install"&&j.status==="success")?0:1)' "$WORK/installed.json"; then
  ok "restart recovers installed inventory and job result"
else
  bad "installed inventory/job recovery"
fi
echo "--- 3b. Package Setting: port / visibility / lifecycle ---"
curl -sf -b "$COOKIE" "$BASE/api/admin/package-settings" >"$WORK/package-settings.json"
if node -e 'const d=require(process.argv[1]);const p=d.packages.find(x=>x.id==="github.termux-os.service.example-counter");
  process.exit(d.schema==="termux-os.package-settings.v1"&&p?.enabled===true&&p.ports?.length===1?0:1)' "$WORK/package-settings.json"; then
  ok "Package Setting inventory exposes enabled state and ports"
else
  bad "Package Setting inventory"
fi
NEW_PORT="$(node -e 'const d=require(process.argv[1]);const p=d.packages.find(x=>x.id==="github.termux-os.service.example-counter").ports[0].port;process.stdout.write(String(p===9999?9998:p+1))' "$WORK/package-settings.json")"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({confirm_package_id:process.argv[3],ports:[{id:"http",port:Number(process.argv[2]),visibility:"lan"}]}))' \
  "$WORK/setting-save.json" "$NEW_PORT" github.termux-os.service.example-counter
CODE="$(curl -s -o "$WORK/setting-save-response.json" -w '%{http_code}' -b "$COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' --data-binary "@$WORK/setting-save.json" \
  "$BASE/api/admin/package-settings/github.termux-os.service.example-counter")"
if [ "$CODE" = "200" ] && grep -q 'restart_required' "$WORK/setting-save-response.json"; then
  ok "Package Setting saves port and LAN visibility"
else
  bad "Package Setting save HTTP $CODE"
fi
curl -sf -b "$COOKIE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  --data '{"confirm_package_id":"github.termux-os.service.example-counter"}' \
  "$BASE/api/admin/package-settings/github.termux-os.service.example-counter/restart" >"$WORK/setting-restart.json"
if grep -q '"ok":true' "$WORK/setting-restart.json"; then ok "Package Setting restart reloads the Package"; else bad "Package Setting restart"; fi
curl -sf -X POST -b "$COOKIE" -H "X-CSRF-Token: $CSRF" "$BASE/api/stage/services/example-counter/start" >/dev/null
if curl -sf "http://127.0.0.1:$NEW_PORT/health" >/dev/null 2>&1; then
  ok "LAN visibility is applied to the supervised listener"
else
  bad "LAN visibility is applied to the supervised listener"
fi
curl -sf -b "$COOKIE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  --data '{"confirm_package_id":"github.termux-os.service.example-counter"}' \
  "$BASE/api/admin/package-settings/github.termux-os.service.example-counter/disable" >"$WORK/setting-disable.json"
if grep -q '"ok":true' "$WORK/setting-disable.json" && ! curl -sf -b "$COOKIE" "$BASE/api/stage/services" | grep -q 'example-counter'; then
  ok "Package Setting disable stops and unloads the Package"
else
  bad "Package Setting disable"
fi
curl -sf -b "$COOKIE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  --data '{"confirm_package_id":"github.termux-os.service.example-counter"}' \
  "$BASE/api/admin/package-settings/github.termux-os.service.example-counter/enable" >"$WORK/setting-enable.json"
if grep -q '"ok":true' "$WORK/setting-enable.json" \
  && curl -sf "http://127.0.0.1:$NEW_PORT/health" >/dev/null 2>&1; then
  ok "Package Setting enable reloads and starts the Package"
else
  bad "Package Setting enable"
fi
if [ ! -e "$WORK/control/uploads/$UPLOAD_ID.tar.gz" ] \
  && grep -q '"status": "installed"' "$WORK/control/uploads/$UPLOAD_ID.json"; then
  ok "consumed upload bytes cleaned, metadata retained"
else
  bad "consumed upload cleanup"
fi
if curl -sf -b "$COOKIE" "$BASE/packages/github.termux-os.service.example-counter/" | grep -q '/admin/session.js'; then
  ok "newly installed Package opens in shared Browser Session"
else
  bad "installed Package WebUI"
fi

echo "--- 4. Rollback guard / uninstall preservation ---"
CODE="$(curl -s -o "$WORK/no-previous.json" -w '%{http_code}' -b "$COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' \
  --data '{"confirm_package_id":"github.termux-os.service.example-counter","confirm_previous_version":null}' \
  "$BASE/api/admin/package-manager/packages/github.termux-os.service.example-counter/rollback")"
if [ "$CODE" = 409 ] && grep -q preflight_required "$WORK/no-previous.json"; then
  ok "rollback hidden/blocked without previous version"
else
  bad "rollback previous-version guard"
fi
CODE="$(curl -s -o "$WORK/wrong-id.json" -w '%{http_code}' -b "$COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' --data '{"confirm_package_id":"wrong"}' \
  "$BASE/api/admin/package-manager/packages/github.termux-os.service.example-counter/uninstall")"
if [ "$CODE" = 409 ] && grep -q confirmation_mismatch "$WORK/wrong-id.json"; then
  ok "uninstall rejects wrong Package confirmation"
else
  bad "uninstall confirmation guard"
fi
curl -sf -b "$COOKIE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  --data '{"confirm_package_id":"github.termux-os.service.example-counter"}' \
  "$BASE/api/admin/package-manager/packages/github.termux-os.service.example-counter/uninstall" >"$WORK/uninstall-start.json"
UNINSTALL_JOB="$(node -e 'process.stdout.write(require(process.argv[1]).job.id)' "$WORK/uninstall-start.json")"
wait_api_job "$UNINSTALL_JOB" "$WORK/uninstall-job.json" || true
if node -e 'process.exit(require(process.argv[1]).job.status==="success"?0:1)' "$WORK/uninstall-job.json" \
  && [ ! -e "$WORK/packages/github.termux-os.service.example-counter" ]; then
  ok "formal Package Manager uninstall job succeeds"
else
  bad "uninstall job"
fi
if grep -q conf-stays "$WORK/persist/conf/sentinel" && grep -q data-stays "$WORK/persist/data/sentinel"; then
  ok "uninstall preserves persistent config/data"
else
  bad "uninstall preserves config/data"
fi
if [ -s "$WORK/control/history.v1.jsonl" ] && [ ! -e "$WORK/control/job.lock" ]; then
  ok "job history persists and lock is released"
else
  bad "job history/lock cleanup"
fi

echo "--- 5. UI contract ---"
# Installed 卡片必須是一排六格且位置固定——按鈕隨狀態消失會讓版位跳動
if grep -q "six-up" "$ROOT/web/admin/admin-controls.js" \
  && grep -q "grid-template-columns: repeat(6, 1fr)" "$ROOT/web/admin/style.css" \
  && grep -q "startPackageUpgrade" "$ROOT/web/admin/admin-controls.js" \
  && grep -q "startPackageDev" "$ROOT/web/admin/admin-controls.js"; then
  ok "Installed cards expose six fixed actions including Update and Dev"
else
  bad "Installed card action row"
fi
# Dev 需要 Installed Root 的位置才能派生副本
grep -q "installed_dir: dir" "$ROOT/src/system/package-control.mjs" \
  && ok "installed_dir is exposed for deriving a workspace" || bad "installed_dir missing"

# 分頁標題：Available 的計數沒有資訊量（列表本身就看得到）；
# Installed 的括號改為**可升級數**，那才是需要一眼看到的。
# 認的是三個分頁的存在與可升級計數這個機制，不是它們當下的文案。
if grep -q "upgradable ?" "$ROOT/web/admin/admin-controls.js" \
  && grep -q "\['installed'," "$ROOT/web/admin/admin-controls.js" \
  && grep -q "\['registry'," "$ROOT/web/admin/admin-controls.js" \
  && grep -q "\['upload'," "$ROOT/web/admin/admin-controls.js" \
  && grep -q '/api/admin/package-registry/refresh' "$ROOT/web/admin/admin-controls.js" \
  && grep -q 'confirm-dialog' "$ROOT/web/admin/index.html" && grep -q 'package-grid' "$ROOT/web/admin/style.css"; then
  ok "Installed/Pending install/Available/Install from file + explicit confirmation UI present"
else
  bad "Package Manager UI contract"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
exit "$FAIL"
