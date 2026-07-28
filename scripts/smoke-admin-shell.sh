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
    server:{host:"127.0.0.1",port:Number(process.argv[2])},
    auth:{},
    integrations:{app:{enabled:false,url:"http://127.0.0.1:1",token:""}}
  }, null, 2));
' "$WORK/config.json" "$PORT"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({
  schema:"termux-os-framework.auth.v1",admin_token:process.argv[2],admin_password:process.argv[3],created_at:new Date().toISOString()
},null,2)+"\n")' "$WORK/framework-auth.json" "$AUTH_TOKEN" "$AUTH_PASSWORD"
mkdir -p "$WORK/extra"
cp -a "$ROOT/sdk/examples/service-basic" "$WORK/extra/github.termux-os.service.example-counter"

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
if curl -sf "$BASE/admin" | grep -q 'Administrator password'; then ok "/admin shows Login without session"; else bad "/admin shows Login without session"; fi
if ! curl -sf "$BASE/admin" | grep -Eq 'admin token|id=\"token\"'; then ok "Login contains no fixed API token"; else bad "Login contains no fixed API token"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/status/overview")"
if [ "$CODE" = 302 ]; then ok "Shell route redirects without session"; else bad "Shell route redirects without session (HTTP $CODE)"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/packages/unknown/")"
if [ "$CODE" = 302 ]; then ok "Package WebUI route shares Browser Session gate"; else bad "Package WebUI route shares Browser Session gate (HTTP $CODE)"; fi
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
CODE="$(curl -s -o "$WORK/password-no-old.json" -w '%{http_code}' -b "$COOKIE" -H "X-CSRF-Token: $(node -e 'process.stdout.write(require(process.argv[1]).csrf_token)' "$WORK/login.json")" \
  -H 'Content-Type: application/json' --data '{"new_password":"a-long-new-password","confirm_password":"a-long-new-password"}' \
  "$BASE/api/admin/credentials/login-password")"
if [ "$CODE" = 400 ] && grep -q current_password_required "$WORK/password-no-old.json"; then ok "password update requires the current password"; else bad "password update current-password requirement HTTP $CODE"; fi
CODE="$(curl -s -o "$WORK/password-wrong-old.json" -w '%{http_code}' -b "$COOKIE" -H "X-CSRF-Token: $(node -e 'process.stdout.write(require(process.argv[1]).csrf_token)' "$WORK/login.json")" \
  -H 'Content-Type: application/json' --data '{"current_password":"wrong-old-password","new_password":"a-long-new-password","confirm_password":"a-long-new-password"}' \
  "$BASE/api/admin/credentials/login-password")"
if [ "$CODE" = 401 ] && grep -q current_password_invalid "$WORK/password-wrong-old.json"; then ok "password update rejects a wrong current password"; else bad "password update wrong-current-password HTTP $CODE"; fi
curl -sf -b "$COOKIE" "$BASE/packages/github.termux-os.service.example-counter/" >"$WORK/package.html"
if grep -q '/admin/session.js' "$WORK/package.html"; then
  ok "host upgrades immutable Package HTML to Browser Session without rewriting Release"
else
  bad "host upgrades immutable Package HTML to Browser Session without rewriting Release"
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
if node -e 'const d=require(process.argv[1]);process.exit(d.schema==="termux-os.admin-menu.v1"
  &&d.menu.map(x=>x.title).join(",")==="Status,Applications,Services,Packages,Adapters,System"?0:1)' "$WORK/menu.json"; then
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
if ! grep -rqE 'localStorage|id="token"' "$ROOT/web/admin"; then
  ok "Admin WebUI stores no long-lived token"
else
  bad "Admin WebUI stores no long-lived token"
fi

if grep -q 'Reconnecting to Framework' "$ROOT/web/admin/admin-controls.js" \
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
curl -sf -b "$COOKIE" "$BASE/admin/status/runtime" >"$WORK/runtime-shell.html"
if grep -q 'id="navigation"' "$WORK/runtime-shell.html" \
  && grep -q '/admin/app.js' "$WORK/runtime-shell.html"; then
  ok "Runtime page is rendered inside the unified Shell"
else
  bad "Runtime page is rendered inside the unified Shell"
fi
if grep -q 'CORE_ADMIN_PAGES' "$ROOT/src/system/admin-pages.mjs" \
  && grep -q 'PAGE_RENDERERS' "$ROOT/web/admin/app.js" \
  && grep -q 'renderApplications' "$ROOT/web/admin/app-core.js" \
  && grep -q 'renderServices' "$ROOT/web/admin/app-core.js" \
  && grep -q 'renderLogs' "$ROOT/web/admin/app-core.js" \
  && grep -q 'renderRuntime' "$ROOT/web/admin/app-core.js" \
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
# Framework 不是可安裝的 Package，不得混進 Available
grep -q "item.types?.includes('framework')" "$ROOT/web/admin/admin-controls.js" \
  && ok "framework is filtered out of the installable list" || bad "framework leaks into Available"
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
grep -q "valueRow('Source archive', formatBytes(file.size))" "$ROOT/web/admin/admin-controls.js" \
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
grep -q "Allow access from the local network" "$ROOT/web/admin/app-core.js" \
  && ok "Administration exposes the LAN toggle" || bad "LAN toggle missing from Administration"

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
  && grep -q "pageLink(\`打开 \${page.title}\`" "$ROOT/web/admin/app-core.js"; then
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
