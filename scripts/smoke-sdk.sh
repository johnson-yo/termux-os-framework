#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: The exports or executable behavior implemented by this file.
# [POS]: scripts/smoke-sdk.sh in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
SDK=./sdk/termux-os-sdk
PFX=github.termux-os
SVC=$PFX.service.sdk-smoke-svc
APP=$PFX.app.sdk-smoke-app
ADP=$PFX.adapter.sdk-smoke-adp
AST=$PFX.asset.sdk-smoke-ast
mkdir -p "$ROOT/tmp" || exit 1
WORK=$(mktemp -d "$ROOT/tmp/sdk-smoke.XXXXXX") || exit 1
PKGS="$WORK/packages"
export TERMUX_OS_SOURCE_ROOT="$PKGS"
cleanup() { rm -rf "$WORK" dist/releases/$PFX.*.sdk-smoke-*; }
trap cleanup EXIT
cleanup

pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1${2:+ — $2}"; fail=$((fail+1)); }
t() { local name=$1; shift; "$@" >/dev/null 2>&1 && ok "$name" || bad "$name"; }
tf() { local name=$1; shift; "$@" >/dev/null 2>&1 && bad "$name (expected failure)" || ok "$name"; }

echo "=== Current SDK smoke (isolated, no device) ==="

echo "--- 0. context / inspect / choose ---"
t "context command runs" $SDK context
$SDK context --json | python3 -c '
import json,sys; d=json.load(sys.stdin)
assert d["ok"] and "generic" in d["current_targets"] and d["current_providers"] == []
assert "framework/packages" not in d["package_source"]
assert d["package_source"] and d["installed_root"] and d["persistent_root"]
assert d["docs"]["agent_prompt"]=="sdk/AI_AGENT_PROMPT.md"' \
  && ok "context reports independent source and current Agent prompt" || bad "context JSON contract"
tf "inspect rejects an unknown Package" $SDK inspect $PFX.service.no-such-pkg
$SDK inspect $PFX.service.no-such-pkg --json 2>/dev/null | grep -q package_not_found \
  && ok "inspect error includes a stable code" || bad "inspect error code"
$SDK choose --extends-existing no --data-only no --integrates-external yes --long-running no --combines-capabilities no --json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["type"]=="adapter" and d["reason"]' \
  && ok "choose selects adapter with a reason" || bad "choose adapter"
$SDK choose --extends-existing yes --data-only no --integrates-external no --long-running no --combines-capabilities no --json \
  | grep -q '"type": "none"' && ok "choose selects modification of an existing Package" || bad "choose none"
tf "choose rejects missing answers in JSON mode" $SDK choose --json

echo "--- 1. generate all four Package types ---"
t "new service" $SDK new --type service --id $SVC --name "Smoke Svc"
t "new app"     $SDK new --type app --id $APP --name "Smoke App"
t "new adapter" $SDK new --type adapter --id $ADP --name "Smoke Adp"
t "new asset"   $SDK new --type asset --id $AST --name "Smoke Ast"
t "inspect generated package" $SDK inspect $SVC
tf "duplicate Package ID is rejected" $SDK new --type service --id $SVC --name X
tf "unknown Package type is rejected" $SDK new --type daemon --id $PFX.service.sdk-smoke-x --name X
for d in $SVC $APP $ADP $AST; do
  [ -f "$PKGS/$d/web/index.html" ] && [ -f "$PKGS/$d/test/self-test.mjs" ] \
    && ok "$d has a WebUI and self-test" || bad "$d generated files"
done
grep -q "loadConfig(CONFIG_FILE)" "$PKGS/$SVC/package.mjs" \
  && ok "service config can be edited before first start" || bad "config-before-start"
