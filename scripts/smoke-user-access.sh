#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: The exports or executable behavior implemented by this file.
# [POS]: scripts/smoke-user-access.sh in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1${2:+ — $2}"; fail=$((fail+1)); }
expect_ok() { local name=$1; shift; local out; out=$("$@" 2>&1)
  [ $? -eq 0 ] && ok "$name" || bad "$name" "$(echo "$out" | grep -m2 FAIL | tr '\n' ' ')"; }

echo "=== User Access + Observation smoke（不連手機、不起模型）==="

echo "--- 0. 模塊 self-test ---"
expect_ok "access self-test（網卡分類/URL 生成/unknown 不編造 12 項）" node src/system/access.mjs --self-test

echo "--- 1. 起一個臨時 framework（隔離：臨時 config + 隨機端口 + 空 installed root）---"
WORK=$(mktemp -d); trap 'kill ${FW_PID:-0} 2>/dev/null; rm -rf "$WORK"' EXIT
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
python3 - "$WORK/config.json" "$PORT" <<'PY'
import json, sys
json.dump({"schema": "termux-os-framework.conf.v1", "device_name": "smoke-device",
           "server": {"host": "0.0.0.0", "port": int(sys.argv[2])},
           "auth": {"admin_token": "smoketoken"},
           "integrations": {"app": {"enabled": False, "url": "http://127.0.0.1:1", "token": ""}}},
          open(sys.argv[1], "w"))
PY
CONFIG="$WORK/config.json" BROWSER_SESSION_PATH="$WORK/browser-sessions.v1.json" PACKAGES_INSTALLED_DIR="$WORK/pkgs" node src/server.mjs >"$WORK/fw.log" 2>&1 &
FW_PID=$!
for _ in $(seq 1 40); do
  curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && ok "臨時 framework 起來了" || { bad "臨時 framework 起來了" "$(tail -3 "$WORK/fw.log")"; echo "PASS=$pass FAIL=$fail"; exit 1; }

echo "--- 2. /api/access-info（§5）---"
AI=$(curl -s -m 3 "http://127.0.0.1:$PORT/api/access-info")
echo "$AI" | grep -q '"ok":true' && ok "access-info 可達且**公開**（找門不該要 token）" || bad "access-info 公開" "$AI"
echo "$AI" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["bind"]=="0.0.0.0" else 1)' \
  && ok "回報真實 bind=0.0.0.0" || bad "回報真實 bind"
echo "$AI" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["lan_reachable"] is True else 1)' \
  && ok "0.0.0.0 → lan_reachable=true" || bad "lan_reachable=true"
echo "$AI" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d['port']==$PORT else 1)" \
  && ok "回報真實端口" || bad "回報真實端口"
echo "$AI" | python3 -c '
import json,sys
d=json.load(sys.stdin)
a=d.get("addresses",[])
sys.exit(0 if a and all(x["admin_url"].startswith("http://") and x["admin_url"].endswith("/admin") for x in a) else 1)' \
  && ok "每個地址都給出可直接點開的 admin URL" || bad "URL 生成"
echo "$AI" | python3 -c '
import json,sys
d=json.load(sys.stdin)
p=d.get("primary")
sys.exit(0 if p is None or p["kind"]!="loopback" else 1)' \
  && ok "primary 不指向 loopback（那個網址對用戶沒用）" || bad "primary 不是 loopback"
echo "$AI" | python3 -c '
import json,sys
d=json.load(sys.stdin)
sys.exit(0 if d["device"]=="smoke-device" and d["git_commit"] else 1)' \
  && ok "device 與 build 可見（§17：當前 commit 可見）" || bad "device/build 可見"

