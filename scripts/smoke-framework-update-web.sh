#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: The exports or executable behavior implemented by this file.
# [POS]: scripts/smoke-framework-update-web.sh in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/tmp"
WORK="$(mktemp -d "$ROOT/tmp/framework-update-web-smoke.XXXXXX")"
PORT=$((22500 + $$ % 1000))
BASE="http://127.0.0.1:$PORT"
HOME_DIR="$WORK/home"
RUNTIME="$WORK/runtime"
PERSIST="$WORK/persist"
CONF="$PERSIST/conf/framework.v1.json"
CONTROL="$HOME_DIR/framework.sh"
COOKIE="$WORK/cookie.txt"
PASS=0
FAIL=0

ok() { echo "PASS $*"; PASS=$((PASS + 1)); }
bad() { echo "FAIL $*"; FAIL=$((FAIL + 1)); }
run_control() {
  HOME="$HOME_DIR" FRAMEWORK_RUNTIME="$RUNTIME" FRAMEWORK_PERSIST="$PERSIST" FRAMEWORK_CONFIG="$CONF" \
    FRAMEWORK_CONTROL="$CONTROL" FRAMEWORK_PORT="$PORT" FRAMEWORK_BASE_URL="$BASE" "$CONTROL" "$@"
}
cleanup() {
  run_control stop >/dev/null 2>&1 || true
  find "$WORK" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

wait_health() {
  for _ in $(seq 1 120); do curl -sf -m 1 "$BASE/health" >/dev/null 2>&1 && return 0; sleep 0.1; done
  return 1
}
wait_job_file() {
  local id="$1" file status
  file="$PERSIST/updates/webui-jobs/$id.json"
  for _ in $(seq 1 240); do
    status="$(node -e 'try{process.stdout.write(require(process.argv[1]).status)}catch{}' "$file" 2>/dev/null)"
    case "$status" in success|failed) return 0 ;; esac
    sleep 0.1
  done
  return 1
}
login() {
  curl -sf -c "$COOKIE" -H 'Content-Type: application/json' --data '{"password":"smoke-password"}' \
    "$BASE/api/auth/login" >"$WORK/login.json"
  CSRF="$(node -e 'process.stdout.write(require(process.argv[1]).csrf_token)' "$WORK/login.json")"
}

mkdir -p "$HOME_DIR" "$PERSIST/conf" "$WORK/candidate/framework"
rsync -a --exclude-from="$ROOT/.deployignore" "$ROOT/" "$RUNTIME/"
printf 'web-old\n' >"$RUNTIME/.deploy-id"
rsync -a --exclude-from="$ROOT/.deployignore" "$ROOT/" "$WORK/candidate/framework/"
printf 'web-good\n' >"$WORK/candidate/framework/.deploy-id"
tar -czf "$WORK/candidate.tar.gz" -C "$WORK/candidate" framework
sha256sum "$WORK/candidate.tar.gz" | awk '{print $1 "  candidate.tar.gz"}' >"$WORK/candidate.tar.gz.sha256"
cp "$ROOT/scripts/framework.sh" "$CONTROL"
chmod +x "$CONTROL"
CONTROL_SHA_BEFORE="$(sha256sum "$CONTROL" | awk '{print $1}')"
node -e '
  const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({
    schema:"termux-os-framework.conf.v1",device_name:"framework-update-web-smoke",
    server:{host:"127.0.0.1",port:Number(process.argv[2])},auth:{admin_token:"smoke-password"},
    integrations:{app:{enabled:false,url:"http://127.0.0.1:1",token:""}}
  },null,2));
' "$CONF" "$PORT"

echo "=== 030 Framework Update WebUI smoke（隔离、不连手机）==="
echo "--- 1. Session gate / initial snapshot ---"
if run_control start >/dev/null && wait_health; then ok "temporary Framework started"; else bad "temporary Framework started"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/framework-update")"
[ "$CODE" = 401 ] && ok "Framework Update inventory requires auth" || bad "inventory auth HTTP $CODE"
login
curl -sf -b "$COOKIE" "$BASE/api/admin/framework-update" >"$WORK/initial.json"
if node -e 'const d=require(process.argv[1]);process.exit(d.ok&&d.schema==="termux-os.framework-update-web.v1"&&d.current_build==="web-old"&&Array.isArray(d.uploads)&&Array.isArray(d.history)?0:1)' "$WORK/initial.json"; then
  ok "initial snapshot exposes current build and engine truth"
else bad "initial snapshot schema"; fi

echo "--- 2. Upload / formal preflight ---"
CODE="$(curl -s -o "$WORK/no-csrf.json" -w '%{http_code}' -b "$COOKIE" -H 'Content-Type: application/octet-stream' \
  -H 'X-Filename: candidate.tar.gz' --data-binary "@$WORK/candidate.tar.gz" "$BASE/api/admin/framework-update/uploads")"
[ "$CODE" = 403 ] && ok "upload without CSRF rejected" || bad "upload without CSRF HTTP $CODE"
CODE="$(curl -s -o "$WORK/bad-name.json" -w '%{http_code}' -b "$COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/octet-stream' -H 'X-Filename: candidate.zip' --data-binary x "$BASE/api/admin/framework-update/uploads")"
if [ "$CODE" = 400 ] && grep -q invalid_archive_name "$WORK/bad-name.json"; then ok "non tar.gz candidate rejected"; else bad "non tar.gz candidate rejected"; fi
curl -sf -b "$COOKIE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/octet-stream' \
  -H 'X-Filename: candidate.tar.gz' --data-binary "@$WORK/candidate.tar.gz" "$BASE/api/admin/framework-update/uploads" >"$WORK/upload.json"