node -e 'const fs=require("fs"); const [svc,app,adp,ast]=process.argv.slice(1).map(x=>JSON.parse(fs.readFileSync(x)));
  if(svc.menu[0].parent!=="/admin/services"||app.menu[0].parent!=="/admin/applications"
    ||adp.menu[0].parent!=="/admin/adapters"||ast.menu[0].parent!=="/admin/packages"
    ||svc.ports[0].id!=="http") process.exit(1)' \
  "$PKGS/$SVC/termux-os.package.json" "$PKGS/$APP/termux-os.package.json" \
  "$PKGS/$ADP/termux-os.package.json" "$PKGS/$AST/termux-os.package.json" \
  && ok "generated manifests register current menu groups and Package ports" || bad "generated manifest contracts"
grep -q '/admin/session.js' "$PKGS/$SVC/web/index.html" \
  && grep -q 'window.TermuxOS.api' "$PKGS/$SVC/web/app.js" \
  && ! grep -rqE 'id="token"|localStorage|FRAMEWORK_TOKEN' "$PKGS/$SVC/web" "$PKGS/$APP" \
  && ok "generated WebUI uses Browser Session without a token field" || bad "generated Browser Session contract"
grep -q 'id="token".*data-provider-credential' "$PKGS/$ADP/web/index.html" \
  && grep -q 'ACTIVE_PACKAGE_ID' "$PKGS/$ADP/web/app.js" \
  && ! grep -rqE 'localStorage|sessionStorage|Authorization.*Bearer' "$PKGS/$ADP/web" \
  && ok "generated Adapter separates external credentials and supports Package routes" \
  || bad "generated Adapter credential or Package route contract"
grep -q 'process.env.PORT' "$PKGS/$SVC/service/main.mjs" \
  && grep -q 'TERMUX_OS_SYSTEM_KEY' "$PKGS/$SVC/service/main.mjs" \
  && grep -q 'TERMUX_OS_FRAMEWORK_URL' "$PKGS/$APP/app/worker.mjs" \
  && grep -q 'TERMUX_OS_SYSTEM_KEY' "$PKGS/$APP/app/worker.mjs" \
  && ok "generated processes use assigned ports and injected System Key" || bad "generated runtime injection contract"

echo "--- 2. doctor positive and negative checks ---"
t "generated Package has zero doctor FAIL items" $SDK doctor $SVC
t "generated Adapter provider credential boundary passes doctor" $SDK doctor $ADP
$SDK doctor $SVC --json | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["counts"]["FAIL"]==0' \
  && ok "doctor JSON includes counts" || bad "doctor JSON"
cp "$PKGS/$SVC/web/index.html" "$PKGS/$SVC/web/index.html.bak"
printf '\n<input id="token" type="password" data-provider-credential>\n' >>"$PKGS/$SVC/web/index.html"
tf "external provider credential field outside Adapter fails doctor" $SDK doctor $SVC
mv "$PKGS/$SVC/web/index.html.bak" "$PKGS/$SVC/web/index.html"
test_ip=$(printf '%s.%s.%s.%s' 10 23 45 67)
echo "const ip='$test_ip';" >> "$PKGS/$SVC/service/main.mjs"
tf "hard-coded device IP fails doctor" $SDK doctor $SVC
$SDK doctor $SVC --json 2>/dev/null | grep -q no_hardcoded_device_ip && ok "IP failure has a stable check name" || bad "IP check name"
sed -i '$d' "$PKGS/$SVC/service/main.mjs"
test_path=$(printf '/%s/%s/%s/%s' home developer private-build secret)
echo "const p='$test_path';" >> "$PKGS/$SVC/service/main.mjs"
tf "hard-coded developer path fails doctor" $SDK doctor $SVC
sed -i '$d' "$PKGS/$SVC/service/main.mjs"
echo "const oldToken = context.config.auth.admin_token;" >> "$PKGS/$SVC/package.mjs"
tf "legacy Core admin_token access fails doctor" $SDK doctor $SVC
sed -i '$d' "$PKGS/$SVC/package.mjs"
echo "--- 3. test / release / verify ---"
t "test runs self-test, smoke, and doctor" $SDK test $SVC
# ⭐ 正式 release 現在產出帶 shallow Git 身份的 package asset，所以來源必須是一個
#    乾淨的 Git 倉庫。這不是測試腳手架的細節，是新模型對 package repo 的要求。
git -C "$PKGS/$SVC" init -q -b main
git -C "$PKGS/$SVC" config user.name Smoke; git -C "$PKGS/$SVC" config user.email s@e
git -C "$PKGS/$SVC" remote add origin https://github.com/example/sdk-smoke.git
git -C "$PKGS/$SVC" add -A && git -C "$PKGS/$SVC" commit -qm "release: 0.1.0"
t "release runs doctor and the shared asset builder" $SDK release $SVC
tar tzf "dist/releases/$SVC/0.1.0/$SVC-0.1.0.tar.gz" | grep -q "/\.git/" \
  && ok "release asset carries a real shallow .git" || bad "release asset .git"