echo "--- 3. 頁面入口（§2：用戶不該猜隱藏路徑）---"
# 全新安裝的設備還沒有人認領憑證。密碼是隨機生成寫進私有檔案的，只有本機瀏覽器能看到它，
# 所以這裡的入口是 Setup 而不是登入框——否則使用者得開 Termux 打指令才進得去。
# /admin 直接回 200 的 Setup 頁，不轉址：更新時是舊版本的控制器在檢查這個狀態碼。
C=$(curl -s -o "$WORK/entry.html" -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT/admin")
[ "$C" = 200 ] && grep -q 'setup.js' "$WORK/entry.html" \
  && ok "未認領的設備 /admin 顯示 Setup" || bad "未認領的設備 /admin 顯示 Setup" "http=$C"
C=$(curl -s -o "$WORK/setup.html" -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT/admin/setup")
[ "$C" = 200 ] && grep -q 'setup.js' "$WORK/setup.html" \
  && ok "Setup 頁可直接開啟" || bad "Setup 頁可直接開啟" "http=$C"
SU=$(curl -s -m 3 "http://127.0.0.1:$PORT/api/admin/setup")
echo "$SU" | python3 -c '
import json,sys
d=json.load(sys.stdin)
sys.exit(0 if d.get("ok") and d.get("step")=="setup" and d.get("admin_password") and d.get("setup_token") else 1)' \
  && ok "Setup 只對本機交出生成的憑證" || bad "Setup 交出憑證" "$SU"
# 完成後才回到一般的登入流程；沒有這一步，更新完的設備會一直停在 Setup。
TOKEN=$(echo "$SU" | python3 -c 'import json,sys; print(json.load(sys.stdin)["setup_token"])')
curl -s -m 3 -X POST -H 'Content-Type: application/json' \
  -d "{\"setup_token\":\"$TOKEN\",\"use_previous_config\":true}" \
  "http://127.0.0.1:$PORT/api/admin/setup" >/dev/null
C=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT/api/admin/setup")
[ "$C" = 404 ] && ok "認領後 Setup 不再交出憑證" || bad "認領後 Setup 關閉" "http=$C"
C=$(curl -s -o "$WORK/admin.html" -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT/admin")
[ "$C" = 200 ] && grep -q 'Administrator password' "$WORK/admin.html" \
  && ok "/admin → Browser Login" || bad "/admin → Browser Login" "http=$C"
C=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT/admin/status/overview")
[ "$C" = 302 ] && ok "受保护 Admin 页面未登录 → Login" || bad "受保护 Admin 页面未登录 → Login" "http=$C"
curl -s -c "$WORK/cookie" -H 'Content-Type: application/json' -d '{"password":"smoketoken"}' \
  "http://127.0.0.1:$PORT/api/auth/login" >/dev/null
curl -s -m 3 -b "$WORK/cookie" "http://127.0.0.1:$PORT/admin/status/runtime" >"$WORK/runtime-shell.html"
grep -q 'id="navigation"' "$WORK/runtime-shell.html" \
  && grep -q '/admin/app.js' "$WORK/runtime-shell.html" \
  && ok "登录后进入统一 Admin Shell" || bad "统一 Admin Shell 内容正确"

echo "--- 4. Observation API（027 §3：Start Observation / 只看新日誌 / 歷史不刪）---"
OC=$(curl -s -m 3 -H "Authorization: Bearer smoketoken" "http://127.0.0.1:$PORT/api/observation/components")
echo "$OC" | python3 -c '
import json,sys
d=json.load(sys.stdin)
ids=[c["id"] for c in d.get("components",[])]
sys.exit(0 if d.get("ok") and "framework" in ids else 1)' \
  && ok "component 清單含 framework" || bad "component 清單" "$OC"
OB=$(curl -s -m 3 -X POST -H "Authorization: Bearer smoketoken" -H 'Content-Type: application/json' \
  -d '{"component":"framework"}' "http://127.0.0.1:$PORT/api/observation")
echo "$OB" | python3 -c '
import json,sys
d=json.load(sys.stdin)
o=d.get("observation",{})
sys.exit(0 if d.get("ok") and o.get("observation_id","").startswith("obs-")
         and o.get("component")=="framework" and o.get("started_at")
         and isinstance(o.get("start_offset"),int) else 1)' \
  && ok "Start Observation 回四要素（id/component/started_at/start_offset）" || bad "Start Observation" "$OB"
OFF=$(echo "$OB" | python3 -c 'import json,sys;print(json.load(sys.stdin)["observation"]["start_offset"])')
OL=$(curl -s -m 3 -H "Authorization: Bearer smoketoken" \
  "http://127.0.0.1:$PORT/api/observation/logs/framework?after=$OFF")
echo "$OL" | python3 -c '
import json,sys
d=json.load(sys.stdin)
sys.exit(0 if d.get("ok") and isinstance(d.get("size"),int) and "content" in d else 1)' \
  && ok "offset 之後可讀新日誌切片" || bad "日誌切片" "$OL"
C=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H "Authorization: Bearer smoketoken" \
  "http://127.0.0.1:$PORT/api/observation/logs/no.such.component")
[ "$C" = 404 ] && ok "未知 component → 404（白名單外不給路徑）" || bad "未知 component 404" "http=$C"
expect_ok "observation self-test（offset/reset/skipped/會話落盤 11 項）" node src/system/observation.mjs --self-test

echo
echo "PASS=$pass FAIL=$fail"
[ $fail -eq 0 ] || exit 1
