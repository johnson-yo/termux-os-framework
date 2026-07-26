#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: The exports or executable behavior implemented by this file.
# [POS]: scripts/smoke-sdk-dev-runtime.sh in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
SDK=./sdk/termux-os-sdk
PORT=8973
B=http://127.0.0.1:$PORT
TOKEN=smoke-password
AUTH="Authorization: Bearer $TOKEN"
ID=github.termux-os.service.sdk-smoke-dr
mkdir -p "$ROOT/tmp"
WORK=$(mktemp -d "$ROOT/tmp/sdk-dev-smoke.XXXXXX")
FWPID=""

export TERMUX_OS_DEV_ROOT=$WORK/ws
export TERMUX_OS_SDK_HOME=$WORK/sdkhome
export TERMUX_OS_FRAMEWORK_URL=$B
export TERMUX_OS_TOKEN=$TOKEN
export PACKAGES_INSTALLED_DIR=$WORK/installed

cleanup() {
  [ -n "$FWPID" ] && kill "$FWPID" 2>/dev/null
  rm -rf "$WORK" "dist/releases/$ID" ".runtime/dev-data/$ID"
}
trap cleanup EXIT
mkdir -p "$WORK/installed" "$WORK/ws"

pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1${2:+ — $2}"; fail=$((fail+1)); }
t()  { local n=$1; shift; "$@" >/dev/null 2>&1 && ok "$n" || bad "$n"; }
tf() { local n=$1; shift; "$@" >/dev/null 2>&1 && bad "$n（本應失敗）" || ok "$n"; }
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);$1"; }

start_fw() {
  FRAMEWORK_ADMIN_TOKEN=$TOKEN FRAMEWORK_ADMIN_PASSWORD=$TOKEN \
    PACKAGES_INSTALLED_DIR=$WORK/installed BROWSER_SESSION_PATH=$WORK/browser-sessions.v1.json \
    HOST=127.0.0.1 PORT=$PORT node src/server.mjs >"$WORK/fw.log" 2>&1 &
  FWPID=$!
  for _ in $(seq 1 30); do
    if curl -s -m 1 $B/health >/dev/null 2>&1; then
      curl -s -c "$WORK/cookie" -H 'Content-Type: application/json' \
        -d "{\"password\":\"$TOKEN\"}" "$B/api/auth/login" >/dev/null
      return 0
    fi
    sleep 0.2
  done
  echo "framework 起不來"; tail -5 "$WORK/fw.log"; exit 1
}
stop_fw() { [ -n "$FWPID" ] && kill "$FWPID" 2>/dev/null; wait "$FWPID" 2>/dev/null; FWPID=""; }

echo "=== 029 Dev Runtime smoke（不連手機）==="

echo "--- 0. Runtime Access ---"
t "access 默認本機（不可達仍列 URL，退出 0）" $SDK access $ID
$SDK access --framework-url http://127.0.0.1:1 x.y.service.z --json 2>/dev/null \
  | jq "assert d['connection']=='url-only' and d['transport']=='none' and not d['reachable']" \
  && ok "URL-only connection（無 transport、如實不可達）" || bad "URL-only connection"
tf "connection 不存在非零" $SDK access --connection no-such-conn
$SDK access --connection no-such-conn --json 2>/dev/null | grep -q connection_not_found \
  && ok "connection_not_found 帶 code" || bad "connection not found code"
mkdir -p "$WORK/sdkhome/connections"
cat > "$WORK/sdkhome/connections/urlonly.json" <<EOF
{"schema":"termux-os.connection.v1","name":"urlonly","framework_url":"$B","transport":{"type":"none"}}
EOF
t "profile（transport=none）可解析" $SDK access --connection urlonly

echo "--- 1. Workspace 建立 ---"
$SDK new --type service --id $ID --name "DR Smoke" --workspace "$WORK/ws" --json \
  | jq "assert '--workspace' in d['location']" && ok "new 明示落點（--workspace）" || bad "new location"
