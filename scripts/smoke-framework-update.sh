#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: The exports or executable behavior implemented by this file.
# [POS]: scripts/smoke-framework-update.sh in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/tmp"
TMP="$(mktemp -d "$ROOT/tmp/framework-update-smoke.XXXXXX")"
HOME_FAKE="$TMP/home"
RUNTIME="$HOME_FAKE/.termux-os/framework"
PERSIST="$TMP/persist"
CONTROL="$HOME_FAKE/framework.sh"
INSTALLED="$HOME_FAKE/.termux-os/packages"
ASSETS="$TMP/assets"
PORT=$((19000 + $$ % 1000))
BASE_URL="http://127.0.0.1:$PORT"
TOKEN=smoke-password
PASS=0
FAIL=0

ok() { echo "PASS $*"; PASS=$((PASS + 1)); }
bad() { echo "FAIL $*"; FAIL=$((FAIL + 1)); }
need() { "$@" && ok "$*" || bad "$*"; }

run_control() {
  FRAMEWORK_RUNTIME="$RUNTIME" FRAMEWORK_PERSIST="$PERSIST" FRAMEWORK_CONFIG="$PERSIST/conf/framework.v1.json" \
    FRAMEWORK_CONTROL="$CONTROL" FRAMEWORK_PORT="$PORT" FRAMEWORK_BASE_URL="$BASE_URL" \
    BROWSER_SESSION_PATH="$HOME_FAKE/.termux-os/browser-sessions.v1.json" \
    FRAMEWORK_ASSET_ROOT="$ASSETS" PACKAGES_INSTALLED_DIR="$INSTALLED" \
    bash "$CONTROL" "$@"
}

api() {
  curl -sf -m 8 -H "Authorization: Bearer $TOKEN" "$BASE_URL$1"
}

cleanup() {
  run_control stop >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

build_candidate() {
  local build="$1" mode="${2:-good}" out tree
  out="$TMP/candidates/$build"
  tree="$out/tree/framework"
  rm -rf "$out"
  mkdir -p "$tree"
  rsync -a --exclude-from="$ROOT/.deployignore" "$ROOT/" "$tree/"
  printf '%s\n' "$build" > "$tree/.deploy-id"
  case "$mode" in
    good) ;;
    broken) rm -f "$tree/web/admin/index.html" ;;
    hanging)
      printf '%s\n' "setInterval(() => {}, 1000);" > "$tree/src/server.mjs"
      ;;
    *) return 1 ;;
  esac
  tar -czf "$out/framework-$build.tar.gz" -C "$out/tree" framework
  printf '%s  %s\n' "$(sha256sum "$out/framework-$build.tar.gz" | awk '{print $1}')" \
    "framework-$build.tar.gz" > "$out/framework-$build.tar.gz.sha256"
}

echo "=== 030 Framework Update smoke（隔離、不連手機）==="
mkdir -p "$RUNTIME" "$PERSIST/conf" "$PERSIST/data" "$INSTALLED" "$ASSETS"
rsync -a --exclude-from="$ROOT/.deployignore" "$ROOT/" "$RUNTIME/"
printf 'old-build\n' > "$RUNTIME/.deploy-id"
cp "$ROOT/scripts/framework.sh" "$CONTROL"
chmod +x "$CONTROL"
CONTROL_SHA_BEFORE="$(sha256sum "$CONTROL" | awk '{print $1}')"
cp "$ROOT/config/defaults/framework.v1.json" "$PERSIST/conf/framework.v1.json"
node -e 'const fs=require("fs"),p=process.argv[1],d=require(p);d.auth={admin_token:"smoke-password",admin_password:"smoke-password"};fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' \
  "$PERSIST/conf/framework.v1.json"
printf '{"schema":"termux-os-framework.stage.conf.v1","services":{"example-counter":{"desired":"running"}}}\n' \
  > "$PERSIST/conf/stage.v1.json"
printf 'user-data-must-stay\n' > "$PERSIST/data/sentinel.txt"
printf 'asset-must-stay\n' > "$ASSETS/sentinel.bin"

