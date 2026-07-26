#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Registry coordinates or a verified local GitHub source archive.
# [OUTPUT]: Safe source extraction, Framework runtime deployment, start/stop, and recovery helpers.
# [POS]: Shared implementation for install.sh, upgrade.sh, and uninstall.sh.
# [PROTOCOL]: Keep storage, verification, and recovery behavior synchronized with the installer docs.

set -euo pipefail

FRAMEWORK_REPOSITORY="${FRAMEWORK_REPOSITORY:-johnson-yo/termux-os-framework}"
REGISTRY_URL="${PACKAGE_REGISTRY_URL:-https://package.termux-os.com}"
FRAMEWORK_RUNTIME="${FRAMEWORK_RUNTIME:-$HOME/.termux-os/framework}"
FRAMEWORK_PERSIST="${FRAMEWORK_PERSIST:-/sdcard/termux-os/framework}"
FRAMEWORK_CONTROL="${FRAMEWORK_CONTROL:-$HOME/framework.sh}"
FRAMEWORK_CONFIG="${FRAMEWORK_CONFIG:-$FRAMEWORK_PERSIST/conf/framework.v1.json}"
FRAMEWORK_AUTH_FILE="${FRAMEWORK_AUTH_FILE:-$HOME/.termux-os/secrets/framework-auth.v1.json}"
FRAMEWORK_PORT="${FRAMEWORK_PORT:-8980}"
FRAMEWORK_BASE_URL="${FRAMEWORK_BASE_URL:-http://127.0.0.1:$FRAMEWORK_PORT}"
FRAMEWORK_INSTALLED_ROOT="${PACKAGES_INSTALLED_DIR:-$HOME/.termux-os/packages}"
FRAMEWORK_ASSET_ROOT="${FRAMEWORK_ASSET_ROOT:-/sdcard/termux-os/models}"
FRAMEWORK_UPDATE_ROOT="${FRAMEWORK_UPDATE_ROOT:-$FRAMEWORK_PERSIST/updates}"
FRAMEWORK_INSTALL_STATE="${FRAMEWORK_INSTALL_STATE:-$HOME/.termux-os/framework-install.v1.json}"
# WebUI workers may start without Termux's usual TMPDIR export. Keep installer
# staging inside the private Home fallback instead of assuming writable /tmp.
FRAMEWORK_WORK_ROOT="${FRAMEWORK_WORK_ROOT:-${TMPDIR:-${HOME}/.termux-os/tmp}/termux-os-framework-installer}"

INSTALL_SOURCE="github"
INSTALL_KIND="source_tar"
INSTALL_FILE="source.tar.gz"
INSTALL_VERSION=""
INSTALL_ARCHIVE=""
INSTALL_SHA256=""
INSTALL_START=1
INSTALL_FORCE=0
INSTALL_MODE="install"
INSTALL_STAGE=""
INSTALL_ROOT_NAME=""
INSTALL_CANDIDATE=""
INSTALL_OLD_RUNTIME=""
INSTALL_OLD_CONTROL=""
INSTALL_WAS_RUNNING=0

say() { printf '[framework-installer] %s\n' "$*"; }
err() { printf '[framework-installer] ERROR: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

require_tools() {
  local tool
  for tool in bash curl tar sha256sum node python3; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool is missing: $tool"
  done
}

usage_error() { die "invalid arguments; run $0 --help"; }

parse_common_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repository) [ "$#" -ge 2 ] || usage_error; FRAMEWORK_REPOSITORY="$2"; shift 2 ;;
      --registry) [ "$#" -ge 2 ] || usage_error; REGISTRY_URL="${2%/}"; shift 2 ;;
      --version) [ "$#" -ge 2 ] || usage_error; INSTALL_VERSION="$2"; shift 2 ;;
      --archive) [ "$#" -ge 2 ] || usage_error; INSTALL_ARCHIVE="$2"; shift 2 ;;
      --sha256) [ "$#" -ge 2 ] || usage_error; INSTALL_SHA256="$2"; shift 2 ;;
      --no-start) INSTALL_START=0; shift ;;
      --force) INSTALL_FORCE=1; shift ;;
      --help) return 2 ;;
      *) usage_error ;;
    esac
  done
  return 0
}

validate_version() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || die "invalid Framework version without v prefix: $1"
  printf '%s' "$value"
}

urlencode() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import quote
print(quote(sys.argv[1], safe=""))
PY
}

json_field() {
  local file="$1" expression="$2"
  node - "$file" "$expression" <<'NODE'
const fs = require('node:fs');
const [file, expression] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const value = expression.split('.').reduce((item, key) => item?.[key], data);
if (value !== undefined && value !== null) process.stdout.write(String(value));
NODE
}

