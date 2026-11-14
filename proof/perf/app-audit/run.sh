#!/bin/bash
# Runs one rig script under Xvfb.
# usage: ELECTRON=<electron binary> AUDIT_SCRATCH=<disposable dir with a short path> run.sh <script.mjs> <args...>
# The library path is part of every snapshot, so a long scratch path inflates the payload.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${ELECTRON:?set ELECTRON to the Electron binary}"
: "${AUDIT_SCRATCH:?set AUDIT_SCRATCH to a disposable directory}"
script=$1
shift
exec xvfb-run -a -s "-screen 0 1280x800x24" node "$here/$script" "$@"
