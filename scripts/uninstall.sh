#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: An explicit uninstall confirmation and optional purge request.
# [OUTPUT]: Framework runtime/controller removal while preserving user data by default.
# [POS]: Independent Framework removal entrypoint.
# [PROTOCOL]: Keep destructive boundaries explicit and synchronized with the storage contract.

set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=installer-lib.sh
source "$SCRIPT_DIR/installer-lib.sh"

YES=0
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --purge) PURGE=1 ;;
    --help)
      cat <<'EOF'
Usage: uninstall.sh --yes [--purge]

Default behavior removes the Framework runtime and controller but preserves
Framework configuration, credentials, Package data, models, and caches.
--purge additionally removes Framework configuration, credentials, and state.
Installed Packages, models, and caches are never removed by this command.
EOF
      exit 0
      ;;
    *) usage_error ;;
  esac
done
[ "$YES" = 1 ] || die "uninstall requires --yes"

if [ -f "$FRAMEWORK_CONTROL" ]; then run_controller stop >/dev/null 2>&1 || die "could not stop Framework"; fi
stamp="$(date +%Y%m%d-%H%M%S)-$$"
if [ -d "$FRAMEWORK_RUNTIME" ]; then
  mv "$FRAMEWORK_RUNTIME" "$(dirname "$FRAMEWORK_RUNTIME")/.framework-uninstalled-$stamp"
fi
if [ -f "$FRAMEWORK_CONTROL" ]; then
  mv "$FRAMEWORK_CONTROL" "$HOME/.framework-controller-uninstalled-$stamp"
fi
if [ "$PURGE" = 1 ]; then
  rm -rf "$FRAMEWORK_PERSIST" "$FRAMEWORK_AUTH_FILE" "$FRAMEWORK_INSTALL_STATE"
fi
say "Framework uninstalled; Packages, models, and caches were preserved"
