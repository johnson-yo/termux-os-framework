#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: The exports or executable behavior implemented by this file.
# [POS]: scripts/smoke-admin-shell.sh in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/tmp"
WORK="$(mktemp -d "$ROOT/tmp/admin-shell-smoke.XXXXXX")"
PORT=$((20000 + $$ % 1000))
BASE="http://127.0.0.1:$PORT"
COOKIE="$WORK/cookie.txt"
AUDIT="$WORK/auth-failures.jsonl"
SESSION_STORE="$WORK/browser-sessions.v1.json"
AUTH_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
AUTH_PASSWORD="smoke-password-123456"
PASS=0
FAIL=0

ok() { echo "PASS $*"; PASS=$((PASS + 1)); }
bad() { echo "FAIL $*"; FAIL=$((FAIL + 1)); }

cleanup() {
  kill "${FW_PID:-0}" 2>/dev/null || true
  find "$WORK" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({
    schema:"termux-os-framework.conf.v1", device_name:"shell-smoke",
    // 綁 0.0.0.0 才能同時測「本機免密碼」與「別的位址仍要密碼」。
    server:{host:"0.0.0.0",port:Number(process.argv[2])},
    auth:{},
    integrations:{app:{enabled:false,url:"http://127.0.0.1:1",token:""}}
  }, null, 2));
' "$WORK/config.json" "$PORT"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({
  schema:"termux-os-framework.auth.v1",admin_token:process.argv[2],admin_password:process.argv[3],created_at:new Date().toISOString()
},null,2)+"\n")' "$WORK/framework-auth.json" "$AUTH_TOKEN" "$AUTH_PASSWORD"
mkdir -p "$WORK/extra"
cp -a "$ROOT/sdk/examples/service-basic" "$WORK/extra/github.termux-os.service.example-counter"
printf '\n<label for="token">Legacy Framework token</label><input id="token" type="password" value="legacy-value">\n' \
  >>"$WORK/extra/github.termux-os.service.example-counter/web/index.html"
cp -a "$ROOT/sdk/examples/adapter-http" "$WORK/extra/github.termux-os.adapter.example-http"

CONFIG="$WORK/config.json" FRAMEWORK_AUTH_FILE="$WORK/framework-auth.json" AUTH_AUDIT_PATH="$AUDIT" BROWSER_SESSION_PATH="$SESSION_STORE" PACKAGES_INSTALLED_DIR="$WORK/packages" \
  PACKAGES_EXTRA_DIR="$WORK/extra" \
  node "$ROOT/src/server.mjs" >"$WORK/framework.log" 2>&1 &
FW_PID=$!
for _ in $(seq 1 50); do
  curl -sf -m 1 "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.1
done

echo "=== 030 Admin Session + Shell smoke（隔离、不连手机）==="
echo "--- 1. 公开登录入口 / 受保护页面 ---"
if curl -sf "$BASE/health" >/dev/null; then ok "temporary Framework started"; else bad "temporary Framework started"; fi
# 這套 smoke 測的是登入之後的 Shell，所以先把 Setup 走完，讓 /admin 回到一般的登入入口。
# （未認領的設備上 /admin 會先導向 Setup，那條路徑由 smoke-user-access.sh 覆蓋。）
SETUP_TOKEN=$(curl -sf "$BASE/api/admin/setup" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("setup_token",""))' 2>/dev/null || true)
if [ -n "$SETUP_TOKEN" ]; then
  curl -sf -X POST -H 'Content-Type: application/json' \
    -d "{\"setup_token\":\"$SETUP_TOKEN\",\"use_previous_config\":true}" "$BASE/api/admin/setup" >/dev/null || true
fi
# 這套 smoke 全部跑在 loopback 上，而 loopback 就是機主本人：面板直接開，不出現登入框。
# 「別的機器仍然要密碼」由 smoke-user-access.sh 用非 loopback 位址驗證。
if ! curl -sf "$BASE/admin" | grep -Eq 'admin token|id=\"token\"'; then ok "Entry contains no fixed API token"; else bad "Entry contains no fixed API token"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin")"
if [ "$CODE" = 302 ]; then ok "Local browser enters without a password"; else bad "Local browser enters without a password (HTTP $CODE)"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/status/overview")"
if [ "$CODE" = 200 ]; then ok "Local browser opens the shell directly"; else bad "Local browser opens the shell directly (HTTP $CODE)"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/packages/unknown/")"
if [ "$CODE" = 404 ]; then ok "Package WebUI route resolves for a local browser"; else bad "Package WebUI route resolves for a local browser (HTTP $CODE)"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/sdk-guide")"
if [ "$CODE" = 401 ]; then ok "SDK Agent guide requires authentication"; else bad "SDK Agent guide auth gate (HTTP $CODE)"; fi

