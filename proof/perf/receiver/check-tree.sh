#!/bin/bash
# usage: check-tree.sh <label> <tar of apps/desktop/src/ingest and packages/export-contract/src> <scratch tree> <log>
# Unpacks one commit's sources over a disposable worktree that has node_modules, then typechecks
# and runs the ingest and contract tests there, and appends one line to <log>. No git runs here.
set -uo pipefail
label="$1"
tarball="$2"
root="$3"
log="$4"
rm -rf "$root/apps/desktop/src/ingest" "$root/packages/export-contract/src"
tar -xf "$tarball" -C "$root"
status=ok
(cd "$root/apps/desktop" && pnpm exec tsc --noEmit) >/dev/null 2>&1 || status="TYPECHECK FAILED (desktop)"
(cd "$root/packages/export-contract" && pnpm exec tsc --noEmit) >/dev/null 2>&1 || status="TYPECHECK FAILED (contract)"
desktop=$(cd "$root/apps/desktop" && pnpm exec vp test run src/ingest 2>&1 | grep -E "^ +Tests " | tr -s ' ')
contract=$(cd "$root/packages/export-contract" && pnpm exec vp test run 2>&1 | grep -E "^ +Tests " | tr -s ' ')
echo "$label | $status | desktop ingest:$desktop | contract:$contract" | tee -a "$log"
