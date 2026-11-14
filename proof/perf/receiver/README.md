# Receiver performance audit: benchmark evidence

This audit covers the receiver: reading a `/sync` body, checking it, hashing it, building the bundle, and staging its files. It looked for time and memory a user would feel when the plugin sends an export. This file records what each number in the receiver table of PR #33 means, which command produced it, and what the rig cannot see.

## Result

All figures come from the built `receiver.cjs` run as a child of Electron 44.4.5 with `ELECTRON_RUN_AS_NODE=1` (Node 24.21, V8 15.2). Each cell is the median `/sync` time after warm-up, with the range in brackets. Base and change runs alternated.

| Body                                              | Runs × posts | Base                     | Change                  |
| ------------------------------------------------- | ------------ | ------------------------ | ----------------------- |
| `typical`, 2.7 MB, 2,000 nodes, 5 images          | 5 × 7        | 206.1 ms [156.4–397.9]   | 104.1 ms [77.6–180.7]   |
| `images-2000`, 2,000 small images, 8.1 MB         | 3 × 5        | 886.5 ms [535.1–1,240.6] | 357.6 ms [240.2–1,419]  |
| `large`, 42.4 MB, 20,000 nodes                    | 3 × 4        | 1,833 ms [1,569–3,508]   | 1,116 ms [1,025–1,248]  |
| `cap-images`, 265.1 MB of images, at the body cap | 2 × 3        | 5,131 ms [4,375–5,642]   | 4,217 ms [3,629–5,015]  |
| `budget-tree`, 90.7 MB, 150,000 nodes             | 2 × 2        | 9,959 ms [7,968–11,055]  | 4,673 ms [4,013–5,062]  |
| `keys-top`, 7.9M top-level keys, 101.6 MB         | 2 × 1        | 51,842 ms, and one 503   | 16,786 ms and 26,054 ms |

Sizes are in units of 10^6 bytes. PR #33 gives the three largest in MiB: 253, 86.5, and 97. `raw/campaign-1.txt` holds these runs, with the read, prepare, find, stage, and commit-reply split of each.

- **Total.** The time from the start of the request to the last byte of the reply, measured in the parent. The posts of each run go to one fresh receiver process. When a run has more than one post, its first post is dropped as warm-up.
- **Peak RSS.** `VmHWM` of the receiver process, reset before every post through `/proc/<pid>/clear_refs`. For `budget-tree` it fell from 2,845 MB to 1,111 MB. For `typical` the campaign gives 254 MB [253–256] against 178 MB [171–181]. The 219 MB to 172 MB in PR #33 comes from three later base runs and three final runs that sit only in the uncommitted `results.jsonl`.
- **The 503.** One base post of `keys-top` replied 503, `figma-drop did not finish in time`, after 78.3 s. The change answered both posts with 200.
- **Same output.** Every body gave the same content hash, file count, byte count, and SHA-256 of every staged file on both sides. The `identity` line of each block in `raw/campaign-1.txt` shows it. `images-2.6M` is refused with 413 on both sides, as it should be.

The PR's per-fix figures came from two other modes of the same rig, whose raw rows are not committed:

- **Phase breakdown.** `alt.mjs phase` runs `phase.cjs`, which times each step of `prepareExport` on its own and then `stageExport`: the value budget, `toString`, `JSON.parse`, the schema check, the hash, and the bundle build. The bundle build of 51.5 to 25.8 ms, staging of 30.3 to 14.2 ms, and the 2,003-file staging of 409 to 108 ms come from it.
- **Paired steps.** `pair.cjs` runs one step from two builds back to back in one process, A then B, and flips the order every pair. The hash figure of 31.9 to 24.4 ms, faster in 59 of 60 pairs, and the value-count figures come from it.

## What the rig cannot see

- **Main.** `e2e.mjs` stands in for main. `findExport` always misses, and a commit is one rename into a scratch library. The real library, its queue, and its receipts are not in these numbers. `../app-audit/` measures those.
- **The real child.** The receiver runs under `child_process.fork` with `shim.cjs` standing in for `parentPort`, not as an Electron `utilityProcess`. `proof/ingest/verify-receiver.mjs` covers the real one.
- **macOS.** Every run was on Linux ext4. Staging eight files at a time was measured only there. Nothing was measured on APFS or on Apple silicon.
- **Real exports.** Every body is synthetic. No real Figma export was measured.