echo "--- 2. 登录 / Cookie / 失败审计 ---"
CODE="$(curl -s -o "$WORK/bad.json" -w '%{http_code}' -H 'Content-Type: application/json' \
  --data '{"password":"wrong"}' "$BASE/api/auth/login")"
if [ "$CODE" = 401 ] && grep -q bad_password "$AUDIT" && ! grep -q wrong "$AUDIT"; then
  ok "bad login is rejected and safely audited"
else
  bad "bad login is rejected and safely audited"
fi
curl -s -D "$WORK/login.headers" -c "$COOKIE" -H 'Content-Type: application/json' \
  --data "{\"password\":\"$AUTH_PASSWORD\"}" "$BASE/api/auth/login" >"$WORK/login.json"
if node -e 'const d=require(process.argv[1]);process.exit(d.ok&&d.schema==="termux-os.browser-session.v1"
  &&d.permissions.includes("read")&&d.permissions.includes("write")&&d.csrf_token?0:1)' "$WORK/login.json"; then
  ok "valid login returns read/write Browser Session"
else
  bad "valid login returns read/write Browser Session"
fi
if grep -qi 'Set-Cookie: tos_session=.*HttpOnly.*SameSite=Strict' "$WORK/login.headers"; then
  ok "session cookie is HttpOnly + SameSite=Strict"
else
  bad "session cookie is HttpOnly + SameSite=Strict"
fi
if curl -sf -b "$COOKIE" "$BASE/api/auth/session" | grep -q 'csrf_token'; then ok "session survives refresh"; else bad "session survives refresh"; fi
if curl -sf -b "$COOKIE" "$BASE/admin/status/overview" | grep -q 'id=\"navigation\"'; then ok "authenticated Shell loads"; else bad "authenticated Shell loads"; fi
curl -sf -b "$COOKIE" "$BASE/api/admin/sdk-guide" >"$WORK/sdk-guide.json"
if node -e 'const d=require(process.argv[1]); const p=d.prompt||""; process.exit(
  d.ok&&d.schema==="termux-os.sdk-guide.v1"&&d.source==="sdk/AI_AGENT_PROMPT.md"
  &&p.includes("TERMUX_OS_PORT_<ID>")&&p.includes("TERMUX_OS_SYSTEM_KEY")
  &&p.includes("window.TermuxOS.api")&&p.includes("portrait phone") ? 0 : 1)' "$WORK/sdk-guide.json"; then
  ok "SDK Agent guide exposes the current port, System Key, Browser Session, and mobile contracts"
else
  bad "SDK Agent guide contract"
fi
curl -sf -b "$COOKIE" "$BASE/api/admin/credentials" >"$WORK/credentials.json"
if node -e 'const d=require(process.argv[1]);process.exit(d.editable && d.system_key_masked?.startsWith("***")
  && !Object.hasOwn(d,"system_key") && d.system_key_length > 0 ? 0 : 1)' "$WORK/credentials.json"; then
  ok "credential snapshot is masked and omits the full System Key"
else
  bad "credential snapshot is masked and omits the full System Key"
fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/admin/credentials/system-key")"
if [ "$CODE" = 401 ]; then ok "full System Key copy endpoint rejects Bearer API clients"; else bad "full System Key copy endpoint Bearer HTTP $CODE"; fi
# 本機不問舊密碼——這裡只驗其餘規則仍在，而且刻意不去改動密碼，免得後面的測試失去憑證。
# 「別的設備必須證明舊密碼」由 smoke-user-access.sh 在非 loopback 位址上驗證。
CODE="$(curl -s -o "$WORK/password-short.json" -w '%{http_code}' -b "$COOKIE" -H "X-CSRF-Token: $(node -e 'process.stdout.write(require(process.argv[1]).csrf_token)' "$WORK/login.json")" \
  -H 'Content-Type: application/json' --data '{"new_password":"short","confirm_password":"short"}' \
  "$BASE/api/admin/credentials/login-password")"
if [ "$CODE" = 400 ] && grep -q login_password_too_short "$WORK/password-short.json"; then ok "password rules still apply locally"; else bad "password rules still apply locally HTTP $CODE"; fi
# ⚠ 不再有确认栏。再输一次是**遮蔽输入**的补丁——看不见自己打了什么才需要打两遍；
# 这个字段现在是明文的，确认保护不了任何东西，只多一种把自己关在门外的方式。
# 这里只断言页面上不再要求它；真去改一次会作废本 smoke 的会话，让后面全部误红。
if ! grep -q 'confirm_password' "$ROOT/src/server.mjs" \
  && ! grep -q 'confirmPassword' "$ROOT/web/admin/app-core.js"; then
  ok "password change takes one visible field, with no confirmation to mistype"
