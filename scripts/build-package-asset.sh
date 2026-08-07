#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: A Package source repository with a real origin, plus the ref to publish.
# [OUTPUT]: One `<id>-<version>.tar.gz` carrying a depth-1 Git history, and its `.sha256`.
# [POS]: scripts/build-package-asset.sh in termux-os-framework. The single builder shared by
#        `termux-os-sdk release` and every Package repository's GitHub Actions workflow, so a
#        locally built asset and a CI built asset cannot mean two different things.
# [PROTOCOL]: Never re-initialize a repository, never carry full history, never carry a
#             credential. Keep this English header synchronized with behavior.

set -euo pipefail

say() { echo "[asset] $*"; }
fail() { echo "[asset] ERROR: $*" >&2; exit 1; }

SOURCE=""
REF=""
BRANCH=""
OUT_DIR=""
ALLOW_DIRTY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help)
      echo "usage: build-package-asset.sh --source <repo-dir> [--ref <tag|commit>] [--branch <name>] --out-dir <dir> [--allow-dirty]"
      exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ -n "$SOURCE" ] || fail "--source is required"
[ -n "$OUT_DIR" ] || fail "--out-dir is required"
SOURCE="$(cd "$SOURCE" && pwd)"
[ -f "$SOURCE/termux-os.package.json" ] || fail "not a Package source directory: $SOURCE"
[ -d "$SOURCE/.git" ] || fail "$SOURCE is not a Git repository; this builder never runs 'git init'"

ID="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['id'])" "$SOURCE/termux-os.package.json")"
VERSION="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$SOURCE/termux-os.package.json")"

# 正式發布要求來源乾淨。dev 態允許出本地 artifact——它裝到設備上仍然帶同一個 Git
# baseline，於是解包後自然顯示為 dev，而不是變成另一種包。
# ⚠ 名出证据。此前这里只说「有未提交改动」而不说是哪些，于是 CI 上一个由步骤
# 自己产生的文件把树弄脏时，日志里没有任何线索指向它。
DIRTY="$(git -C "$SOURCE" -c core.fileMode=false -c core.autocrlf=false status --porcelain)"
if [ -n "$DIRTY" ] && [ "$ALLOW_DIRTY" -eq 0 ]; then
  echo "[asset] uncommitted entries:" >&2
  printf '%s\n' "$DIRTY" | sed 's/^/[asset]   /' >&2
  fail "$SOURCE has uncommitted changes; commit them or pass --allow-dirty for a local dev artifact"
fi
[ -n "$DIRTY" ] && say "WARNING: source work tree is dirty; building a local dev artifact"

: "${BRANCH:=$(git -C "$SOURCE" branch --show-current || true)}"
[ -n "$BRANCH" ] || fail "source is on a detached HEAD and no --branch was given"
: "${REF:=$BRANCH}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/$ID"

# ⭐ depth-1 clone 而不是 git init：baseline 必須是真實 upstream commit，否則設備上
#    做出來的修改沒有共同祖先，永遠推不回去。
say "cloning depth-1 from $SOURCE (ref $REF)"
git clone --quiet --depth 1 --branch "$REF" --no-tags "file://$SOURCE" "$STAGE" 2>/dev/null \
  || git clone --quiet --depth 1 "file://$SOURCE" "$STAGE" \
  || fail "depth-1 clone failed"

# clone --branch <tag> 會落在游離 HEAD 上：可以 commit，但沒有分支可推。
# 具名分支必須顯式建立，這是整條鏈裡最容易漏掉的一步。
git -C "$STAGE" checkout -q -B "$BRANCH" || fail "could not put the clone on branch $BRANCH"

ORIGIN="$(git -C "$SOURCE" remote get-url origin 2>/dev/null || true)"
if [ -n "$ORIGIN" ]; then
  git -C "$STAGE" remote set-url origin "$ORIGIN"
  say "origin preserved: $ORIGIN"
else
  say "WARNING: source has no origin; the asset will carry none"
  git -C "$STAGE" remote remove origin 2>/dev/null || true
fi
git -C "$STAGE" branch --quiet --set-upstream-to "origin/$BRANCH" 2>/dev/null || true

# 未提交的修改在 --allow-dirty 下要進 artifact，否則本地 dev 產物與工作樹不符。
if [ -n "$DIRTY" ]; then
  say "copying uncommitted changes into the artifact"
  ( cd "$SOURCE" && git status --porcelain -z | while IFS= read -r -d '' entry; do
      f="${entry:3}"
      [ -f "$f" ] && { mkdir -p "$STAGE/$(dirname "$f")"; cp -a "$f" "$STAGE/$f"; }
    done )
fi

# 憑據與 CI 本機痕跡不進包。
rm -rf "$STAGE/.git/hooks"
git -C "$STAGE" config --unset-all credential.helper 2>/dev/null || true
if grep -qiE '(oauth2|ghp_|github_pat_|password|token)[[:space:]]*[:=]' "$STAGE/.git/config" 2>/dev/null; then
  fail ".git/config carries what looks like a credential; refusing to build"
fi
case "$ORIGIN" in
  *@*:*|*//*:*@*) fail "origin URL embeds credentials; use a plain https or ssh URL" ;;
esac

mkdir -p "$OUT_DIR"
TAR="$OUT_DIR/$ID-$VERSION.tar.gz"
say "packing $TAR"
tar -czf "$TAR" -C "$WORK" "$ID"
SHA="$(sha256sum "$TAR" | cut -d' ' -f1)"
printf '%s  %s\n' "$SHA" "$(basename "$TAR")" > "$TAR.sha256"

WT_BYTES="$(du -sb "$STAGE" --exclude=.git | cut -f1)"
GIT_BYTES="$(du -sb "$STAGE/.git" | cut -f1)"
TAR_BYTES="$(stat -c '%s' "$TAR")"

cat <<JSON > "$TAR.asset.json"
{
  "schema": "termux-os.package-asset.v1",
  "id": "$ID",
  "version": "$VERSION",
  "branch": "$BRANCH",
  "ref": "$REF",
  "head": "$(git -C "$STAGE" rev-parse HEAD)",
  "shallow": $( [ -f "$STAGE/.git/shallow" ] && echo true || echo false ),
  "origin": $( [ -n "$ORIGIN" ] && printf '"%s"' "$ORIGIN" || echo null ),
  "dirty_source": $( [ -n "$DIRTY" ] && echo true || echo false ),
  "sha256": "$SHA",
  "bytes": { "work_tree": $WT_BYTES, "git": $GIT_BYTES, "archive": $TAR_BYTES }
}
JSON

say "id       : $ID $VERSION"
say "branch   : $BRANCH (HEAD $(git -C "$STAGE" rev-parse --short HEAD))"
say "shallow  : $( [ -f "$STAGE/.git/shallow" ] && echo yes || echo no )"
say "sha256   : $SHA"
say "size     : work tree ${WT_BYTES}B + .git ${GIT_BYTES}B → archive ${TAR_BYTES}B"
echo "$TAR"
