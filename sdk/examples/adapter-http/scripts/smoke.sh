#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
# [OUTPUT]: The exports or executable behavior implemented by this file.
# [POS]: sdk/examples/adapter-http/scripts/smoke.sh in termux-os-framework.
# [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

# Test only this Package and exit non-zero on any failure.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
fail=0
node --check "$HERE/package.mjs" && echo "PASS backend syntax" || { echo "FAIL backend syntax"; fail=1; }
node "$HERE/test/self-test.mjs" || fail=1
echo "smoke: $([ $fail -eq 0 ] && echo ALL PASS || echo FAILED)"
exit $fail