else
  bad "password confirmation field still present"
fi
if grep -q "newPassword.type = 'text'" "$ROOT/web/admin/app-core.js"; then
  ok "the new password is shown, not masked"
else
  bad "new password is still masked"
fi

# 本機免密碼是因為機主就在那台機器前面。從別的位址改密碼仍然要先證明知道舊的，
# 否則只要連得到這個埠就能把管理員鎖在門外。
LAN_IP=$(node -e '
  const os = require("os");
  const hit = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);
  process.stdout.write(hit ? hit.address : "");
')
if [ -n "$LAN_IP" ]; then
  REMOTE="http://$LAN_IP:$PORT"
  curl -s -c "$WORK/remote-ck" -H 'Content-Type: application/json' \
    --data "{\"password\":\"$AUTH_PASSWORD\"}" "$REMOTE/api/auth/login" -o "$WORK/remote-login.json"
  RCSRF=$(node -e 'try{process.stdout.write(require(process.argv[1]).csrf_token||"")}catch{}' "$WORK/remote-login.json")
  CODE="$(curl -s -o "$WORK/remote-pw.json" -w '%{http_code}' -b "$WORK/remote-ck" -H "X-CSRF-Token: $RCSRF" \
    -H 'Content-Type: application/json' --data '{"new_password":"a-long-new-password","confirm_password":"a-long-new-password"}' \
    "$REMOTE/api/admin/credentials/login-password")"
  if [ "$CODE" = 400 ] && grep -q current_password_required "$WORK/remote-pw.json"; then
    ok "remote password change still proves the old password"
  else
    bad "remote password change still proves the old password HTTP $CODE"
  fi
  CODE="$(curl -s -o "$WORK/remote-pw2.json" -w '%{http_code}' -b "$WORK/remote-ck" -H "X-CSRF-Token: $RCSRF" \
    -H 'Content-Type: application/json' --data '{"current_password":"wrong-old-password","new_password":"a-long-new-password","confirm_password":"a-long-new-password"}' \
    "$REMOTE/api/admin/credentials/login-password")"
  if [ "$CODE" = 401 ] && grep -q current_password_invalid "$WORK/remote-pw2.json"; then
    ok "remote password change rejects a wrong old password"
  else
    bad "remote password change rejects a wrong old password HTTP $CODE"
  fi
else
  echo "SKIP remote password checks: no non-loopback IPv4 address on this machine"
fi
curl -sf -b "$COOKIE" "$BASE/packages/github.termux-os.service.example-counter/" >"$WORK/package.html"
if grep -q '/admin/session.js' "$WORK/package.html"; then
  ok "host upgrades immutable Package HTML to Browser Session without rewriting Release"
else
  bad "host upgrades immutable Package HTML to Browser Session without rewriting Release"
fi
if grep -q 'id="token" type="password" value=""' "$WORK/package.html" \
  && ! grep -q 'value="legacy-value"' "$WORK/package.html"; then
  ok "host clears legacy Framework token fields"
else
  bad "host clears legacy Framework token fields"
fi
curl -sf -b "$COOKIE" "$BASE/packages/github.termux-os.adapter.example-http/" >"$WORK/adapter.html"
if grep -q 'id="token" type="password" data-provider-credential' "$WORK/adapter.html"; then
  ok "host preserves marked external-provider credential fields"
else
  bad "host preserves marked external-provider credential fields"
fi
kill "$FW_PID" 2>/dev/null || true
wait "$FW_PID" 2>/dev/null || true
CONFIG="$WORK/config.json" FRAMEWORK_AUTH_FILE="$WORK/framework-auth.json" AUTH_AUDIT_PATH="$AUDIT" BROWSER_SESSION_PATH="$SESSION_STORE" PACKAGES_INSTALLED_DIR="$WORK/packages" \
  PACKAGES_EXTRA_DIR="$WORK/extra" \
  node "$ROOT/src/server.mjs" >>"$WORK/framework.log" 2>&1 &
FW_PID=$!
for _ in $(seq 1 50); do
  curl -sf -m 1 "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.1
done
if curl -sf -b "$COOKIE" "$BASE/api/auth/session" | grep -q 'csrf_token'; then
  ok "private Browser Session survives Framework process restart"
else
  bad "private Browser Session survives Framework process restart"
fi

