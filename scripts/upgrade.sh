#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: A newer Framework Registry version or a local verified source archive.
# [OUTPUT]: An atomically upgraded Framework with preserved persistent state.
# [POS]: Independent Framework upgrade and rollback entrypoint.
# [PROTOCOL]: Keep upgrade recovery synchronized with installer-lib.sh and Framework storage contracts.

set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=installer-lib.sh
source "$SCRIPT_DIR/installer-lib.sh"

usage() {
  cat <<'EOF'
Usage: upgrade.sh [options]

Options:
  --repository OWNER/REPOSITORY  GitHub source repository
  --registry URL                 Package Registry origin
  --version VERSION              Exact Registry version; omitted means latest
  --archive FILE                Use a previously downloaded source archive
  --sha256 HASH                 Expected SHA-256 for --archive
  --no-start                    Upgrade without starting Framework
  --force                       Allow the same version to be reinstalled
  --rollback                    Restore the last-good archive through the controller
EOF
}

ROLLBACK=0
ARGS=()
while [ "$#" -gt 0 ]; do
  if [ "$1" = --rollback ]; then ROLLBACK=1; shift; else ARGS+=("$1"); shift; fi
done
if parse_common_args "${ARGS[@]}"; then :; else usage; exit 0; fi
require_tools

if [ "$ROLLBACK" = 1 ]; then
  [ -f "$FRAMEWORK_CONTROL" ] || die "Framework controller is not installed"
  run_controller rollback
  exit 0
fi

[ -d "$FRAMEWORK_RUNTIME" ] || die "Framework is not installed; use install.sh"
current="$(json_field "$FRAMEWORK_RUNTIME/package.json" version 2>/dev/null || true)"
if [ -n "$INSTALL_ARCHIVE" ]; then
  [ -f "$INSTALL_ARCHIVE" ] || die "archive does not exist: $INSTALL_ARCHIVE"
  [ -n "$INSTALL_VERSION" ] || die "--version is required with --archive"
  INSTALL_VERSION="$(validate_version "$INSTALL_VERSION")"
else
  INSTALL_VERSION="${INSTALL_VERSION:-$(query_latest_version)}" \
    || die "no verified Framework version is available"
  INSTALL_VERSION="$(validate_version "$INSTALL_VERSION")"
  if [ "$INSTALL_FORCE" = 0 ] && [ "$current" = "$INSTALL_VERSION" ]; then
    say "Framework is already at $INSTALL_VERSION"
    exit 0
  fi
  download_archive "$INSTALL_VERSION"
fi

if [ -f "$FRAMEWORK_CONTROL" ]; then
  run_controller backup >/dev/null 2>&1 || die "current Framework failed health/backup preflight"
fi
INSTALL_MODE="upgrade"
prepare_and_deploy "$INSTALL_VERSION"
