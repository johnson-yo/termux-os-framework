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
  rm -rf "$WORK" "dist/releases/$ID" ".runtime/persist/conf/sdk-smoke-dr.v1.json"
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
# .sdk/ 落在工作樹之外（兄弟目錄）：它是開發痕跡不是包的內容，寫進去會讓
# `new` 生成的包在第一秒就已經是 dev。
[ -f "$WORK/ws/$ID.sdk/project.v1.json" ] && [ -f "$WORK/ws/$ID/RELEASE_NOTES.md" ] \
  && [ -f "$WORK/ws/$ID/scripts/verify-device.mjs" ] && [ ! -f "$WORK/ws/$ID/HANDOFF.md" ] \
  && [ ! -e "$WORK/ws/$ID/.sdk" ] \
  && ok "骨架含 .sdk/+RELEASE_NOTES+verify hook、無根 HANDOFF、工作樹無 .sdk" || bad "workspace 骨架"

echo "--- 2. release 產出 shallow-Git asset ---"
# ⭐ 正式 release 現在要求來源是一個乾淨的 Git 倉庫：package asset 帶真實 shallow
#    baseline，裝到設備上才可能「解包即用、Git 即狀態」。
GW="$WORK/ws/$ID"
git -C "$GW" init -q -b main
git -C "$GW" config user.name Smoke; git -C "$GW" config user.email s@e
git -C "$GW" remote add origin https://github.com/example/dr-smoke.git
git -C "$GW" add -A && git -C "$GW" commit -qm "release: 0.1.0"
$SDK handoff $ID >/dev/null 2>&1
t "release 產出 package asset" $SDK release $ID
TAR=dist/releases/$ID/0.1.0/$ID-0.1.0.tar.gz
[ -f "$TAR.sha256" ] && ok "sha256 sidecar 落 dist" || bad "sha256 sidecar"
tar tzf "$TAR" | grep -q "/\.git/" && ok "asset 帶真實 .git" || bad "asset 缺 .git"
python3 -c "
import json,sys; d=json.load(open('$TAR.asset.json'))
assert d['shallow'] is True, d
assert d['branch']=='main', d
assert d['origin']=='https://github.com/example/dr-smoke.git', d
assert len(d['head'])==40, d" && ok "asset 身份：shallow+具名分支+origin+HEAD" || bad "asset 身份"
tar tzf "$TAR" | grep -qE "/\.sdk/|HANDOFF\.md" && bad "archive 混入開發狀態" || ok "archive 無 .sdk/ 無 HANDOFF.md"
tar tzf "$TAR" | grep -q RELEASE_NOTES.md && ok "RELEASE_NOTES 隨包凍結" || bad "RELEASE_NOTES 在包內"
# ⚠ 未提交的樹默認被拒：正式包不能悄悄帶上本地改動。dirty 產物必須仍是同一種包，
#    裝上去自然判 dev——而不是另一個 package type / channel。
DIRTY_TAR="$WORK/dirty/$ID-0.1.0.tar.gz"
echo "// dirty" >> "$GW/package.mjs"
tf "dirty 來源默認拒絕 release" $SDK release $ID
t "--allow-dirty 產出本地開發產物" $SDK release $ID --allow-dirty --artifact-dir "$WORK/dirty"
tar tzf "$DIRTY_TAR" | grep -q "/\.git/" && ok "dirty 產物仍是同一種包（帶 .git）" || bad "dirty 產物格式"
git -C "$GW" checkout -- package.mjs

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
import json; d=json.load(open('$WORK/ws/$ID.sdk/verify.v1.json'))
assert d['result']=='pass' and d['release_sha256']=='$SHA' and d['version']=='0.1.0'" \
  && ok "verify 記錄綁 release sha+version" || bad "verify 綁定"

echo "--- 8. 單一實體：dev start 不建立第二個 package ---"
# ⭐ 舊模型讓工作區以 `<id>@<slug>` 另起一個實例，與正式版並排運行。新模型只有一份
#    package：dev 是它的 Git 狀態，watcher 只負責 reload。這一節是新模型的驗收標尺。
BEFORE=$(curl -s -H "$AUTH" $B/api/packages | python3 -c "import json,sys;print(len(json.load(sys.stdin)['packages']))")
$SDK dev start $ID --json >/dev/null 2>&1 && ok "dev start 成功" || bad "dev start"
AFTER=$(curl -s -H "$AUTH" $B/api/packages | python3 -c "import json,sys;print(len(json.load(sys.stdin)['packages']))")
[ "$BEFORE" = "$AFTER" ] && ok "dev start 後 package 數不變（無第二實體）" || bad "package 數 $BEFORE→$AFTER"
curl -s -H "$AUTH" $B/api/packages | grep -q "@" \
  && bad "package 列表出現 @slug" || ok "package 列表無 <id>@<slug>"