echo "--- 3. CSRF 与 Bearer 分离 ---"
CODE="$(curl -s -o "$WORK/no-csrf.json" -w '%{http_code}' -b "$COOKIE" -H 'Content-Type: application/json' \
  --data '{}' "$BASE/api/stage/services/no.such/restart")"
if [ "$CODE" = 403 ] && grep -q csrf_failed "$WORK/no-csrf.json"; then ok "Cookie write without CSRF rejected"; else bad "Cookie write without CSRF rejected"; fi
CSRF="$(node -e 'process.stdout.write(require(process.argv[1]).csrf_token)' "$WORK/login.json")"
CODE="$(curl -s -o "$WORK/with-csrf.json" -w '%{http_code}' -b "$COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' --data '{}' \
  "$BASE/api/stage/services/no.such/restart")"
if [ "$CODE" = 404 ] && grep -q unknown_service "$WORK/with-csrf.json"; then
  ok "Cookie write with CSRF reaches real route"
else
  bad "Cookie write with CSRF reaches real route"
fi
CODE="$(curl -s -o "$WORK/bearer.json" -w '%{http_code}' -H "Authorization: Bearer $AUTH_TOKEN" \
  -H 'Content-Type: application/json' --data '{}' \
  "$BASE/api/stage/services/no.such/restart")"
if [ "$CODE" = 404 ] && grep -q unknown_service "$WORK/bearer.json"; then
  ok "SDK Bearer write remains independent of Browser CSRF"
else
  bad "SDK Bearer write remains independent of Browser CSRF"
fi

echo "--- 4. 声明式 Menu + Overview ---"
curl -sf -b "$COOKIE" "$BASE/api/admin/menu" >"$WORK/menu.json"
# 認路徑順序，不認標題文字：介面文案會改，導覽的結構與順序不該跟著改。
if node -e 'const d=require(process.argv[1]);process.exit(d.schema==="termux-os.admin-menu.v1"
  &&d.menu.map(x=>x.path).join(",")==="/admin/status,/admin/applications,/admin/services,/admin/packages,/admin/adapters,/admin/system"?0:1)' "$WORK/menu.json"; then
  ok "fixed top navigation is declarative and ordered"
else
  bad "fixed top navigation is declarative and ordered"
fi
if node -e 'const d=require(process.argv[1]);const f=x=>x.flatMap(n=>[n,...f(n.children||[])]);
  const a=f(d.menu);process.exit(!a.some(n=>n.developer_only)?0:1)' "$WORK/menu.json"; then
  ok "menu hides Developer by default"
else
  bad "menu hides Developer by default"
fi
curl -sf -b "$COOKIE" "$BASE/api/admin/overview" >"$WORK/overview.json"
if node -e 'const d=require(process.argv[1]);process.exit(d.ok&&d.schema==="termux-os.admin-overview.v1"
  &&d.system.device==="shell-smoke"&&d.components.resources&&d.components.packages
  &&d.components.services&&Array.isArray(d.attention)?0:1)' "$WORK/overview.json"; then
  ok "Overview aggregates real independent components"
else
  bad "Overview aggregates real independent components"
fi
if grep -q 'name=\"viewport\"' "$ROOT/web/admin/index.html" \
  && grep -q '@media (max-width: 760px)' "$ROOT/web/admin/style.css"; then
  ok "Shell has explicit mobile layout"
else
  bad "Shell has explicit mobile layout"
fi
# 這條守的是「瀏覽器裡不留長期憑證」。原本靠「完全不准出現 localStorage」來保證，
# 但那也擋掉了與憑證無關的偏好（例如安裝提示關掉沒有）。改成逐一檢查每一處
# localStorage/sessionStorage 的鍵名：只有明確列出的偏好可以存，其餘一律不合格。
ALLOWED_STORAGE_KEY='INSTALL_DISMISSED|termux-os.install-dismissed|COLLAPSED_KEY|termux-os.collapsed-panels'
STORAGE_HITS=$(grep -rnE 'localStorage|sessionStorage' "$ROOT/web/admin" || true)
BAD_STORAGE=$(echo "$STORAGE_HITS" | grep -vE "$ALLOWED_STORAGE_KEY" | grep -E 'localStorage|sessionStorage' || true)
if [ -z "$BAD_STORAGE" ] && ! grep -rq 'id="token"' "$ROOT/web/admin"; then
  ok "Admin WebUI stores no long-lived token"
else
  bad "Admin WebUI stores no long-lived token" "$BAD_STORAGE"
fi

