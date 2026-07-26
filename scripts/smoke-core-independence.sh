#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Framework Core source, Node.js, curl, and isolated temporary directories.
# [OUTPUT]: Evidence that Core starts with no Package, product service, or product-specific media route.
# [POS]: scripts/smoke-core-independence.sh in termux-os-framework.
# [PROTOCOL]: Keep the empty-Core boundary synchronized with docs/ARCHITECTURE.md.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$ROOT/tmp" || exit 1
WORK=$(mktemp -d "$ROOT/tmp/core-independence.XXXXXX") || exit 1
PORT=$((23000 + $$ % 1000))
BASE="http://127.0.0.1:$PORT"
PID=""

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/home" "$WORK/packages"
HOME="$WORK/home" FRAMEWORK_AUTH_FILE="$WORK/home/auth.json" \
  BROWSER_SESSION_PATH="$WORK/home/sessions.json" PACKAGES_INSTALLED_DIR="$WORK/packages" \
  STAGE_DESIRED_PATH="$WORK/stage.json" HOST=127.0.0.1 PORT="$PORT" \
  node "$ROOT/src/server.mjs" >"$WORK/framework.log" 2>&1 &
PID=$!

for _ in $(seq 1 50); do
  curl -sf -m 1 "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$BASE/health" >/dev/null || { tail -30 "$WORK/framework.log"; exit 1; }

TOKEN=$(node -e 'process.stdout.write(require(process.argv[1]).admin_token)' "$WORK/home/auth.json")
api() { curl -sf -H "Authorization: Bearer $TOKEN" "$BASE$1"; }

api /api/packages | node -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const d=JSON.parse(s);process.exit(d.ok&&Array.isArray(d.packages)&&d.packages.length===0?0:1);
  });'
api /api/stage/services | node -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const d=JSON.parse(s);process.exit(d.ok&&Array.isArray(d.services)&&d.services.length===0?0:1);
  });'
api /api/theatre | node -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const d=JSON.parse(s),ids=d.actions.map(x=>x.id);
    process.exit(d.ok&&ids.length===1&&ids[0]==="debug.echo"?0:1);
  });'

for route in /api/audio/activity /api/asr/status /api/translate/status; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE$route")
  [ "$code" = 404 ] || { echo "FAIL product route remains: $route returned $code" >&2; exit 1; }
done

echo "PASS empty Core: 0 Packages, 0 services, no product media routes"