[ -f "$WORK/ws/$ID/.sdk/project.v1.json" ] && [ -f "$WORK/ws/$ID/RELEASE_NOTES.md" ] \
  && [ -f "$WORK/ws/$ID/scripts/verify-device.mjs" ] && [ ! -f "$WORK/ws/$ID/HANDOFF.md" ] \
  && ok "骨架含 .sdk/+RELEASE_NOTES+verify hook、無根 HANDOFF" || bad "workspace 骨架"

echo "--- 2. release 排除與 sidecar ---"
touch "$WORK/ws/$ID/HANDOFF.md"
$SDK handoff $ID >/dev/null 2>&1
t "workspace 包可 release（pack --source）" $SDK release $ID
TAR=dist/releases/$ID/0.1.0/$ID-0.1.0.tar.gz
[ -f "$TAR.source-hash" ] && ok "source-hash sidecar 落 dist" || bad "source-hash sidecar"
tar tzf "$TAR" | grep -qE "/\.sdk/|HANDOFF\.md" && bad "archive 混入開發狀態" || ok "archive 無 .sdk/ 無 HANDOFF.md"
tar tzf "$TAR" | grep -q RELEASE_NOTES.md && ok "RELEASE_NOTES 隨包凍結" || bad "RELEASE_NOTES 在包內"

echo "--- 3. status（Framework 不可達）---"
$SDK status $ID --json | jq "assert 'unknown' in d['drift'] and not d['reachable']" \
  && ok "不可達 → drift=unknown（不猜 clean）" || bad "unknown drift"

echo "--- 4. install 路徑與安裝 ---"
tf "壞相對路徑非零" $SDK install no/such/dir/x.tar.gz
$SDK install no/such/dir/x.tar.gz --json 2>/dev/null | grep -c "$(pwd)" >/dev/null \
  && ok "錯誤列出實測絕對路徑" || bad "install 路徑錯誤提示"
OUT=$($SDK install "$TAR" 2>&1) && ok "本機 install（絕對路徑，零傳輸）" || bad "本機 install" "$OUT"
echo "$OUT" | grep -q "desired=" && ok "install 後輸出真實狀態行" || bad "install 狀態輸出"
echo "$OUT" | grep -q "verify-device" && ok "install 輸出下一步 verify-device" || bad "install next"

echo "--- 5. 起 Framework：status 對齊 ---"
start_fw
$SDK status $ID --json | jq "assert d['drift']==['clean'] and d['installed']['version']=='0.1.0'" \
  && ok "install 對齊 → drift=clean" || bad "clean drift"
$SDK status $ID --json | jq "
for k in ['workspace','dev_runtime','last_release','installed','running','device_verify','drift']: assert k in d" \
  && ok "status runtime fields 齊全" || bad "status runtime fields"

echo "--- 6. verify-device（installed 綁定）---"
FRAMEWORK_URL=$B $SDK verify-device $ID --json >/dev/null 2>&1 && ok "verify-device pass" || bad "verify-device"
SHA=$(cut -d' ' -f1 "$TAR.sha256")
python3 -c "
import json; d=json.load(open('$WORK/ws/$ID/.sdk/verify.v1.json'))
assert d['result']=='pass' and d['release_sha256']=='$SHA' and d['version']=='0.1.0'" \
  && ok "verify 記錄綁 release sha+version" || bad "verify 綁定"

echo "--- 8. Dev Mount / Shadow ---"
$SDK dev start $ID --json | jq "assert d['ok'] and d['shadow']['version']=='0.1.0'" \
  && ok "dev start + shadow Installed 0.1.0" || bad "dev start"
curl -s -b "$WORK/cookie" $B/packages/$ID/ | grep -q "DEV WORKSPACE" && ok "頁面注入 DEV banner" || bad "DEV banner"
curl -s -H "$AUTH" $B/api/packages/$ID | jq "assert d['package']['source']=='dev-mount'" \
  && ok "runtime 來源=dev-mount" || bad "dev-mount source"
