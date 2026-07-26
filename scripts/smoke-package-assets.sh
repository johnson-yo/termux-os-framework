#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: The exports or executable behavior implemented by this file.
# [POS]: scripts/smoke-package-assets.sh in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
PM="node scripts/package-manager.mjs"
FIX_SRC="$ROOT/src/packages/fixtures/github.termux-os.fixture.asset-model"
ID=github.termux-os.fixture.asset-model
WORK=$(mktemp -d)
export PACKAGES_INSTALLED_DIR="$WORK/installed"
export SHARED_ASSET_STORE="$WORK/store"          # 真機 Model Asset 是 /sdcard/termux-os/models
export ASSETS_REGISTRY_DIR="$WORK/registry"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1${2:+ — $2}"; fail=$((fail+1)); }
expect_fail() { # <name> <keyword> <cmd...> —— 必須非零退出**且**為對的理由失敗
  local name=$1 kw=$2; shift 2
  local out; out=$("$@" 2>&1); local rc=$?
  if [ $rc -eq 0 ]; then bad "$name" "command unexpectedly succeeded"; return; fi
  echo "$out" | grep -q -- "$kw" && ok "$name" || bad "$name" "wrong reason: $(echo "$out" | head -2 | tr '\n' ' ')"
}
expect_ok() { local name=$1; shift; local out; out=$("$@" 2>&1)
  [ $? -eq 0 ] && ok "$name" || bad "$name" "$(echo "$out" | head -2 | tr '\n' ' ')"; }

# 造一個變體 Source（payload 為 KB 級假模型），可指定內容與版本
mkasset() { # <name> <version> <payload-content> [target-id]
  local d="$WORK/src-$1" v=$2 content=$3 tgt=${4:-fixture-host}
  rm -rf "$d"; cp -r "$FIX_SRC" "$d"
  mkdir -p "$d/payload/fixture"
  printf '%s' "$content" > "$d/payload/fixture/fixture.ctx.onnx"
  local sha; sha=$(sha256sum "$d/payload/fixture/fixture.ctx.onnx" | cut -d' ' -f1)
  cat > "$d/payload/fixture/asset.json" <<EOF
{
  "schema": "termux-os.model-asset.v1",
  "id": "model.fixture",
  "model": "Fixture",
  "format": "onnx-qnn-context",
  "htp": "v79",
  "qnn": "2.47",
  "files": [ { "path": "fixture.ctx.onnx", "sha256": "$sha" } ]
}
EOF
  python3 - "$d/termux-os.package.json" "$v" <<'PY'
import json,sys
p,v=sys.argv[1],sys.argv[2]
m=json.load(open(p)); m["version"]=v; json.dump(m,open(p,"w"),indent=2)
PY
  echo "$d"
}
tarof() { echo "dist/releases/$ID/$1/$ID-$1-$2.tar.gz"; }

echo "=== 024 Reproducible Release + Model Asset smoke（fixtures，不連手機）==="

echo "--- 0. 模塊 self-test ---"
expect_ok "manifest self-test"        node src/packages/manifest.mjs --self-test
expect_ok "asset registry self-test"  node src/assets/registry.mjs --self-test
expect_ok "asset resolver self-test"  node src/assets/resolver.mjs --self-test
expect_ok "asset runtime self-test"   node src/assets/runtime.mjs --self-test

echo "--- 1. 可復現：同輸入 → 同位元組（§2.3）---"
V=$(mkasset repro 0.1.0 "PAYLOAD-A")
expect_ok "pack A" $PM pack $ID --source "$V" --target fixture-host
cp "$(tarof 0.1.0 fixture-host)" "$WORK/a.tgz"
sleep 1.1   # 讓時間戳有機會漂；不確定的歸檔會在此露餡
expect_ok "pack B" $PM pack $ID --source "$V" --target fixture-host
cp "$(tarof 0.1.0 fixture-host)" "$WORK/b.tgz"
cmp -s "$WORK/a.tgz" "$WORK/b.tgz" && ok "two packs are byte-identical" || bad "two packs are byte-identical"
[ "$(sha256sum < "$WORK/a.tgz")" = "$(sha256sum < "$WORK/b.tgz")" ] && ok "same sha256" || bad "same sha256"