# 一個真 Installed Service：更新後必須從同一 active.json 載入並恢復 desired=running。
PKG=github.termux-os.service.example-counter
mkdir -p "$INSTALLED/$PKG/versions/0.1.0"
rsync -a "$ROOT/sdk/examples/service-basic/" "$INSTALLED/$PKG/versions/0.1.0/"
printf '{"schema":"termux-os.package-active.v1","id":"%s","active_version":"0.1.0","active_target":"generic","previous_version":null,"archive_sha256":"smoke-sha","installed_at":"2026-07-19T00:00:00Z","hashes":{"0.1.0@generic":"smoke-sha"}}\n' "$PKG" \
  > "$INSTALLED/$PKG/active.json"

mkdir -p "$RUNTIME/.runtime/observations"
printf '{"schema":"termux-os.observations.v1","observations":[{"observation_id":"sentinel"}]}\n' \
  > "$RUNTIME/.runtime/observations/observations.v1.json"

build_candidate good-build
build_candidate broken-build broken
build_candidate interrupted-build hanging
GOOD="$TMP/candidates/good-build/framework-good-build.tar.gz"
BROKEN="$TMP/candidates/broken-build/framework-broken-build.tar.gz"
INTERRUPTED="$TMP/candidates/interrupted-build/framework-interrupted-build.tar.gz"

echo "--- 1. 舊版本啟動與完整性 ---"
run_control bootstrap >/dev/null
if run_control start >/dev/null; then ok "old runtime started"; else bad "old runtime started"; fi
if api /api/admin/integrity | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);
  process.exit(d.ok&&d.schema==="termux-os.framework-integrity.v1"&&d.features?.admin_integrity===1?0:1)})'; then
  ok "integrity endpoint";
else
  bad "integrity endpoint";
fi
if curl -sf "$BASE_URL/api/features" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);
  process.exit(d.schema==="termux-os.framework-features.v1"&&d.features?.dev_runtime===1?0:1)})'; then
  ok "feature negotiation endpoint"
else
  bad "feature negotiation endpoint"
fi
if api /api/stage/services | node -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);
  const x=d.services.find(v=>v.id==="example-counter");process.exit(x?.desired==="running"&&x?.process?.state==="running"?0:1)})'; then
  ok "Desired Service initial restore"
else
  bad "Desired Service initial restore"
fi
ACTIVE_SHA_BEFORE="$(sha256sum "$INSTALLED/$PKG/active.json" | awk '{print $1}')"
CONF_SHA_BEFORE="$(sha256sum "$PERSIST/conf/framework.v1.json" "$PERSIST/conf/stage.v1.json" | sha256sum | awk '{print $1}')"
OBSERVATIONS_SHA_BEFORE="$(sha256sum "$RUNTIME/.runtime/observations/observations.v1.json" | awk '{print $1}')"

echo "--- 2. preflight + 正常 update ---"
if run_control preflight-update "$GOOD" "$GOOD.sha256"; then ok "candidate preflight"; else bad "candidate preflight"; fi
if run_control update "$GOOD" "$GOOD.sha256"; then ok "atomic update"; else bad "atomic update"; fi
need test "$(curl -sf "$BASE_URL/api/dev/version" | node -pe 'JSON.parse(require("fs").readFileSync(0)).deploy_id')" = good-build
if tar -tzf "$PERSIST/backups/last-good.tar.gz" | grep -qE '(^|/)AGENTS\.md$'; then
  bad "last-good contains sandbox-sensitive AGENTS symlink"
else
  ok "last-good omits sandbox-sensitive AGENTS symlink"
fi
need test "$(sha256sum "$CONTROL" | awk '{print $1}')" = "$CONTROL_SHA_BEFORE"
need test "$(sha256sum "$INSTALLED/$PKG/active.json" | awk '{print $1}')" = "$ACTIVE_SHA_BEFORE"
need test "$(sha256sum "$PERSIST/conf/framework.v1.json" "$PERSIST/conf/stage.v1.json" | sha256sum | awk '{print $1}')" = "$CONF_SHA_BEFORE"
need grep -q user-data-must-stay "$PERSIST/data/sentinel.txt"
need grep -q asset-must-stay "$ASSETS/sentinel.bin"
need test "$(sha256sum "$RUNTIME/.runtime/observations/observations.v1.json" | awk '{print $1}')" = "$OBSERVATIONS_SHA_BEFORE"
if api /api/stage/services | node -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);
  const x=d.services.find(v=>v.id==="example-counter");process.exit(x?.desired==="running"&&x?.process?.state==="running"?0:1)})'; then
  ok "Desired Service restored after update"
