#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: The exports or executable behavior implemented by this file.
# [POS]: scripts/smoke-package-runtime.sh in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
PM="node scripts/package-manager.mjs"
FIX_SRC="$ROOT/src/packages/fixtures/github.termux-os.fixture.runtime-contract"
ID=github.termux-os.fixture.runtime-contract
WORK=$(mktemp -d)
export PACKAGES_INSTALLED_DIR="$WORK/installed"   # 絕不碰真的 installed root
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1${2:+ — $2}"; fail=$((fail+1)); }
# 期望失敗：命令必須非零退出，且輸出含指定關鍵字（只失敗不夠——要為對的理由失敗）
expect_fail() { # <name> <keyword> <cmd...>
  local name=$1 kw=$2; shift 2
  local out; out=$("$@" 2>&1); local rc=$?
  if [ $rc -eq 0 ]; then bad "$name" "command unexpectedly succeeded"; return; fi
  echo "$out" | grep -q -- "$kw" && ok "$name" || bad "$name" "wrong reason: $(echo "$out" | head -2 | tr '\n' ' ')"
}
expect_ok() { # <name> <cmd...>
  local name=$1; shift
  local out; out=$("$@" 2>&1)
  [ $? -eq 0 ] && ok "$name" || bad "$name" "$(echo "$out" | head -2 | tr '\n' ' ')"
}

# 生成一個變體 Source：複製 fixture → 注入 artifacts（鏡像包內相對路徑）→ 可選 mutate
mkvariant() { # <name> → echo <dir>
  local d="$WORK/src-$1"
  rm -rf "$d"; cp -r "$FIX_SRC" "$d"
  echo "$d"
}
add_artifacts() { # <dir>
  mkdir -p "$1/service/native/bin" "$1/assets"
  cp /bin/true "$1/service/native/bin/tool"; chmod 755 "$1/service/native/bin/tool"
  printf 'fixture-data' > "$1/assets/data.bin"
}
packv() { # <dir> [extra args...]
  local d=$1; shift
  $PM pack $ID --source "$d" "$@"
}

echo "=== 023 Runtime Contract smoke（fixtures，不連手機）==="
echo "--- 0. 模塊 self-test（唯一判定源）---"
expect_ok "manifest self-test"         node src/packages/manifest.mjs --self-test
expect_ok "runtime-contract self-test" node src/packages/runtime-contract.mjs --self-test
expect_ok "loader self-test"           node src/packages/loader.mjs --self-test

echo "--- 1. valid：宣告齊備 → pack 成功 ---"
V=$(mkvariant valid); add_artifacts "$V"
expect_ok "valid fixture packs" packv "$V"

echo "--- 2. missing-required-file：宣告了卻沒帶 → pack 失敗（022 的洞）---"
V=$(mkvariant missing); add_artifacts "$V"; rm "$V/assets/data.bin"
expect_fail "missing required artifact refused" "missing required runtime artifacts" packv "$V"

echo "--- 3. wrong-artifact-layout：artifact 放根層而非鏡像路徑 → pack 失敗且給出預期路徑 ---"
V=$(mkvariant layout); A="$WORK/art-wrong"; rm -rf "$A"; mkdir -p "$A"
cp /bin/true "$A/tool"; printf 'x' > "$A/data.bin"     # 錯：應為 service/native/bin/tool
expect_fail "wrong artifact-dir layout refused" "must MIRROR the package-internal relative path" \
  packv "$V" --artifact-dir "$A"

echo "--- 4. wrong-arch：ELF 架構與 target 不符 → pack 失敗 ---"
V=$(mkvariant arch); add_artifacts "$V"
python3 - "$V/termux-os.package.json" <<'PY'
import json,sys
p=sys.argv[1]; m=json.load(open(p))
m["targets"]=[{"id":"android-arm64-v73-qnn247","os":"android","arch":"arm64","htp":"v73","qnn":"2.47"}]
json.dump(m,open(p,"w"),indent=2)
PY
expect_fail "ELF arch mismatch refused" "arch is" packv "$V" --target android-arm64-v73-qnn247

echo "--- 5. forbidden-path：代碼含開發機路徑 → pack 失敗（§5.3）---"
V=$(mkvariant forbidden); add_artifacts "$V"
private_path=$(printf '/%s/%s/%s/%s' home developer private-build secret)
printf 'export const P = "%s";\n' "$private_path" > "$V/leak.mjs"
expect_fail "forbidden dev path refused" "forbidden content" packv "$V"

echo "--- 6. missing-python-module：required external 缺失 → check 非零並給原因 ---"
V=$(mkvariant pymod); add_artifacts "$V"
python3 - "$V/termux-os.package.json" <<'PY'
import json,sys
p=sys.argv[1]; m=json.load(open(p))
m["version"]="0.1.1"
m["runtime"]["termux_packages"]=[{"id":"ghost-module",
  "probe":{"type":"python_import","value":"definitely_not_a_module_xyz"},"required":True}]
json.dump(m,open(p,"w"),indent=2)
PY
expect_ok "pymod fixture packs" packv "$V"
T111=dist/releases/$ID/0.1.1/$ID-0.1.1-fixture-host.tar.gz
expect_fail "missing python module reported by check" "python import" $PM check "$T111"

echo "--- 7. target-mismatch：install 必須在動現場前拒絕（§6.2）---"
V=$(mkvariant mismatch); add_artifacts "$V"
python3 - "$V/termux-os.package.json" <<'PY'
import json,sys
p=sys.argv[1]; m=json.load(open(p))
m["version"]="0.1.2"
m["targets"]=[{"id":"android-arm64-v73-qnn247","os":"android","arch":"arm64","htp":"v73","qnn":"2.47"}]
m["runtime"]["bundled"]=[{"path":"assets/data.bin","type":"file","required":True}]  # 避開 ELF 架構檢查
json.dump(m,open(p,"w"),indent=2)
PY
expect_ok "mismatch fixture packs" packv "$V" --target android-arm64-v73-qnn247
T112=dist/releases/$ID/0.1.2/$ID-0.1.2-android-arm64-v73-qnn247.tar.gz
expect_fail "target mismatch refused by check"   "mismatch" $PM check "$T112"
expect_fail "target mismatch refused by install" "target mismatch" $PM install "$T112"
[ -e "$PACKAGES_INSTALLED_DIR/$ID" ] && bad "mismatch install left no trace" "package dir created" \
  || ok "mismatch install left no trace"

echo "--- 8. 同 version 同 target 不同 hash 必須拒（022 紅線在 023 後仍成立）---"
T010=dist/releases/$ID/0.1.0/$ID-0.1.0-fixture-host.tar.gz
expect_ok "install valid fixture to temp root" $PM install "$T010"
V=$(mkvariant rehash); add_artifacts "$V"; printf 'CHANGED' > "$V/assets/data.bin"
expect_ok "repack same version different content" packv "$V"
expect_fail "same version+target different hash refused" "different hash refused" $PM install "$T010"
ACTIVE="$PACKAGES_INSTALLED_DIR/$ID/active.json"
grep -q '"active_target": "fixture-host"' "$ACTIVE" && ok "active_target recorded" || bad "active_target recorded"

echo "--- 9. 同 version 不同 target 可共存（§7.1）---"
grep -q '"0.1.0@fixture-host"' "$ACTIVE" && ok "hashes keyed by version@target" || bad "hashes keyed by version@target"

echo
echo "PASS=$pass FAIL=$fail"
[ $fail -eq 0 ] || exit 1
