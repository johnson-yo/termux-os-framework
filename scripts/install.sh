#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: A Framework Registry version or a local verified source archive.
# [OUTPUT]: A bootstrapped and optionally running Framework installation.
# [POS]: Independent first-install entrypoint; it does not require an existing Framework.
# [PROTOCOL]: Keep this entrypoint compatible with installer-lib.sh and the public install contract.

set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=installer-lib.sh
source "$SCRIPT_DIR/installer-lib.sh"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install the official Framework source archive through the Package Registry.

Options:
  --repository OWNER/REPOSITORY  GitHub source repository
  --registry URL                 Package Registry origin
  --version VERSION              Exact Registry version; omitted means latest
  --archive FILE                Use a previously downloaded source archive
  --sha256 HASH                 Expected SHA-256 for --archive
  --no-start                    Install without starting Framework
  --force                       Replace an existing runtime (upgrade is preferred)
EOF
}

if parse_common_args "$@"; then :; else usage; exit 0; fi
require_tools
[ "$INSTALL_FORCE" = 1 ] || [ ! -e "$FRAMEWORK_RUNTIME" ] \
  || die "Framework already exists; use upgrade.sh"

if [ -n "$INSTALL_ARCHIVE" ]; then
  [ -f "$INSTALL_ARCHIVE" ] || die "archive does not exist: $INSTALL_ARCHIVE"
  [ -n "$INSTALL_VERSION" ] || die "--version is required with --archive"
  INSTALL_VERSION="$(validate_version "$INSTALL_VERSION")"
else
  INSTALL_VERSION="${INSTALL_VERSION:-$(query_latest_version)}" \
    || die "no verified Framework version is available"
  INSTALL_VERSION="$(validate_version "$INSTALL_VERSION")"
  download_archive "$INSTALL_VERSION"
fi

INSTALL_MODE="install"
prepare_and_deploy "$INSTALL_VERSION"