curl -s -H "$AUTH" $B/api/stage/services | grep -q "@" \
  && bad "service 列表出現 @slug" || ok "service 列表無 <id>@<slug>"

echo "--- 9. watcher 不改 Git 狀態 ---"
V=$WORK/installed/$ID/versions/0.1.0
STATE() { node scripts/package-manager.mjs state $ID 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['state'])"; }
[ "$(STATE)" = "release" ] && ok "clean package + watcher = release" || bad "clean+watcher 應為 release，實為 $(STATE)"
$SDK dev stop $ID --json >/dev/null 2>&1 && ok "dev stop 成功" || bad "dev stop"
[ "$(STATE)" = "release" ] && ok "dev stop 不改 Git 狀態" || bad "dev stop 後狀態變了"

echo "--- 10. 改檔即 dev；watcher 開關不影響判定 ---"
echo "// smoke edit" >> "$V/package.mjs"
[ "$(STATE)" = "dev" ] && ok "修改 active worktree → dev（無需任何命令）" || bad "改檔後應為 dev"
$SDK dev start $ID --json >/dev/null 2>&1
[ "$(STATE)" = "dev" ] && ok "dirty package + watcher 仍為 dev" || bad "watcher 不該改變判定"
$SDK dev stop $ID --json >/dev/null 2>&1
[ "$(STATE)" = "dev" ] && ok "stop watcher 後 dirty package 仍為 dev" || bad "stop 後仍應為 dev"
git -C "$V" -c core.fileMode=false checkout -- package.mjs 2>/dev/null
[ "$(STATE)" = "release" ] && ok "撤銷修改後回到 release" || bad "撤銷後應回 release"

echo "--- 11. reload 用的是正式那一份身分 ---"
$SDK dev start $ID --json >/dev/null 2>&1
SVC_BEFORE=$(curl -s -H "$AUTH" $B/api/stage/services | python3 -c "
import json,sys;print(','.join(sorted(s['id'] for s in json.load(sys.stdin)['services'])))")
$SDK dev reload $ID --json >/dev/null 2>&1 && ok "dev reload 成功" || bad "dev reload"
SVC_AFTER=$(curl -s -H "$AUTH" $B/api/stage/services | python3 -c "
import json,sys;print(','.join(sorted(s['id'] for s in json.load(sys.stdin)['services'])))")
[ "$SVC_BEFORE" = "$SVC_AFTER" ] && ok "reload 前後 service id 完全相同" || bad "service id 變了: $SVC_BEFORE → $SVC_AFTER"
curl -s -H "$AUTH" $B/api/packages/$ID | grep -q '"id"' && ok "唯一 package 記錄仍可查" || bad "package 記錄丟失"

echo "--- 12. 舊入口已移除 ---"
# 舊參數必須不再被接受：靜默忽略比報錯更糟，使用者會以為隔離資料區還在生效。
tf "--workspace 已不被接受" $SDK dev start $ID --workspace "$WORK/ws/$ID"
tf "--slug 已不被接受" $SDK dev start $ID --slug w1
tf "--use-live-data 已不被接受" $SDK dev start $ID --use-live-data
$SDK dev --help 2>&1 | grep -qE "slug|workspace|use-live-data" \
  && bad "dev --help 仍提到舊參數" || ok "dev --help 不再提到 slug/workspace/data mode"

echo "--- 13. dev status 同時給出 Git 狀態與監看狀態 ---"
$SDK dev status $ID --json | python3 -c "
import json,sys
d = json.load(sys.stdin)
# ⚠ watcher 與 dev 是兩個維度：watching 說的是「有沒有在監看」，state 說的是
#    「這份代碼跟發布的一不一樣」。混為一談就等於又造了第二個狀態真相源。
assert 'watching' in d and 'state' in d, d
assert d['state'] in ('release','dev','unknown')
assert 'instance_id' not in d and 'slug' not in d and 'workspace' not in d, d" \
  && ok "dev status 分開報告 watching 與 Git state" || bad "dev status 欄位"
$SDK dev stop $ID --json >/dev/null 2>&1

echo "--- 14. 重啟不自動開始監看 ---"
kill $FWPID 2>/dev/null; wait $FWPID 2>/dev/null; FWPID=""
start_fw
$SDK dev status $ID --json | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d['watching'] is False" \
  && ok "重啟後不自動恢復監看" || bad "重啟後監看狀態"
[ "$(STATE)" = "release" ] && ok "重啟後 Git 狀態仍由工作樹決定" || bad "重啟後狀態"
curl -s -H "$AUTH" $B/api/packages | grep -q "@" && bad "重啟後出現 @slug" || ok "重啟後仍無 <id>@<slug>"

echo
echo "PASS=$pass FAIL=$fail"
[ $fail -eq 0 ] || exit 1