echo "--- 2. 可復現不是靠無視輸入：改內容 → 必須換 sha（§2.3）---"
V2=$(mkasset repro2 0.1.0 "PAYLOAD-CHANGED")
expect_ok "pack changed input" $PM pack $ID --source "$V2" --target fixture-host
cmp -s "$WORK/a.tgz" "$(tarof 0.1.0 fixture-host)" && bad "changed input changes sha" "identical!" \
  || ok "changed input changes sha"
# 還原 0.1.0 的正式 tar（後續安裝用 PAYLOAD-A）
$PM pack $ID --source "$V" --target fixture-host >/dev/null 2>&1

echo "--- 3. tar 內不含構建機痕跡（§2.1）---"
LIST=$(tar -tvzf "$WORK/a.tgz")
echo "$LIST" | grep -qE '(^|[ /])(root|0)/(root|0)|/0 ' && ok "uid/gid normalized" || \
  { echo "$LIST" | head -2; bad "uid/gid normalized"; }
echo "$LIST" | grep -q "1970-01-01" && ok "mtime pinned to epoch" || bad "mtime pinned to epoch"
echo "$LIST" | grep -q "$(id -un)" && bad "no builder username in tar" || ok "no builder username in tar"

echo "--- 4. valid：安裝 → payload 落不可變版本目錄 + Registry ready ---"
expect_ok "install asset package" $PM install "$(tarof 0.1.0 fixture-host)"
PAY="$SHARED_ASSET_STORE/$ID/0.1.0/fixture-host/fixture"
[ -f "$PAY/fixture.ctx.onnx" ] && ok "payload at immutable version dir" || bad "payload at immutable version dir"
[ "$(cat "$PAY/fixture.ctx.onnx")" = "PAYLOAD-A" ] && ok "payload content correct" || bad "payload content correct"
grep -q '"model.fixture"' "$ASSETS_REGISTRY_DIR/registry.v1.json" && ok "registry entry written" || bad "registry entry written"
[ ! -d "$SHARED_ASSET_STORE/.staging" ] && ok "staging cleaned up" || bad "staging cleaned up"

echo "--- 5. existing-same-hash：重裝同內容 → 複用，不重抄（§5）---"
OUT=$($PM install "$(tarof 0.1.0 fixture-host)" 2>&1)
echo "$OUT" | grep -q "changed=false" && ok "same version+target+hash is idempotent" || bad "same version+target+hash is idempotent" "$OUT"

echo "--- 6. existing-different-hash：同版本同 target 換內容 → 拒（不覆蓋 /sdcard）---"
V3=$(mkasset diff 0.1.0 "PAYLOAD-EVIL")
$PM pack $ID --source "$V3" --target fixture-host >/dev/null 2>&1
expect_fail "same version different payload refused" "different hash refused" $PM install "$(tarof 0.1.0 fixture-host)"
[ "$(cat "$PAY/fixture.ctx.onnx")" = "PAYLOAD-A" ] && ok "existing payload untouched after refusal" || bad "existing payload untouched after refusal"
$PM pack $ID --source "$V" --target fixture-host >/dev/null 2>&1   # 還原

echo "--- 7. bad-payload-hash：asset.json 與實際檔案不符 → 安裝前就拒 ---"
V4=$(mkasset badhash 0.2.0 "PAYLOAD-A")
printf 'TAMPERED-AFTER-HASHING' > "$V4/payload/fixture/fixture.ctx.onnx"
$PM pack $ID --source "$V4" --target fixture-host >/dev/null 2>&1
expect_fail "payload checksum mismatch refused" "checksum mismatch" $PM install "$(tarof 0.2.0 fixture-host)"

