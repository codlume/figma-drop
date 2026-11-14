#!/bin/bash
# usage: ELECTRON=<electron binary> RECEIVER_WORK=<work dir> campaign.sh <sideA> <sideB> <outfile>
# End-to-end /sync on $RECEIVER_WORK/built/<side>/receiver.cjs under Electron-as-Node, sides alternating.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
a="$1"; b="$2"; out="$3"
{
  echo "## $(date -u +%FT%TZ) $(nproc) cores, $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs), $(free -m | awk '/Mem:/{print $2" MB RAM, "$7" MB available"}'), swap used $(free -m | awk '/Swap:/{print $3" MB"}')"
  node "$here/alt.mjs" e2e 5 8 small "$a" "$b"
  node "$here/alt.mjs" e2e 5 8 typical "$a" "$b"
  node "$here/alt.mjs" e2e 4 8 typical-ascii "$a" "$b"
  node "$here/alt.mjs" e2e 3 6 images-2000 "$a" "$b"
  node "$here/alt.mjs" e2e 3 5 large "$a" "$b"
  node "$here/alt.mjs" e2e 2 4 cap-images "$a" "$b"
  node "$here/alt.mjs" e2e 2 3 budget-tree "$a" "$b"
  node "$here/alt.mjs" e2e 2 2 images-2.6M "$a" "$b"
  node "$here/alt.mjs" e2e 2 1 keys-node "$a" "$b"
  node "$here/alt.mjs" e2e 2 1 keys-top "$a" "$b"
} > "$out" 2>&1
