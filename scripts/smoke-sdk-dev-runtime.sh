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
  rm -rf "$WORK" "dist/releases/$ID" ".runtime/dev-data/$ID" ".runtime/dev-data/$ID@w1" \
    ".runtime/persist/conf/sdk-smoke-dr.v1.json"
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

echo "--- 8. Dev Mount：與正式版並存 ---"
SLUG=w1
INST="$ID@$SLUG"
$SDK dev start $ID --slug $SLUG --json | jq "assert d['ok'] and d['instance']=='$INST'" \
  && ok "dev start → 派生實例 $INST" || bad "dev start"
# 並存的核心斷言：正式版全程沒有被頂替
curl -s -H "$AUTH" $B/api/packages/$ID | jq "assert d['package']['source']=='installed'" \
  && ok "正式版仍在（source=installed）" || bad "正式版被頂替"
curl -s -b "$WORK/cookie" $B/packages/$ID/ | grep -q "DEV WORKSPACE" && bad "正式版頁面被注入 DEV banner" || ok "正式版頁面乾淨"
curl -s -b "$WORK/cookie" "$B/packages/$INST/" | grep -q "DEV WORKSPACE" && ok "工作區頁面有 DEV banner" || bad "DEV banner"
curl -s -H "$AUTH" "$B/api/packages/$INST" | jq "assert d['package']['source']=='dev-mount'" \
  && ok "工作區 runtime 來源=dev-mount" || bad "dev-mount source"
# 瀏覽器送出實例 id 時會把 `@` 編成 `%40`。管理台的「停止掛載」就是這樣呼叫的，
# 而路由的 id 字元集裡沒有 `%`——工作區因此停不掉，只回一句 not found。
ENC_INST="${ID}%40${SLUG}"
curl -s -o "$WORK/enc.json" -w '%{http_code}' -H "$AUTH" "$B/api/packages/$ENC_INST" | grep -q 200 \
  && ok "百分號編碼的實例 id 仍能命中路由" || bad "百分號編碼的實例 id 命中路由" 

echo "--- 8b. 服務身分必須實例化 ---"
# 命名空間只做到註冊是不夠的：包會用自己的 service id 去拼 status/pid 路徑，
# 兩個實例就會讀寫同一批檔案，看起來隔離其實沒有。context.services.id() 是唯一解。
curl -s -H "$AUTH" $B/api/stage/services | jq "assert any(s['id']=='sdk-smoke-dr@$SLUG' for s in d['services'])" \
  && ok "工作區 service id 已實例化" || bad "service id 未實例化"
curl -s -H "$AUTH" $B/api/stage/services | jq "assert any(s['id']=='sdk-smoke-dr' for s in d['services'])" \
  && ok "正式版 service id 未被改名" || bad "正式版 service id 被改名"
# 控制端點必須吃得下實例化的 id（`@` 曾被路由正則擋掉）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -X POST "$B/api/stage/services/sdk-smoke-dr@$SLUG/restart")
[ "$CODE" = 200 ] && ok "可用實例 id 控制工作區 service" || bad "實例 service 控制 HTTP $CODE"

# 視圖必須真的列出已掛載的實例。先前這裡用了回傳 Response 的 api() 而非 apiData()，
# 於是頁面永遠顯示「沒有工作區」——API 正確、畫面錯誤，只查 API 抓不到。
# 工作區是磁碟上的目錄，掛載只是其屬性之一——已掛載的必須出現，且帶得出它的頁面
curl -s -H "$AUTH" $B/api/admin/workspaces \
  | jq "assert any(p['mounted'] and p['mount']['instance_id']=='$INST' and p['mount']['pages'] for p in d['projects'])" \
  && ok "工作區視圖列出已掛載專案與其頁面" || bad "工作區視圖未列出實例"
grep -q "apiData('/api/admin/workspaces')" "$ROOT/web/admin/app-core.js" \
  && ok "視圖用 apiData 解析（api 回傳的是 Response）" || bad "工作區視圖用錯 API helper"
# 版面必須與其它管理頁一致：用共用的 valueRow，而不是自造一套 kv-grid
# 只認版式，不認文案：介面文字會改，「用共用 valueRow 而不是自造 kv-grid」才是要守的。
grep -q "valueRow(.*, data.root)" "$ROOT/web/admin/app-core.js" \
  && ! grep -q "kv-grid" "$ROOT/web/admin/app-core.js" \
  && ok "工作區卡片沿用共用 valueRow 版式" || bad "工作區卡片版式與其它頁不一致"
# 未掛載的專案也必須看得見，否則使用者只能開 shell 執行 ls 才知道有什麼
curl -s -H "$AUTH" $B/api/admin/workspaces | jq "assert 'root' in d and 'projects' in d" \
  && ok "視圖以磁碟為準（root + projects）" || bad "工作區視圖仍以掛載為準"