echo "--- 8. missing-payload：宣告了 payload 卻沒帶 → 安裝拒 ---"
V5=$(mkasset nopayload 0.3.0 "X")
rm -rf "$V5/payload"
$PM pack $ID --source "$V5" --target fixture-host >/dev/null 2>&1
expect_fail "missing payload refused" "asset payload missing" $PM install "$(tarof 0.3.0 fixture-host)"

echo "--- 9. target-mismatch：v79 的 Asset 裝到本機 → 動現場前拒（§12.6）---"
V6=$(mkasset v79 0.4.0 "PAYLOAD-V79" android-arm64-v79-qnn247)
expect_ok "pack v79 variant" $PM pack $ID --source "$V6" --target android-arm64-v79-qnn247
expect_fail "wrong target refused by check"   "mismatch" $PM check "$(tarof 0.4.0 android-arm64-v79-qnn247)"
expect_fail "wrong target refused by install" "target mismatch" $PM install "$(tarof 0.4.0 android-arm64-v79-qnn247)"
[ ! -d "$SHARED_ASSET_STORE/$ID/0.4.0" ] && ok "no payload copied for rejected target" || bad "no payload copied for rejected target"

echo "--- 10. registry-update + rollback：只切指針，不搬位元組（§6.2）---"
V7=$(mkasset v011 0.1.1 "PAYLOAD-B")
expect_ok "pack 0.1.1" $PM pack $ID --source "$V7" --target fixture-host
expect_ok "install 0.1.1" $PM install "$(tarof 0.1.1 fixture-host)"
grep -q '"version": "0.1.1"' "$ASSETS_REGISTRY_DIR/registry.v1.json" && ok "registry points at 0.1.1" || bad "registry points at 0.1.1"
[ -f "$SHARED_ASSET_STORE/$ID/0.1.0/fixture-host/fixture/fixture.ctx.onnx" ] && ok "0.1.0 payload kept" || bad "0.1.0 payload kept"
expect_ok "rollback to 0.1.0" $PM rollback $ID
grep -q '"version": "0.1.0"' "$ASSETS_REGISTRY_DIR/registry.v1.json" && ok "registry rolled back to 0.1.0" || bad "registry rolled back to 0.1.0"
[ -f "$SHARED_ASSET_STORE/$ID/0.1.1/fixture-host/fixture/fixture.ctx.onnx" ] && ok "0.1.1 payload NOT deleted by rollback" || bad "0.1.1 payload NOT deleted by rollback"

echo "--- 11. uninstall：摘登記，payload 保留（§6.3 無 purge）---"
expect_ok "uninstall asset package" $PM uninstall $ID
python3 -c "
import json,os,sys
r=json.load(open(os.environ['ASSETS_REGISTRY_DIR']+'/registry.v1.json'))
sys.exit(0 if 'model.fixture' not in r['assets'] else 1)" && ok "registry entry removed" || bad "registry entry removed"
[ -f "$PAY/fixture.ctx.onnx" ] && ok "shared payload kept after uninstall" || bad "shared payload kept after uninstall"

echo "--- 12. service-missing-asset：解析不到 → missing_asset，不含糊（§8.1）---"
R=$(node -e "
process.env.ASSETS_REGISTRY_DIR='$ASSETS_REGISTRY_DIR';
const { resolveAsset } = await import('./src/assets/resolver.mjs');
const r = resolveAsset('model.fixture', { profile: { os:'linux', arch:'x86_64' } });
console.log(r.ready, r.reason);
" --input-type=module 2>/dev/null || node --input-type=module -e "
const { resolveAsset } = await import('$ROOT/src/assets/resolver.mjs');
const r = resolveAsset('model.fixture', { profile: { os:'linux', arch:'x86_64' } });
console.log(r.ready, r.reason);")
echo "$R" | grep -q "false missing_asset:model.fixture" && ok "uninstalled asset resolves to missing_asset" || bad "uninstalled asset resolves to missing_asset" "$R"

echo
echo "PASS=$pass FAIL=$fail"
[ $fail -eq 0 ] || exit 1
