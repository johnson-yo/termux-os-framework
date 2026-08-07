#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Framework Core source and the standard local development tools documented in README.md.
# [OUTPUT]: One fail-fast local verification run covering syntax, contracts, SDK, security, and independence.
# [POS]: scripts/test-core.sh in termux-os-framework.
# [PROTOCOL]: Keep this list small, deterministic, local, and free of product or device dependencies.

set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

echo "== syntax =="
while IFS= read -r file; do node --check "$file" >/dev/null; done < <(find . -type f \( -name '*.mjs' -o -name '*.js' \) -not -path './dist/*' -not -path './tmp/*' -not -path './node_modules/*' -not -path './.git/*')
while IFS= read -r file; do bash -n "$file"; done < <(find . -type f -name '*.sh' -not -path './dist/*' -not -path './tmp/*' -not -path './node_modules/*' -not -path './.git/*')
python3 -m py_compile scripts/reproducible-archive.py

echo "== Core module self-tests =="
for file in \
  src/packages/version.mjs \
  src/packages/manifest.mjs \
  src/packages/dependencies.mjs \
  src/packages/git-state.mjs \
  src/packages/dependency-runtime.mjs \
  src/packages/runtime-contract.mjs \
  src/packages/loader.mjs \
  src/assets/fetch.mjs \
  src/assets/registry.mjs \
  src/assets/runtime.mjs \
  src/assets/resolver.mjs \
  src/capabilities/resolver.mjs \
  src/apps/session.mjs \
  src/stage/manager.mjs \
  src/system/auth.mjs \
  src/system/access.mjs \
  src/system/package-settings.mjs \
  src/system/package-control.mjs \
  src/system/package-registry.mjs \
  src/system/config-migrate.mjs \
  src/system/setup-state.mjs \
  src/system/node-runtime.mjs \
  src/system/sdk-guide.mjs \
  src/system/menu.mjs \
  src/system/observation.mjs \
  src/theatre/runtime.mjs; do
  node "$file" --self-test
done

echo "== isolated integration smokes =="
for script in \
  scripts/smoke-core-independence.sh \
  scripts/smoke-package-runtime.sh \
  scripts/smoke-package-assets.sh \
  scripts/smoke-sdk.sh \
  scripts/smoke-sdk-dev-runtime.sh \
  scripts/smoke-user-access.sh \
  scripts/smoke-admin-shell.sh \
  scripts/smoke-package-control.sh \
  scripts/smoke-framework-update.sh \
  scripts/smoke-framework-update-web.sh \
  scripts/smoke-framework-installer.sh; do
  bash "$script"
done

node scripts/extract-ui-strings.mjs --check
node scripts/check-publication.mjs
echo "PASS Framework Core test suite"