UPLOAD_ID="$(node -e 'process.stdout.write(require(process.argv[1]).upload.id)' "$WORK/upload.json")"
UPLOAD_SHA="$(node -e 'process.stdout.write(require(process.argv[1]).upload.sha256)' "$WORK/upload.json")"
curl -sf -b "$COOKIE" -H "X-CSRF-Token: $CSRF" -X POST --data '{}' \
  "$BASE/api/admin/framework-update/uploads/$UPLOAD_ID/preflight" >"$WORK/preflight.json"
PREFLIGHT_JOB="$(node -e 'process.stdout.write(require(process.argv[1]).job.id)' "$WORK/preflight.json")"
if wait_job_file "$PREFLIGHT_JOB"; then ok "detached formal preflight completed"; else bad "detached formal preflight completed"; fi
curl -sf -b "$COOKIE" "$BASE/api/admin/framework-update" >"$WORK/preflight-snapshot.json"
if node -e 'const d=require(process.argv[1]),u=d.uploads[0];process.exit(u?.status==="preflight_passed"&&u.preflight?.candidate_build==="web-good"?0:1)' "$WORK/preflight-snapshot.json"; then
  ok "preflight records candidate build through framework.sh"
else bad "preflight candidate result"; fi
if node -e 'const d=require(process.argv[1]),u=d.uploads[0],p=d.preflight_result;
  process.exit(p?.schema==="termux-os.framework-preflight.v1"&&p.status==="success"&&p.candidate_build==="web-good"
    &&p.archive_sha256===u.sha256&&u.preflight?.result?.schema===p.schema?0:1)' "$WORK/preflight-snapshot.json"; then
  ok "preflight uses structured engine evidence instead of parsing output"
else bad "structured preflight result"; fi

echo "--- 3. Confirmation / detached atomic update across server restart ---"
CODE="$(curl -s -o "$WORK/wrong-confirm.json" -w '%{http_code}' -b "$COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' -X POST --data '{"confirm_sha256":"wrong"}' \
  "$BASE/api/admin/framework-update/uploads/$UPLOAD_ID/update")"
[ "$CODE" = 409 ] && ok "update rejects wrong candidate SHA" || bad "update rejects wrong candidate SHA HTTP $CODE"
curl -sf -b "$COOKIE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' -X POST \
  --data "{\"confirm_sha256\":\"$UPLOAD_SHA\"}" "$BASE/api/admin/framework-update/uploads/$UPLOAD_ID/update" >"$WORK/update.json"
UPDATE_JOB="$(node -e 'process.stdout.write(require(process.argv[1]).job.id)' "$WORK/update.json")"
if wait_job_file "$UPDATE_JOB"; then ok "detached update worker survives Framework restart"; else bad "detached update worker survives Framework restart"; fi
if wait_health; then ok "candidate Framework restarted"; else bad "candidate Framework restarted"; fi
curl -sf -b "$COOKIE" "$BASE/api/admin/framework-update" >"$WORK/after-update.json"
if node -e 'const d=require(process.argv[1]);process.exit(d.current_build==="web-good"&&d.engine_state?.status==="success"&&d.active_job===null?0:1)' "$WORK/after-update.json"; then
  ok "Web snapshot restores exact successful engine result"
else bad "update result snapshot"; fi
if [ "$(sha256sum "$CONTROL" | awk '{print $1}')" = "$CONTROL_SHA_BEFORE" ]; then
  ok "web update preserves the trusted private controller"
else
  bad "web update preserves the trusted private controller"
fi
ID="$(node -e 'process.stdout.write(require(process.argv[1]).engine_state.update_id)' "$WORK/after-update.json")"
if cmp -s "$PERSIST/updates/$ID.before" "$PERSIST/updates/$ID.after" && [ ! -e "$PERSIST/updates/update.lock" ]; then
  ok "update boundary remains equal and engine lock is released"
else bad "update boundary or lock"; fi

echo "--- 4. Rollback confirmation / persistent history ---"
LAST_GOOD="$(node -e 'process.stdout.write(require(process.argv[1]).last_good.build)' "$WORK/after-update.json")"
CODE="$(curl -s -o "$WORK/wrong-rollback.json" -w '%{http_code}' -b "$COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' -X POST --data '{"confirm_last_good_build":"wrong"}' "$BASE/api/admin/framework-update/rollback")"
[ "$CODE" = 409 ] && ok "rollback rejects wrong last-good confirmation" || bad "rollback confirmation HTTP $CODE"
curl -sf -b "$COOKIE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' -X POST \
  --data "{\"confirm_last_good_build\":\"$LAST_GOOD\"}" "$BASE/api/admin/framework-update/rollback" >"$WORK/rollback.json"
ROLLBACK_JOB="$(node -e 'process.stdout.write(require(process.argv[1]).job.id)' "$WORK/rollback.json")"
if wait_job_file "$ROLLBACK_JOB" && wait_health; then ok "detached rollback completed"; else bad "detached rollback completed"; fi
curl -sf -b "$COOKIE" "$BASE/api/admin/framework-update" >"$WORK/after-rollback.json"
if node -e 'const d=require(process.argv[1]);process.exit(d.current_build==="web-old"&&d.engine_state?.status==="success"&&d.engine_state?.rollback===true&&d.history.length>=2?0:1)' "$WORK/after-rollback.json"; then
  ok "rollback result and engine history stay visible after restart"
else bad "rollback result snapshot"; fi

printf '\nPASS=%s FAIL=%s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