# 只認行為，不認文案：重啟窗口要顯示成「正在重新連接」而不是報成失敗。
if grep -q "className = 'reconnect-state'" "$ROOT/web/admin/admin-controls.js" \
  && ! grep -q 'Unable to load Package Manager' "$ROOT/web/admin/admin-controls.js"; then
  ok "Package restart window is shown as reconnecting, not a false failure"
else
  bad "Package restart window is shown as reconnecting, not a false failure"
fi
if grep -q 'async function refreshAdminNavigation' "$ROOT/web/admin/app-core.js" \
  && grep -q 'await refreshAdminNavigation()' "$ROOT/web/admin/admin-controls.js"; then
  ok "Package lifecycle refreshes Package-owned navigation without re-login"
else
  bad "Package lifecycle refreshes Package-owned navigation without re-login"
fi

echo "--- 5. unified pages ---"
# ⚠ 运行时不再有自己的分页：那一页上一个可做的操作都没有，却把「先看状态、再看原因」
# 拆成了两次导航。它的两张卡现在接在概览底下。
curl -sf -b "$COOKIE" "$BASE/admin/status/overview" >"$WORK/overview-shell.html"
if grep -q 'id="navigation"' "$WORK/overview-shell.html" \
  && grep -q '/admin/app.js' "$WORK/overview-shell.html"; then
  ok "Overview is rendered inside the unified Shell"
else
  bad "Overview is rendered inside the unified Shell"
fi
if ! grep -q "/admin/status/runtime" "$ROOT/src/system/admin-pages.mjs" \
  && grep -q 'runtimeCards' "$ROOT/web/admin/app-core.js"; then
  ok "Runtime detail folded into Overview, with no page of its own"
else
  bad "Runtime page still registered"
fi
if grep -q 'CORE_ADMIN_PAGES' "$ROOT/src/system/admin-pages.mjs" \
  && grep -q 'PAGE_RENDERERS' "$ROOT/web/admin/app.js" \
  && grep -q 'renderApplications' "$ROOT/web/admin/app-core.js" \
  && grep -q 'renderServices' "$ROOT/web/admin/app-core.js" \
  && grep -q 'renderLogs' "$ROOT/web/admin/app-core.js" \
  && grep -q 'runtimeCards' "$ROOT/web/admin/app-core.js" \
  && grep -q 'renderWorkspace' "$ROOT/web/admin/app-core.js" \
  && grep -q 'loadAdapters' "$ROOT/web/admin/app.js" \
  && grep -q 'renderFrameworkUpdate' "$ROOT/web/admin/admin-controls.js" \
  && grep -q 'package_settings' "$ROOT/web/admin/app.js" \
  && grep -q 'loadPackageSettings' "$ROOT/web/admin/admin-controls.js" \
  && grep -q 'packageOpenLink' "$ROOT/web/admin/admin-controls.js" \
  && grep -q 'packageSettingAnchor' "$ROOT/web/admin/admin-controls.js" \
  && grep -q 'packageAdminName' "$ROOT/web/admin/admin-controls.js" \
  && grep -q 'githubRepositoryLink' "$ROOT/web/admin/admin-controls.js" \
  && grep -q 'repository: manifest?.release?.repository' "$ROOT/src/system/package-control.mjs" \
  && grep -q "target = '_blank'" "$ROOT/web/admin/admin-controls.js" \
  && ! grep -rq 'renderPlaceholder' "$ROOT/web/admin" \
  && grep -q "'/admin/packages/settings'" "$ROOT/src/system/admin-pages.mjs" \
  && grep -q "'/admin/packages/workspace'" "$ROOT/src/system/admin-pages.mjs" \
  && grep -q "'/admin/system/framework-update'" "$ROOT/src/system/admin-pages.mjs"; then
  ok "Core menu registry only exposes real renderers; Package status pages are Package-owned"
else
  bad "Core menu registry only exposes real renderers; Package status pages are Package-owned"
fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" "$BASE/admin/system/backup")"
if [ "$CODE" = 404 ]; then ok "unregistered admin route is rejected instead of becoming a placeholder"; else bad "unregistered admin route HTTP $CODE"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" "$BASE/admin/system/packages")"
if [ "$CODE" = 404 ]; then ok "old System Packages route is removed"; else bad "old System Packages route HTTP $CODE"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" "$BASE/admin/packages/settings")"
if [ "$CODE" = 200 ]; then ok "Package Setting is under the Packages group"; else bad "Package Setting route HTTP $CODE"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" "$BASE/admin/packages/workspace")"
if [ "$CODE" = 200 ]; then ok "Workspace page sits in the Packages group"; else bad "Workspace page route HTTP $CODE"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" "$BASE/admin/system/workspace")"
if [ "$CODE" = 404 ]; then ok "Workspace no longer answers under System"; else bad "stale System Workspace route HTTP $CODE"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" "$BASE/admin/system/developer")"
if [ "$CODE" = 404 ]; then ok "retired Developer resources page is gone"; else bad "retired developer route HTTP $CODE"; fi
# Package 自有頁面必須用新分頁開，否則使用者從自己的 App 回不到管理台
if grep -q "link.target = '_blank'" "$ROOT/web/admin/app-core.js" \
  && grep -q "!href.startsWith('/admin/')" "$ROOT/web/admin/app-core.js"; then
  ok "Package-owned menu entries open in a new tab"