else
  bad "Desired Service restored after update"
fi

echo "--- 3. durable last-good manual rollback ---"
if run_control rollback >/dev/null; then ok "manual rollback"; else bad "manual rollback"; fi
need test "$(curl -sf "$BASE_URL/api/dev/version" | node -pe 'JSON.parse(require("fs").readFileSync(0)).deploy_id')" = old-build
if run_control update "$GOOD" "$GOOD.sha256" >/dev/null; then ok "second update"; else bad "second update"; fi

echo "--- 4. active Dev Mount 拒絕且不動 live ---"
DEV_ID=github.termux-os.fixture.valid
DEV_WS="$ROOT/src/packages/fixtures/$DEV_ID"
if curl -sf -m 8 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"package_id\":\"$DEV_ID\",\"workspace\":\"$DEV_WS\"}" "$BASE_URL/api/dev/packages" \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.exit(JSON.parse(s).ok?0:1))'; then
  ok "Dev Mount active"
else
  bad "Dev Mount active"
fi
if run_control update "$GOOD" "$GOOD.sha256" >/dev/null 2>&1; then bad "active Dev update refused"; else ok "active Dev update refused"; fi
need test "$(curl -sf "$BASE_URL/api/dev/version" | node -pe 'JSON.parse(require("fs").readFileSync(0)).deploy_id')" = good-build
curl -sf -m 8 -X POST -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/dev/packages/$DEV_ID/stop" >/dev/null || bad "Dev Mount stop"

echo "--- 5. SIGKILL 中斷由下一次調用收口 ---"
FRAMEWORK_RUNTIME="$RUNTIME" FRAMEWORK_PERSIST="$PERSIST" \
  FRAMEWORK_CONFIG="$PERSIST/conf/framework.v1.json" FRAMEWORK_CONTROL="$CONTROL" \
  FRAMEWORK_PORT="$PORT" FRAMEWORK_BASE_URL="$BASE_URL" FRAMEWORK_ASSET_ROOT="$ASSETS" \
  PACKAGES_INSTALLED_DIR="$INSTALLED" \
  bash "$CONTROL" update "$INTERRUPTED" "$INTERRUPTED.sha256" >/dev/null 2>&1 &
INTERRUPTED_PID=$!
REACHED=0
for _ in $(seq 1 100); do
  if [ -f "$PERSIST/updates/state.v1.json" ] \
    && [ "$(node -e 'const d=require(process.argv[1]);process.stdout.write(d.stage||"")' \
      "$PERSIST/updates/state.v1.json")" = start ]; then
    REACHED=1
    break
  fi
  sleep 0.1
done
if [ "$REACHED" = 1 ]; then ok "interrupted update reached switched runtime"; else bad "interrupted update reached switched runtime"; fi
kill -KILL "$INTERRUPTED_PID" 2>/dev/null || true
wait "$INTERRUPTED_PID" 2>/dev/null || true
if run_control update "$GOOD" "$GOOD.sha256" >/dev/null; then
  ok "next update recovered interruption and completed"
else
  bad "next update recovered interruption and completed"
fi
need test "$(curl -sf "$BASE_URL/api/dev/version" | node -pe 'JSON.parse(require("fs").readFileSync(0)).deploy_id')" = good-build
need grep -q 'interrupted update recovered' "$PERSIST/updates/history.v1.jsonl"

echo "--- 6. Post-check 失敗自動 rollback ---"
if run_control update "$BROKEN" "$BROKEN.sha256" >/dev/null 2>&1; then
  bad "broken candidate rejected"
else
  ok "broken candidate rejected"
fi
need test "$(curl -sf "$BASE_URL/api/dev/version" | node -pe 'JSON.parse(require("fs").readFileSync(0)).deploy_id')" = good-build
if node -e 'const d=require(process.argv[1]);process.exit(d.status==="failed_rolled_back"&&d.rollback?0:1)' \
  "$PERSIST/updates/state.v1.json"; then
  ok "failure evidence says failed_rolled_back"
else
  bad "failure evidence says failed_rolled_back"
fi
need grep -q '"result":"failed"' "$PERSIST/updates/history.v1.jsonl"
need grep -q user-data-must-stay "$PERSIST/data/sentinel.txt"
need test "$(sha256sum "$RUNTIME/.runtime/observations/observations.v1.json" | awk '{print $1}')" = "$OBSERVATIONS_SHA_BEFORE"