TAR=dist/releases/$SVC/0.1.0/$SVC-0.1.0.tar.gz
[ -f "$TAR" ] && [ -f "$TAR.sha256" ] && ok "release creates tar and SHA-256 sidecar" || bad "release artifacts"
node scripts/package-manager.mjs verify "$TAR" >/dev/null 2>&1 && ok "Core Package Manager independently verifies release" || bad "Core release verification"
$SDK release $SVC --json 2>/dev/null | grep -q '"sha256"' && ok "release JSON includes SHA-256" || bad "release JSON"

echo "--- 4. next / handoff / install negative path ---"
$SDK next $SVC --json | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["phase"] and isinstance(d["next"],list)' \
  && ok "next JSON includes phase and commands" || bad "next JSON"
t "handoff is generated" $SDK handoff $SVC
# handoff 落在工作樹之外（兄弟目錄），否則一次 handoff 就把乾淨的包判成 dev。
grep -q "current facts" "$PKGS/$SVC.sdk/handoff.md" && ok "HANDOFF template created" || bad "HANDOFF content"
[ ! -e "$PKGS/$SVC/.sdk" ] && ok "SDK metadata stays out of the package work tree" || bad "SDK metadata leaked into the work tree"
tf "install rejects a missing release path" $SDK install
$SDK install --json 2>/dev/null | grep -q missing_args && ok "install error includes code and usage" || bad "install error code"

echo "--- 5. Agent contract material ---"
grep -q "Required decision" sdk/AGENT_RULES.md && ok "Agent blocker template is present" || bad "Agent blocker template"
grep -q 'TERMUX_OS_PORT_<ID>' sdk/AI_AGENT_PROMPT.md \
  && grep -q 'TERMUX_OS_SYSTEM_KEY' sdk/AI_AGENT_PROMPT.md \
  && grep -q 'window.TermuxOS.api' sdk/AI_AGENT_PROMPT.md \
  && grep -q 'portrait phone' sdk/AI_AGENT_PROMPT.md \
  && ok "copy-ready Agent prompt covers current contracts" || bad "Agent prompt contract"
# ⭐ 官方樣本必須走它自己要教的那條流程。
# 此前這裡只斷言兩個文件「存在」，從不對示例跑 doctor——於是四個示例包同時
# 過不了官方質量門，而沒有任何測試看得見。被當作參考實現的東西，必須被它教的
# 那把尺量過。
for e in service-basic app-feed-consumer adapter-http asset-model; do
  [ -f "sdk/examples/$e/README.md" ] && [ -f "sdk/examples/$e/scripts/verify-device.mjs" ] \
    && ok "example $e includes docs and Device Verify" || bad "example $e"
  EID=$(python3 -c "import json;print(json.load(open('sdk/examples/$e/termux-os.package.json'))['id'])")
  ( cd "sdk/examples/$e" && node ../../termux-os-sdk.mjs doctor "$EID" --json ) \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["ok"] and d["counts"]["FAIL"]==0 else 1)' \
    && ok "example $e has zero doctor FAIL items" || bad "example $e doctor"
done

echo
echo "PASS=$pass FAIL=$fail"
[ $fail -eq 0 ] || exit 1
