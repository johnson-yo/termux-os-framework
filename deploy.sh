#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: The exports or executable behavior implemented by this file.
# [POS]: deploy.sh in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

set -u
cd "$(dirname "$0")"

REMOTE="${DEPLOY_REMOTE:-}"
URL="${DEPLOY_URL:-}"
TMP_ROOT="$PWD/tmp"

say() { echo "[deploy] $*"; }
fail() { echo "[deploy] ERROR: $*" >&2; exit 1; }

user_entry() {
  local access
  [ -n "$URL" ] && say "Update complete: $URL/admin" || say "Update complete"
  access="$(ssh "$REMOTE" "curl -s -m 5 http://127.0.0.1:8980/api/access-info" 2>/dev/null)"
  [ -n "$access" ] || { say "⚠ 取不到 access-info"; return 0; }
  printf '%s' "$access" | node -e '
let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{try{
  const d=JSON.parse(s), p=d.primary||{};
  console.log("");
  console.log("=".repeat(60));
  console.log("USER ACTION REQUIRED\n");
  if (p.ip) {
    console.log("  Admin:       "+p.admin_url);
  } else {
    console.log("  ⚠ Framework 活著，但沒有檢測到可用 LAN 位址。");
  }
  console.log("\n  Build:       "+(d.git_commit||"unknown"));
  console.log("  Health:      PASS");
  console.log("=".repeat(60));
}catch{}})'
}

deploy() {
  local deploy_id run_id work stage archive sha remote_dir remote_archive remote_sha candidate_control
  [ -n "$REMOTE" ] || fail "DEPLOY_REMOTE is required (for example: DEPLOY_REMOTE=my-phone ./deploy.sh)"
  for f in package.json src/server.mjs scripts/framework.sh .deployignore; do
    [ -f "$f" ] || fail "缺少本地文件 $f"
  done
  bash -n scripts/framework.sh || fail "scripts/framework.sh 語法錯誤"
  ssh -o ConnectTimeout=8 "$REMOTE" 'echo ok' >/dev/null || fail "ssh $REMOTE 不可達"

  deploy_id="$(git rev-parse --short HEAD)$([ -z "$(git status --porcelain -- . 2>/dev/null)" ] || echo -dirty)"
  # 同一 commit 的并发部署也必须有不同的远端 archive/sidecar 名，不能串用 preflight 输入。
  run_id="$deploy_id-$(date +%s)-$$"
  work="$TMP_ROOT/framework-update-$run_id"
  stage="$work/framework"
  archive="$work/framework-$run_id.tar.gz"
  sha="$archive.sha256"
  rm -rf "$work"
  mkdir -p "$stage"
  trap 'rm -rf "$work"' EXIT

  # 候選 archive 是 update 的唯一輸入；live runtime 直到目標機 preflight+last-good 完成前完全不動。
  rsync -a --delete --exclude-from=.deployignore ./ "$stage/" || fail "建立 candidate tree 失敗"
  printf '%s\n' "$deploy_id" > "$stage/.deploy-id"
  tar -czf "$archive" -C "$work" framework || fail "candidate archive 失敗"
  printf '%s  %s\n' "$(sha256sum "$archive" | awk '{print $1}')" "$(basename "$archive")" > "$sha"

  remote_dir=".termux-os/update-inbox"
  remote_archive="$remote_dir/$(basename "$archive")"
  remote_sha="$remote_archive.sha256"
  candidate_control="framework.sh.candidate"
  ssh "$REMOTE" "mkdir -p \"\$HOME/$remote_dir\"" || fail "建立目標機 update inbox 失敗"
  scp -q "$archive" "$sha" "$REMOTE:$remote_dir/" || fail "傳送 candidate 失敗"
  scp -q scripts/framework.sh "$REMOTE:$candidate_control" || fail "傳送 candidate controller 失敗"

  say "preflight build=$deploy_id"
  ssh "$REMOTE" "bash \"\$HOME/$candidate_control\" preflight-update \"\$HOME/$remote_archive\" \"\$HOME/$remote_sha\"" \
    || fail "preflight 失敗；live runtime 未改動，archive 保留在 $remote_archive"

  say "update build=$deploy_id"
  if ! ssh "$REMOTE" "bash \"\$HOME/$candidate_control\" update \"\$HOME/$remote_archive\" \"\$HOME/$remote_sha\""; then
    fail "update 失敗；目標機引擎已嘗試自動 rollback，證據保留在 /sdcard/termux-os/framework/updates/"
  fi

  ssh "$REMOTE" "rm -f \"\$HOME/$candidate_control\" \"\$HOME/$remote_archive\" \"\$HOME/$remote_sha\"" || true
  user_entry
  rm -rf "$work"
  trap - EXIT
}

case "${1:-deploy}" in
  deploy) deploy ;;
  status|logs|rollback)
    [ -n "$REMOTE" ] || fail "DEPLOY_REMOTE is required"
    exec ssh "$REMOTE" "~/framework.sh $1"
    ;;
  *) echo "usage: deploy.sh [status|logs|rollback]" >&2; exit 1 ;;
esac
