#!/bin/bash
# Alternates builds over rounds of one rig script, so drift and warm-up favour no side.
# usage: alt.sh <script.mjs> <outDir> <rounds> <seedDir> "<extra args>" <buildDir>...
# Each build directory holds package.json, dist, and dist-electron of one side. Its last path
# segment names the side in the output files.
set -u
here=$(cd "$(dirname "$0")" && pwd)
script=$1 out=$2 rounds=$3 seed=$4 extra=$5
shift 5
mkdir -p "$out"
for round in $(seq 1 "$rounds"); do
  for build in "$@"; do
    name=$(basename "$build")
    echo "$(date +%T) round=$round build=$name load=$(cut -d' ' -f1-3 /proc/loadavg)" >> "$out/log.txt"
    # shellcheck disable=SC2086
    timeout 300 "$here/run.sh" "$script" "$build" "$seed" "$out/$name-$round.json" $extra >> "$out/log.txt" 2>&1
  done
done
echo done >> "$out/log.txt"
