#!/bin/bash
# usage: RECEIVER_WORK=<work dir> verify-all.sh <round> <main tree> <base tree> <final tree>
# Runs proof/ingest/verify-receiver.mjs on origin/main, the branch base, and the final commit,
# one after another, and records the load around each run in $RECEIVER_WORK/verify-<label>-<round>.log.
# No git runs here.
set -uo pipefail
: "${RECEIVER_WORK:?set RECEIVER_WORK to the work directory}"
round="$1"
run() {
  local label="$1" tree="$2" log="$RECEIVER_WORK/verify-$1-$round.log"
  {
    echo "## $label $(date -u +%T) load before: $(cat /proc/loadavg)"
    local started=$SECONDS
    (cd "$tree" && ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a node proof/ingest/verify-receiver.mjs)
    echo "exit $? after $((SECONDS - started)) s, load after: $(cat /proc/loadavg)"
  } > "$log" 2>&1
  grep -E "^##|PASS|FAIL|ALL PASS|^exit" "$log"
}
run main "$2"
run base "$3"
run final "$4"
