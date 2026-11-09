#!/bin/zsh
# Alternates base and change runs of e2e.mjs so drift and warm-up favor neither side.
# usage: BENCH_SCRATCH=<dir> alternate.sh <baseAppDir> <changeAppDir> <seedsDir> <outDir> <rounds> <batch> <profile> <sizes...>
set -eu
here=${0:A:h}
base=$1 change=$2 seeds=$3 out=$4 rounds=$5 batch=$6 profile=$7
shift 7
mkdir -p "$out"
for size in "$@"; do
  for round in $(seq 1 "$rounds"); do
    for side in base change; do
      app=$base
      [[ $side == change ]] && app=$change
      echo "$(date +%T) L=$size r=$round v=$side load=$(sysctl -n vm.loadavg)" >> "$out/log.txt"
      node "$here/e2e.mjs" "$app" "$seeds/L$size" "$batch" "$profile" "$out/L$size-$side-$round.json" >> "$out/log.txt" 2>&1
    done
  done
done
echo done >> "$out/log.txt"