## Correctness

- **verify-receiver.** `verify-all.sh` runs `proof/ingest/verify-receiver.mjs` on `origin/main`, on the base, and on the final commit, twice each. `main` and the base fail at step 12 with `socket hang up`. The final commit passes steps 1 to 14 and fails step 15, which needs macOS `lsof`. See `raw/verify-*.txt`.
- **Per commit.** `check-tree.sh` typechecks each commit of the receiver stack and runs the ingest and contract tests. Every commit typechecks. The 2 ingest failures on every line, the base included, are the macOS `lsof` cases. See `raw/per-commit.txt`. Its SHAs are from before the stack was rebased. The subjects match the commits on the branch.

## Setup

- **Machine.** 6 cores of an Intel Haswell VM, 11.7 GB RAM, Linux, ext4, with 1.2 GB of swap in use at the start. The machine was shared with other benchmark jobs. The load average ranged from 5 to 11 during the campaign, so every comparison alternates sides.
- **Base.** Commit `fc42a4f`, the commit before the receiver fixes.
- **Change.** The campaign's `head` build holds every receiver fix. It was built before `8a49790` changed one function signature, and its `receiver.cjs` differs from the branch tip by 11 bytes. The branch tip builds a `receiver.cjs` and a phase bundle that are byte-identical to the `final` build of the verify and phase runs.
- **Bodies.** `gen.mjs` writes every body from a fixed seed, so a rerun gives byte-identical files. `ascii.mjs` writes `typical-ascii`, the same body with every non-ASCII character replaced.

## Reproduce

Run these from the repository root. `RECEIVER_WORK` is a disposable directory. The rig reads bodies from `$RECEIVER_WORK/bodies` and builds from `$RECEIVER_WORK/built/<side>`, and it appends every run to `$RECEIVER_WORK/results.jsonl`.

```sh
pnpm install --frozen-lockfile
export RECEIVER_WORK=<disposable dir>
export ELECTRON=$PWD/node_modules/.pnpm/electron@44.4.5/node_modules/electron/dist/electron
rx=proof/perf/receiver
git worktree add --detach <trees>/base fc42a4f
pnpm -C <trees>/base install --frozen-lockfile
# Builds: the shipped receiver.cjs and a phase bundle of the ingest internals per side.
$rx/build-state.sh <trees>/base base
$rx/build-state.sh "$PWD" final
# Bodies.
node $rx/gen.mjs "$RECEIVER_WORK/bodies"
node $rx/ascii.mjs "$RECEIVER_WORK/bodies/typical.json" "$RECEIVER_WORK/bodies/typical-ascii.json"
# The table: end-to-end /sync over loopback for every body, sides alternating.
$rx/campaign.sh base final <out>/campaign.txt
# Phase breakdown: rounds, then posts per round.
node $rx/alt.mjs phase 5 6 typical base final
# One step, paired in one process: digest, budget, prepare, or bundle.
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" $rx/pair.cjs digest "$RECEIVER_WORK/bodies/typical.json" 60 \
  "$RECEIVER_WORK/built/base/phase.cjs" "$RECEIVER_WORK/built/final/phase.cjs"
# A CPU profile of the receiver child, and its summary.
node $rx/e2e.mjs "$ELECTRON" "$RECEIVER_WORK/built/final/receiver.cjs" "$RECEIVER_WORK/bodies/large.json" 3 <out>/prof
node $rx/profsum.mjs <out>/prof/<file>.cpuprofile 25
```

`verify-all.sh` needs three trees, each with `pnpm install` and `pnpm --filter @figma-drop/desktop build` done, and Xvfb. `check-tree.sh` unpacks one commit's sources over a disposable tree that has `node_modules`.

```sh
git worktree add --detach <trees>/main origin/main
$rx/verify-all.sh 1 <trees>/main <trees>/base "$PWD"
git archive <sha> apps/desktop/src/ingest packages/export-contract/src > <out>/<sha>.tar
$rx/check-tree.sh <n>-<sha> <out>/<sha>.tar <trees>/base <out>/per-commit.log
```