else
  bad "Package menu entries reuse the admin tab"
fi
# 目錄刷新必須是面板級：Framework Update 與 Packages 共用同一份快取，
# 入口埋在 Available 分頁裡會讓另一頁永遠拿不到最新資料
if grep -q "panel.head?.append(actionButton('更新列表'" "$ROOT/web/admin/admin-controls.js" \
  && ! grep -q "actionButton('Refresh list'" "$ROOT/web/admin/admin-controls.js"; then
  ok "list refresh is a panel-level action, not buried in a tab"
else
  bad "list refresh placement"
fi
# Framework 不是可安裝的 Package，不得混進 Available。
# ⚠ 這裡斷言的是**允許誰**，不是**排除誰**：先前寫成排除 framework 一項，於是每多一種
# 不該出現的類型就要多加一條排除，而漏掉一條沒有任何症狀——它只是靜靜地出現在列表裡。
if grep -q "BROWSABLE_TYPES = new Set(\['adapter', 'app', 'service'\])" "$ROOT/web/admin/admin-controls.js" \
  && ! grep -q "'framework'" <<<"$(grep 'BROWSABLE_TYPES = new Set' "$ROOT/web/admin/admin-controls.js")"; then
  ok "the installable list is an allowlist, so framework and assets cannot leak into Available"
else
  bad "framework or assets can leak into Available"
fi
# Installed 與 Available 必須用同一套官方身份映射
grep -q "officialRepositories.has(key)" "$ROOT/web/admin/admin-controls.js" \
  && ok "Official maintainers map into Installed titles too" || bad "Official mapping is tab-local"

# 安全資訊的價值在可查不在強制：Download 不得被 Details 門禁擋住
if ! grep -q "|| !publicDetailsLoaded" "$ROOT/web/admin/admin-controls.js" \
  && grep -q "registry-disclosure" "$ROOT/web/admin/admin-controls.js"; then
  ok "Download is available without opening Details first"
else
  bad "Download still gated behind Details"
fi
# 恆定的檔名沒有資訊量
grep -q "valueRow(.*, formatBytes(file.size))" "$ROOT/web/admin/admin-controls.js" \
  && ok "Source archive shows size, not the constant filename" || bad "Source archive still prints source.tar.gz"

# 綁定位址必須能從介面改，且改完要說「需重啟」——HOST 在啟動時就綁定了
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" "$BASE/api/admin/network")"
if [ "$CODE" = 200 ]; then ok "network access is readable from the control center"; else bad "network endpoint HTTP $CODE"; fi
curl -sf -b "$COOKIE" "$BASE/api/admin/network" | grep -q '"lan_enabled"' \
  && ok "bind address reports whether LAN access is on" || bad "lan_enabled missing"
# 寫入必須先過 CSRF——瀏覽器 session 的寫請求沒有 token 就該在參數校驗之前被擋下
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" -X POST -H 'Content-Type: application/json' \
  --data '{"host":"example-invalid"}' "$BASE/api/admin/network")"
if [ "$CODE" = 403 ]; then ok "network writes require CSRF before anything else"; else bad "network write bypassed CSRF (HTTP $CODE)"; fi
# 只接受 loopback / 0.0.0.0 兩種：綁到意料之外的介面比不能改更危險。
# 用 System Key 走 API 路徑驗參數校驗本身。
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $AUTH_TOKEN" \
  -X POST -H 'Content-Type: application/json' \
  --data '{"host":"example-invalid"}' "$BASE/api/admin/network")"
if [ "$CODE" = 400 ]; then ok "arbitrary bind addresses are refused"; else bad "network endpoint accepts arbitrary host (HTTP $CODE)"; fi
grep -q "允许局域网访问" "$ROOT/web/admin/app-core.js" \
  && ok "Administration exposes the LAN control" || bad "LAN control missing from Administration"