query_latest_version() {
  local body="$FRAMEWORK_WORK_ROOT/list.json"
  mkdir -p "$FRAMEWORK_WORK_ROOT"
  curl -fsS --retry 2 -X POST "$REGISTRY_URL/list" \
    -H 'Content-Type: application/json' --data '{}' -o "$body" \
    || die "Framework Registry catalog request failed"
  node - "$body" "$FRAMEWORK_REPOSITORY" <<'NODE'
const fs = require('node:fs');
const [file, repository] = process.argv.slice(2);
const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
const project = (catalog.packages || []).find((item) =>
  item.source === 'github' && item.repository === repository && Array.isArray(item.types) && item.types.includes('framework'));
if (!project) process.exit(2);
const value = project.latest_verified_version || project.latest_version;
if (!value) process.exit(3);
process.stdout.write(value);
NODE
}

registry_check() {
  local version="$1" body="$FRAMEWORK_WORK_ROOT/check.json" encoded_repo encoded_version
  encoded_repo="$(urlencode "$FRAMEWORK_REPOSITORY")"
  encoded_version="$(urlencode "$version")"
  mkdir -p "$FRAMEWORK_WORK_ROOT"
  curl -fs --retry 2 -X POST "$REGISTRY_URL/check" \
    -H 'Content-Type: application/json' \
    --data "{\"source\":\"$INSTALL_SOURCE\",\"repository\":\"$FRAMEWORK_REPOSITORY\",\"version\":\"$version\",\"kind\":\"$INSTALL_KIND\",\"file\":\"$INSTALL_FILE\"}" \
    -o "$body" || return 1
  node - "$body" <<'NODE'
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const file = data.file;
if (!data.ok || !file || !file.sha256 || !Number.isSafeInteger(file.size)) process.exit(2);
process.stdout.write(`${file.size}\n${file.sha256}\n`);
NODE
}

download_archive() {
  local version="$1" size sha url encoded_repo encoded_version direct_url release_url
  version="$(validate_version "$version")"
  mapfile -t checked < <(registry_check "$version" || true)
  [ "${#checked[@]}" -eq 2 ] || die "Framework version is not available in the Registry: $version"
  size="${checked[0]:-}"; sha="${checked[1]:-}"
  [[ "$size" =~ ^[0-9]+$ ]] || die "Registry returned an invalid Framework size"
  [[ "$sha" =~ ^[a-fA-F0-9]{64}$ ]] || die "Registry returned an invalid Framework SHA-256"
  encoded_repo="$(urlencode "$FRAMEWORK_REPOSITORY")"
  encoded_version="$(urlencode "$version")"
  mkdir -p "$FRAMEWORK_WORK_ROOT"
  INSTALL_ARCHIVE="$FRAMEWORK_WORK_ROOT/framework-$version.tar.gz"
  direct_url="https://github.com/$FRAMEWORK_REPOSITORY/archive/refs/tags/$encoded_version.tar.gz"
  release_url="https://github.com/$FRAMEWORK_REPOSITORY/releases/tag/$encoded_version"

  download_verified() {
    local candidate="$1" label="$2" attempt actual_size actual_sha
    for attempt in 1 2 3; do
      rm -f "$INSTALL_ARCHIVE"
      if curl -fsS --retry 2 --retry-all-errors -L "$candidate" -o "$INSTALL_ARCHIVE"; then
        actual_size="$(wc -c < "$INSTALL_ARCHIVE")"
        actual_sha="$(sha256sum "$INSTALL_ARCHIVE" | awk '{print $1}')"
        if [ "$actual_size" -eq "$size" ] && [ "$actual_sha" = "$sha" ]; then
          say "downloaded from $label (attempt $attempt)"
          return 0
        fi
      fi
      say "$label download verification failed (attempt $attempt); retrying"
    done
    rm -f "$INSTALL_ARCHIVE"
    return 1
  }

  if curl -fsSIL --connect-timeout 6 --max-time 8 "$direct_url" >/dev/null 2>&1 \
    && download_verified "$direct_url" 'GitHub direct source'; then
    :
  else
    url="$REGISTRY_URL/download?source=$INSTALL_SOURCE&repository=$encoded_repo&version=$encoded_version&kind=$INSTALL_KIND&file=$INSTALL_FILE"
    download_verified "$url" 'Termux-OS Registry' \
      || die "Framework download failed at both stages; download manually from $release_url and run install.sh --archive <file> --version $version --sha256 $sha"
  fi
  INSTALL_SHA256="$sha"
  say "verified Framework $version ($size bytes, sha256=$sha)"
}