$SDK status $ID --json | jq "assert 'dev-shadowing-installed' in d['drift']" \
  && ok "drift=dev-shadowing-installed" || bad "shadow drift"

echo "--- 9. Dev shadow 不可作正式驗證 ---"
tf "正式 verify-device 拒 shadow" $SDK verify-device $ID

echo "--- 10. Web reload / backend 失敗隔離 / 資料隔離 ---"
SEQ0=$(curl -s $B/api/dev/packages/$ID/events | jq "print(d['seq'])")
echo "<!-- x -->" >> "$WORK/ws/$ID/web/index.html"; sleep 1
SEQ1=$(curl -s $B/api/dev/packages/$ID/events | jq "print(d['seq'])")
[ "$SEQ1" -gt "$SEQ0" ] && ok "改 web → seq bump（瀏覽器自動刷新源）" || bad "web reload seq"
cp "$WORK/ws/$ID/package.mjs" "$WORK/pkg.bak"
echo "not js {" >> "$WORK/ws/$ID/package.mjs"; sleep 1.6
curl -s $B/api/dev/packages/$ID/events | jq "assert d['status']=='failed' and d['error']" \
  && ok "壞 backend → failed 帶錯誤" || bad "backend fail"
curl -s -b "$WORK/cookie" $B/packages/$ID/ | grep -q "載入失敗" && ok "失敗頁顯示原因（不冒充成功）" || bad "失敗頁"
curl -s -m 2 $B/health | grep -q '"ok":true' && ok "Framework 本體存活" || bad "framework 存活"
cp "$WORK/pkg.bak" "$WORK/ws/$ID/package.mjs"; sleep 1.6
curl -s $B/api/dev/packages/$ID/events | jq "assert d['status']=='loaded'" \
  && ok "修復 → 自動重載復活" || bad "自動復活"
curl -s -H "$AUTH" -X POST $B/api/packages/$ID/config -d '{"interval_ms":9999}' >/dev/null
[ -f ".runtime/dev-data/$ID/conf/sdk-smoke-dr.v1.json" ] && ok "Dev 配置落隔離區（dev-data）" || bad "dev 資料隔離"
[ ! -f ".runtime/persist/conf/sdk-smoke-dr.v1.json" ] && ok "正式 persist 未被 Dev 污染" || bad "正式資料被污染"

echo "--- 11. dev stop 恢復 ---"
$SDK dev stop $ID --json | jq "assert d['restored']['version']=='0.1.0'" \
  && ok "dev stop → 恢復 Installed 0.1.0" || bad "dev stop 恢復"
curl -s -b "$WORK/cookie" $B/packages/$ID/ | grep -q "DEV WORKSPACE" && bad "停後仍有 DEV banner" || ok "恢復後無 DEV banner"
[ -d "$WORK/ws/$ID" ] && ok "Workspace 保留" || bad "Workspace 被刪"
tf "重複 stop 非零（not_mounted）" $SDK dev stop $ID

echo "--- 12. 重啟不自動恢復 Dev Mount ---"
$SDK dev start $ID >/dev/null 2>&1
stop_fw; start_fw
curl -s -H "$AUTH" $B/api/dev/packages | jq "assert d['mounts']==[]" \
  && ok "重啟後 Dev Mount 不自動恢復" || bad "重啟恢復策略"
grep -q "stale dev mount" "$WORK/fw.log" && ok "殘留如實告知（日誌）" || bad "stale 提示"
curl -s -H "$AUTH" $B/api/packages/$ID | jq "assert d['package']['source']=='installed'" \
  && ok "重啟後跑的是 Installed" || bad "重啟後來源"

stop_fw
echo
echo "PASS=$pass FAIL=$fail"
[ $fail -eq 0 ] || exit 1