# 埠會撞，撞了面板就打不開，而使用者沒有 shell 可以改設定檔——所以這件事必須在面板裡做得到。
grep -q "控制台端口" "$ROOT/web/admin/app-core.js" \
  && ok "Administration exposes the port control" || bad "port control missing from Administration"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $AUTH_TOKEN" \
  -X POST -H 'Content-Type: application/json' --data '{"port":80}' "$BASE/api/admin/network")"
if [ "$CODE" = 400 ]; then ok "privileged ports are refused"; else bad "privileged port accepted (HTTP $CODE)"; fi
CODE="$(curl -s -o "$WORK/port.json" -w '%{http_code}' -H "Authorization: Bearer $AUTH_TOKEN" \
  -X POST -H 'Content-Type: application/json' --data "{\"port\":$PORT}" "$BASE/api/admin/network")"
if [ "$CODE" = 200 ] && grep -q '"restart_required":false' "$WORK/port.json"; then
  ok "setting the running port needs no restart"
else
  bad "port endpoint HTTP $CODE"
fi

# 設定生效需要重啟，而重啟必須能在瀏覽器裡完成——使用者不該為此去開 Termux
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $AUTH_TOKEN" \
  -X POST -H 'Content-Type: application/json' --data '{}' "$BASE/api/admin/restart")"
if [ "$CODE" = 202 ] || [ "$CODE" = 500 ]; then ok "restart is reachable from the control center"; else bad "restart endpoint HTTP $CODE"; fi
grep -q "重启框架" "$ROOT/web/admin/app-core.js" \
  && ok "Administration exposes a restart button" || bad "no restart button"
# Manifest 寫完整 URL，Registry 用 owner/repo——不正規化就永遠對不上
grep -q "function normalizeRepository" "$ROOT/web/admin/admin-controls.js" \
  && ok "repository identities are normalised before matching" || bad "repository comparison is format-sensitive"

# 更新被 Dev Runtime 擋下時，必須就地能停——不得把使用者推去命令行
grep -q "停止全部挂载" "$ROOT/web/admin/admin-controls.js" \
  && ok "Framework Update can stop blocking dev mounts in place" || bad "no in-place stop for dev mounts"
curl -sf -b "$COOKIE" "$BASE/api/admin/framework-update" | grep -q '"dev_mounts"' \
  && ok "framework update reports blocking dev mounts" || bad "dev_mounts missing from update payload"
# 任何面向使用者的阻擋訊息都不得要求開 Termux
if grep -q "termux-os-sdk dev stop" "$ROOT/scripts/framework.sh"; then
  bad "update guard still tells the user to run a CLI command"
else
  ok "update guard points at the control center, not a shell"
fi

# Recent operations 只該出現一次
JOBCALLS="$(grep -c "renderJobs(" "$ROOT/web/admin/app-core.js" "$ROOT/web/admin/admin-controls.js" | awk -F: '{s+=$2} END {print s}')"
if [ "$JOBCALLS" = 2 ]; then ok "Recent operations is rendered from exactly one page"; else bad "renderJobs referenced $JOBCALLS times"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" "$BASE/admin/system/sdk")"
if [ "$CODE" = 404 ]; then ok "retired SDK page is gone, not left as a placeholder"; else bad "retired SDK route HTTP $CODE"; fi
# A workspace serves pages at an instance-scoped URL nobody can guess, so the view
# must list them explicitly; assert the renderer really emits per-page open buttons.
# 工作區的頁面掛在 /packages/<id>@<slug>/，猜不出來——必須逐一列成可點連結
if curl -sf -b "$COOKIE" "$BASE/api/admin/workspaces" | grep -q '"projects"' \
  && grep -q "for (const page of pages)" "$ROOT/web/admin/app-core.js"; then
  ok "Workspace view exposes every page of a mounted project"
else
  bad "Workspace view page links"
fi
curl -sf -b "$COOKIE" "$BASE/api/stage/services" >"$WORK/stage.json"
if node -e 'const d=require(process.argv[1]); const s=(d.services||[]).find(x=>x.id==="example-counter");
  process.exit(s && "package" in s && "last_activity_at" in s ? 0 : 1)' "$WORK/stage.json"; then
  ok "Service Overview receives Package ownership and real log activity metadata"
else
  bad "Service Overview receives Package ownership and real log activity metadata"
fi
curl -sf -b "$COOKIE" "$BASE/api/admin/framework-update" >"$WORK/framework-update.json"
if node -e 'const d=require(process.argv[1]); process.exit(d.ok && d.schema==="termux-os.framework-update-web.v1"
  && Array.isArray(d.uploads) && Array.isArray(d.history) ? 0 : 1)' "$WORK/framework-update.json" \
  && grep -q 'renderFrameworkUpdate' "$ROOT/web/admin/admin-controls.js"; then
  ok "Framework Update WebUI reads the single engine snapshot and has a real renderer"