validate_archive() {
  local archive="$1" entry clean first=""
  tar -tzf "$archive" >/dev/null || die "archive is unreadable: $archive"
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case "$entry" in /*|*"//"*|*"../"*|../*) die "unsafe archive path: $entry" ;; esac
    clean="${entry%/}"
    [ -n "$clean" ] || continue
    if [ -z "$first" ]; then first="${clean%%/*}"; else [ "$first" = "${clean%%/*}" ] || die "archive contains multiple top-level roots"; fi
  done < <(tar -tzf "$archive")
  [ -n "$first" ] || die "archive is empty"
  INSTALL_ROOT_NAME="$first"
}

prepare_candidate() {
  local archive="$1" version="$2" root_dir package_version build_id release_meta
  validate_archive "$archive"
  INSTALL_STAGE="$FRAMEWORK_WORK_ROOT/stage-$$"
  rm -rf "$INSTALL_STAGE"
  mkdir -p "$INSTALL_STAGE"
  tar -xzf "$archive" -C "$INSTALL_STAGE" --no-same-owner --no-same-permissions
  INSTALL_CANDIDATE="$INSTALL_STAGE/$INSTALL_ROOT_NAME"
  [ -f "$INSTALL_CANDIDATE/package.json" ] || die "Framework source archive lacks package.json"
  [ -f "$INSTALL_CANDIDATE/src/server.mjs" ] || die "Framework source archive lacks src/server.mjs"
  [ -f "$INSTALL_CANDIDATE/config/defaults/framework.v1.json" ] || die "Framework source archive lacks default config"
  [ -f "$INSTALL_CANDIDATE/scripts/framework.sh" ] || die "Framework source archive lacks runtime controller"
  [ -f "$INSTALL_CANDIDATE/scripts/install.sh" ] || die "Framework source archive lacks installer"
  package_version="$(json_field "$INSTALL_CANDIDATE/package.json" version)"
  [ -n "$package_version" ] || die "Framework package.json has no version"
  [ "$package_version" = "$version" ] \
    || die "Registry version and package.json version differ"
  build_id="framework-$version"
  printf '%s\n' "$build_id" > "$INSTALL_CANDIDATE/.deploy-id"
  release_meta="$INSTALL_CANDIDATE/.framework-release.json"
  RELEASE_VERSION="$version" RELEASE_SHA256="${INSTALL_SHA256:-unknown}" RELEASE_REPOSITORY="$FRAMEWORK_REPOSITORY" \
    RELEASE_KIND="$INSTALL_KIND" node - "$release_meta" <<'NODE'
const fs = require('node:fs');
const output = process.argv[2];
fs.writeFileSync(output, `${JSON.stringify({
  schema: 'termux-os.framework-release.v1',
  source: 'github',
  repository: process.env.RELEASE_REPOSITORY,
  version: process.env.RELEASE_VERSION,
  kind: process.env.RELEASE_KIND,
  archive_sha256: process.env.RELEASE_SHA256,
  installed_at: new Date().toISOString(),
}, null, 2)}\n`);
NODE
}

running() { curl -sf -m 2 "$FRAMEWORK_BASE_URL/health" >/dev/null 2>&1; }

run_controller() {
  local action="$1"
  [ -f "$FRAMEWORK_CONTROL" ] || return 1
  env \
    FRAMEWORK_RUNTIME="$FRAMEWORK_RUNTIME" \
    FRAMEWORK_PERSIST="$FRAMEWORK_PERSIST" \
    FRAMEWORK_CONTROL="$FRAMEWORK_CONTROL" \
    FRAMEWORK_CONFIG="$FRAMEWORK_CONFIG" \
    FRAMEWORK_AUTH_FILE="$FRAMEWORK_AUTH_FILE" \
    PACKAGES_INSTALLED_DIR="$FRAMEWORK_INSTALLED_ROOT" \
    FRAMEWORK_ASSET_ROOT="$FRAMEWORK_ASSET_ROOT" \
    FRAMEWORK_UPDATE_ROOT="$FRAMEWORK_UPDATE_ROOT" \
    FRAMEWORK_PORT="$FRAMEWORK_PORT" \
    FRAMEWORK_BASE_URL="$FRAMEWORK_BASE_URL" \
    bash "$FRAMEWORK_CONTROL" "$action"
}

install_controller() {
  local source="${1:-$FRAMEWORK_RUNTIME/scripts/framework.sh}" next="$FRAMEWORK_CONTROL.next"
  mkdir -p "$(dirname "$FRAMEWORK_CONTROL")"
  cp "$source" "$next"
  chmod 700 "$next"
  bash -n "$next"
  mv -f "$next" "$FRAMEWORK_CONTROL"
  chmod 700 "$FRAMEWORK_CONTROL"
}

write_install_state() {
  local previous="$1" version="$2"
  mkdir -p "$(dirname "$FRAMEWORK_INSTALL_STATE")"
    INSTALL_STATE="$FRAMEWORK_INSTALL_STATE" INSTALL_PREVIOUS="$previous" INSTALL_VERSION="$version" \
    INSTALL_RUNTIME="$FRAMEWORK_RUNTIME" \
    node <<'NODE'
const fs = require('node:fs');
const file = process.env.INSTALL_STATE;
const state = {
  schema: 'termux-os.framework-install-state.v1',
  version: process.env.INSTALL_VERSION,
  runtime: process.env.INSTALL_RUNTIME,
  previous_runtime: process.env.INSTALL_PREVIOUS || null,
  updated_at: new Date().toISOString(),
};
fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
fs.renameSync(`${file}.tmp`, file);
NODE
}

restore_failed_install() {
  local current_backup="$1" control_backup="$2"
  run_controller stop >/dev/null 2>&1 || true
  preserve_runtime_state "$FRAMEWORK_RUNTIME" "$current_backup" || true
  rm -rf "$FRAMEWORK_RUNTIME"
  [ -d "$current_backup" ] && mv "$current_backup" "$FRAMEWORK_RUNTIME"
  if [ -f "$control_backup" ]; then cp "$control_backup" "$FRAMEWORK_CONTROL"; chmod 700 "$FRAMEWORK_CONTROL"; fi
  if [ "$INSTALL_WAS_RUNNING" = 1 ]; then run_controller start >/dev/null 2>&1 || true; fi
}

preserve_runtime_state() {
  local from="$1" to="$2" rel
  [ -d "$from" ] && [ -d "$to" ] || return 0
  for rel in .runtime framework.log; do
    if [ -e "$from/$rel" ]; then
      rm -rf "$to/$rel"
      mv "$from/$rel" "$to/$rel"
    fi
  done
}

deploy_candidate() {
  local version="$1" stamp backup control_backup
  mkdir -p "$(dirname "$FRAMEWORK_RUNTIME")" "$FRAMEWORK_PERSIST/conf" "$FRAMEWORK_PERSIST/backups" "$FRAMEWORK_PERSIST/history"
  INSTALL_WAS_RUNNING=0
  running && INSTALL_WAS_RUNNING=1
  if [ "$INSTALL_WAS_RUNNING" = 1 ] || [ -f "$FRAMEWORK_CONTROL" ]; then run_controller stop >/dev/null 2>&1 || die "could not stop the current Framework"; fi
  stamp="$(date +%Y%m%d-%H%M%S)-$$"
  backup="$(dirname "$FRAMEWORK_RUNTIME")/.framework-previous-$stamp"
  control_backup="$FRAMEWORK_WORK_ROOT/framework.sh.previous"
  if [ -f "$FRAMEWORK_CONTROL" ]; then cp "$FRAMEWORK_CONTROL" "$control_backup"; fi
  if [ -d "$FRAMEWORK_RUNTIME" ]; then mv "$FRAMEWORK_RUNTIME" "$backup"; fi
  if ! mv "$INSTALL_CANDIDATE" "$FRAMEWORK_RUNTIME"; then
    [ -d "$backup" ] && mv "$backup" "$FRAMEWORK_RUNTIME"
    die "could not activate Framework runtime"
  fi
  preserve_runtime_state "$backup" "$FRAMEWORK_RUNTIME"
  if ! install_controller || ! run_controller bootstrap >/dev/null 2>&1; then
    restore_failed_install "$backup" "$control_backup"
    die "Framework bootstrap failed; previous runtime was restored"
  fi
  if [ "$INSTALL_START" = 1 ] && ! run_controller start >/dev/null 2>&1; then
    restore_failed_install "$backup" "$control_backup"
    die "Framework start failed; previous runtime was restored"
  fi
  if [ "$INSTALL_START" = 1 ] && ! run_controller health >/dev/null 2>&1; then
    restore_failed_install "$backup" "$control_backup"
    die "Framework health check failed; previous runtime was restored"
  fi
  write_install_state "$backup" "$version"
  say "Framework $version installed"
}

prepare_and_deploy() {
  local version="$1"
  [ -f "$INSTALL_ARCHIVE" ] || die "archive is missing"
  [ -n "$INSTALL_SHA256" ] && [ "$(sha256sum "$INSTALL_ARCHIVE" | awk '{print $1}')" = "$INSTALL_SHA256" ] \
    || [ -z "$INSTALL_SHA256" ] || die "local archive SHA-256 mismatch"
  prepare_candidate "$INSTALL_ARCHIVE" "$version"
  deploy_candidate "$version"
  rm -rf "$INSTALL_STAGE"
}
