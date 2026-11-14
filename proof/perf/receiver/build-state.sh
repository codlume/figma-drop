#!/bin/bash
# usage: RECEIVER_WORK=<work dir> build-state.sh <tree> <name>
# Builds the shipped receiver.cjs and the phase bundle of a tree into $RECEIVER_WORK/built/<name>.
set -euo pipefail
: "${RECEIVER_WORK:?set RECEIVER_WORK to the work directory}"
here=$(cd "$(dirname "$0")" && pwd)
tree="$1"
name="$2"
out="$RECEIVER_WORK/built/$name"
mkdir -p "$out"
(cd "$tree/apps/desktop" && pnpm exec vp pack >/dev/null 2>&1)
cp "$tree/apps/desktop/dist-electron/receiver.cjs" "$out/receiver.cjs"
node "$here/build-phase.mjs" "$tree" "$out" >/dev/null 2>&1
ls -la "$out" | grep cjs$