else
  bad "Framework Update WebUI reads the single engine snapshot and has a real renderer"
fi

echo "--- 5b. Package manager framing ---"
# 這一頁回答「我要裝什麼」，所以只列使用者會自己去裝的三種。asset 由需要它的包帶進來，
# 而目錄裡有幾個 asset 條目連 source_tar 都沒有——它們是給下載代理認坐標用的，從來裝不了。
if grep -q "BROWSABLE_TYPES = new Set(\['adapter', 'app', 'service'\])" "$ROOT/web/admin/admin-controls.js" \
  && grep -q "item.types?.some((type) => BROWSABLE_TYPES.has(type))" "$ROOT/web/admin/admin-controls.js"; then
  ok "The installable list is framed by what a person installs, not by everything in the catalog"
else
  bad "The installable list is framed by what a person installs, not by everything in the catalog"
fi
# ⚠ 按鈕要按**版本**說話。先前只看「這個 id 裝過沒有」，於是裝了舊版之後新版的卡片
# 寫著「最新已驗證 0.19.0」而按鈕是灰的「已安裝 0.18.0」——升級這條路整個消失了。
if grep -q "installedVersions = new Map" "$ROOT/web/admin/admin-controls.js" \
  && grep -q "function compareVersionStrings" "$ROOT/web/admin/admin-controls.js" \
  && grep -q "relation === 'same'" "$ROOT/web/admin/admin-controls.js" \
  && grep -q '更新到 ${version.version}' "$ROOT/web/admin/admin-controls.js"; then
  ok "Only the same version disables Install; newer and older stay actionable"
else
  bad "Only the same version disables Install; newer and older stay actionable"
fi
# 索引裡已經有 provides/depends，面板必須看它——否則一個宣告了十一條依賴的包
# 會被寫成「未申報任何公開資訊」，而那句話讀起來像上游偷懶。
if grep -q "details.packages ?? \[\]" "$ROOT/web/admin/admin-controls.js" \
  && grep -q "Requires packages" "$ROOT/web/admin/admin-controls.js"; then
  ok "Declared dependencies are shown from the index, not only from public_metadata"
else
  bad "Declared dependencies are shown from the index, not only from public_metadata"
fi
# 關閉這件事由一個從不摘掉的綁定負責。先前每個階段只改 textContent，而確認階段結束時
# 會摘掉自己的監聽器，於是改名成「完成」的按鈕一個處理器都沒有——點了毫無反應。
if grep -q "installDialogBindDismiss" "$ROOT/web/admin/admin-controls.js" \
  && grep -q "installDismissBound = true" "$ROOT/web/admin/admin-controls.js"; then
  ok "The install dialog can always be dismissed, whatever the button is currently called"
else
  bad "The install dialog can always be dismissed, whatever the button is currently called"
fi
# 憑證被釘住時連命令都不該給——一個自己都不相信會成功的操作，不該長得像可用的操作。
curl -sf -b "$COOKIE" "$BASE/api/admin/credentials" >"$WORK/credentials.json" 2>/dev/null || \
  curl -sf -b "$COOKIE" "$BASE/api/admin/settings" >"$WORK/credentials.json" 2>/dev/null || true
if node -e 'const t=require("node:fs").readFileSync(process.argv[1],"utf8");
  process.exit(t.includes("locked_by") ? 0 : 1)' "$WORK/credentials.json" 2>/dev/null \
  && grep -q "credentials.editable === false" "$ROOT/web/admin/app-core.js" \
  && grep -q "locked.keys" "$ROOT/web/admin/app-core.js"; then
  ok "Pinned credentials say which keys pin them instead of handing over a doomed command"
else
  bad "Pinned credentials say which keys pin them instead of handing over a doomed command"
fi

echo "--- 6. Logout ---"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" -X POST "$BASE/api/auth/logout")"
if [ "$CODE" = 403 ]; then ok "Logout also requires CSRF"; else bad "Logout also requires CSRF (HTTP $CODE)"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" -c "$COOKIE" -X POST \
  -H "X-CSRF-Token: $CSRF" "$BASE/api/auth/logout")"
if [ "$CODE" = 200 ]; then ok "Logout succeeds with CSRF"; else bad "Logout succeeds with CSRF (HTTP $CODE)"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" "$BASE/api/auth/session")"
if [ "$CODE" = 401 ]; then ok "Logout invalidates Browser Session"; else bad "Logout invalidates Browser Session (HTTP $CODE)"; fi

echo
echo "PASS=$PASS FAIL=$FAIL"
exit "$FAIL"