echo "--- 9. 工作區不得佔用全域資源 ---"
# 端口按 package id 分配，工作區實例有自己的 id——它**應該**拿到端口，只是不能與正式版相同。
# 先前一律不給，導致需要端口的包在工作區裡根本起不來（register failed: did not assign port）。
curl -s -H "$AUTH" "$B/api/packages/$INST" > "$WORK/inst.json"
curl -s -H "$AUTH" "$B/api/packages/$ID" > "$WORK/rel.json"
python3 -c "
import json,sys
inst=json.load(open('$WORK/inst.json'))['package'].get('ports') or []
rel=json.load(open('$WORK/rel.json'))['package'].get('ports') or []
ip={p['port'] for p in inst}; rp={p['port'] for p in rel}
assert not (ip & rp), f'workspace shares a port with the release: {ip & rp}'
" && ok "工作區端口與正式版不重疊" || bad "工作區與正式版端口衝突"
# 正式版沒有被 shadow，正式驗證就不該再被拒
$SDK verify-device $ID --json >/dev/null 2>&1 && ok "正式 verify-device 仍可通過" || bad "正式 verify-device 被工作區影響"

echo "--- 10. Web reload / backend 失敗隔離 / 資料隔離 ---"
SEQ0=$(curl -s "$B/api/dev/packages/$INST/events" | jq "print(d['seq'])")
echo "<!-- x -->" >> "$WORK/ws/$ID/web/index.html"; sleep 1
SEQ1=$(curl -s "$B/api/dev/packages/$INST/events" | jq "print(d['seq'])")
[ "$SEQ1" -gt "$SEQ0" ] && ok "改 web → seq bump（瀏覽器自動刷新源）" || bad "web reload seq"
cp "$WORK/ws/$ID/package.mjs" "$WORK/pkg.bak"
echo "not js {" >> "$WORK/ws/$ID/package.mjs"; sleep 1.6
curl -s "$B/api/dev/packages/$INST/events" | jq "assert d['status']=='failed' and d['error']" \
  && ok "壞 backend → failed 帶錯誤" || bad "backend fail"
curl -s -b "$WORK/cookie" "$B/packages/$INST/" | grep -q "載入失敗" && ok "失敗頁顯示原因（不冒充成功）" || bad "失敗頁"
# 壞掉的工作區不得拖垮正式版——這正是並存要買到的東西
curl -s -H "$AUTH" $B/api/packages/$ID | jq "assert d['package']['status']=='loaded'" \
  && ok "工作區壞掉時正式版不受影響" || bad "工作區壞掉波及正式版"
curl -s -m 2 $B/health | grep -q '"ok":true' && ok "Framework 本體存活" || bad "framework 存活"
cp "$WORK/pkg.bak" "$WORK/ws/$ID/package.mjs"; sleep 1.6
curl -s "$B/api/dev/packages/$INST/events" | jq "assert d['status']=='loaded'" \
  && ok "修復 → 自動重載復活" || bad "自動復活"
curl -s -H "$AUTH" -X POST "$B/api/packages/$INST/config" -d '{"interval_ms":9999}' >/dev/null
# Package 的設定改放 config/（正式版在自己的 Package 根下，工作區在自己的隔離資料區下）。
[ -f ".runtime/dev-data/$INST/config/sdk-smoke-dr.v1.json" ] && ok "Dev 配置落隔離區（dev-data）" || bad "dev 資料隔離"
# 工作區資料一律不得落共享存儲：包在開發中寫出的音訊/圖片會被媒體掃描器收進相簿
[ ! -e "/sdcard/termux-os/framework/dev/$INST" ] && ok "Dev 資料未落 /sdcard（避免被媒體掃描）" || bad "Dev 資料落到共享存儲"
# 並存後正式版全程在跑，它**本來就會**建自己的預設配置——那不是污染。
# 要驗的是 Dev 改的值有沒有漏進正式版，所以比對內容而不是比對檔案存在與否。
if [ -f ".runtime/persist/conf/sdk-smoke-dr.v1.json" ]; then
  grep -q "9999" ".runtime/persist/conf/sdk-smoke-dr.v1.json" && bad "正式資料被 Dev 污染" \
    || ok "正式 persist 有自己的配置，未含 Dev 寫入的值"
else
  ok "正式 persist 未被 Dev 觸碰"
fi

echo "--- 11. dev stop 只移除工作區實例 ---"
$SDK dev stop $ID --slug $SLUG --json | jq "assert d['ok'] and d['restored'] is None" \
  && ok "dev stop（無 restore：正式版從未被移走）" || bad "dev stop"
curl -s -H "$AUTH" "$B/api/packages/$INST" | jq "assert not d.get('ok', True)" \
  && ok "工作區實例已消失" || bad "工作區實例殘留"
curl -s -H "$AUTH" $B/api/packages/$ID | jq "assert d['package']['status']=='loaded'" \
  && ok "正式版仍在服務" || bad "正式版丟失"
[ -d "$WORK/ws/$ID" ] && ok "Workspace 保留" || bad "Workspace 被刪"
tf "重複 stop 非零（not_mounted）" $SDK dev stop $ID --slug $SLUG

echo "--- 12. 重啟不自動恢復 Dev Mount ---"
$SDK dev start $ID --slug $SLUG >/dev/null 2>&1
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