echo "--- 7. unhealthy 不能覆蓋 last-good ---"
run_control stop >/dev/null
if run_control backup >/dev/null 2>&1; then bad "unhealthy backup rejected"; else ok "unhealthy backup rejected"; fi
if run_control start >/dev/null; then ok "runtime restart after negative test"; else bad "runtime restart after negative test"; fi

echo "--- 8. 把整份預設寫出來的舊 conf 規範化，不算越界 ---"
# 舊版本安裝的設備，conf 裡是整份預設。新版本啟動時會把它改寫成只留覆蓋項——
# 邊界檢查若比對位元組就會把這當成竄改而回滾，於是那些設備一個也更新不上來。
FP_BEFORE=$(node "$RUNTIME/scripts/conf-fingerprint.mjs" "$PERSIST/conf/framework.v1.json")
node -e '
  const fs = require("fs");
  const defaults = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const stored = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[1], JSON.stringify({ ...defaults, ...stored }, null, 2) + "\n");
' "$PERSIST/conf/framework.v1.json" "$RUNTIME/config/defaults/framework.v1.json"
FP_MATERIALISED=$(node "$RUNTIME/scripts/conf-fingerprint.mjs" "$PERSIST/conf/framework.v1.json")
if [ "$FP_BEFORE" = "$FP_MATERIALISED" ]; then
  ok "寫出預設值不改變使用者設定指紋"
else
  bad "寫出預設值不改變使用者設定指紋"
fi
node -e '
  const fs = require("fs");
  const stored = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  stored.device_name = "someone-else";
  fs.writeFileSync(process.argv[1], JSON.stringify(stored, null, 2) + "\n");
' "$PERSIST/conf/framework.v1.json"
if [ "$FP_BEFORE" != "$(node "$RUNTIME/scripts/conf-fingerprint.mjs" "$PERSIST/conf/framework.v1.json")" ]; then
  ok "改動使用者選過的值仍然被抓到"
else
  bad "改動使用者選過的值仍然被抓到"
fi

echo "--- 9. 舊版本的 core-check 仍然接受這個候選 ---"
# 更新期間跑 post-check 的是**舊版本的**控制器。任何改動了它所檢查的回應的變更，
# 都會讓每一次從舊版本上來的更新失敗回滾——也就是新版本誰都裝不上，而且症狀
# 出現在使用者的設備上，不在這裡。所以這些契約要當場釘住。
ENTRY_CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE_URL/admin")
if [ "$ENTRY_CODE" = 200 ]; then ok "/admin 回 200（舊 core-check 的硬性要求）"; else bad "/admin 回 200" "http=$ENTRY_CODE"; fi
if curl -sf -m 5 "$BASE_URL/api/features" | grep -q '"browser_session"'; then
  ok "feature schema 仍宣告 browser_session"
else
  bad "feature schema 仍宣告 browser_session"
fi
if curl -sf -m 5 "$BASE_URL/health" >/dev/null; then ok "/health 可用"; else bad "/health 可用"; fi

echo "--- 10. 起不來的 Framework 仍然更新得動 ---"
# 一個因為配置或程式碼而起不來的 Framework，正是最需要更新的那一個。
# 這裡曾經直接拒絕，於是設備卡死在壞掉的版本上，只能開 shell 手動救——而使用者沒有 shell。
LAST_GOOD_BEFORE="$(sha256sum "$PERSIST/backups/last-good.tar.gz" | awk '{print $1}')"
run_control stop >/dev/null 2>&1 || true
if run_control update "$GOOD" "$GOOD.sha256" >/dev/null 2>&1; then
  ok "current 不健康時仍可更新"
else
  bad "current 不健康時仍可更新"
fi
need test "$(curl -sf "$BASE_URL/api/dev/version" | node -pe 'JSON.parse(require("fs").readFileSync(0)).deploy_id')" = good-build
# 壞掉的版本不得覆蓋已知good的備份，否則「還能退回去」這個保證就沒了。
if [ "$(sha256sum "$PERSIST/backups/last-good.tar.gz" | awk '{print $1}')" = "$LAST_GOOD_BEFORE" ]; then
  ok "不健康時保留既有 last-good 不覆蓋"
else
  bad "不健康時保留既有 last-good 不覆蓋"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
exit "$FAIL"
