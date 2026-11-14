# Desktop app performance audit: benchmark evidence

This audit covers the desktop app outside the receiver: main, the library, the renderer, the preload, and the IPC between them. It looked for work a user would feel in a large library. Three fixes came out of it. This file records what was measured, where, and what was left alone.

## Result

All figures come from the built app under Electron 44.4.5, on a library of 4,994 revisions in 300 projects. Each cell is the median of 5 runs per side with the range in brackets. Base and change runs alternated.

| What the user does                    | Measure                  | Base                      | Change                 |
| ------------------------------------- | ------------------------ | ------------------------- | ---------------------- |
| Exports 20 nodes of 1.6 MB, window up | Batch total              | 13,292 ms [12,948–14,152] | 2,147 ms [2,034–2,419] |
| Exports 20 nodes of 1.6 MB, window up | Reply per export, p50    | 698 ms [668–730]          | 109 ms [95.5–118]      |
| Exports 20 nodes of 1.6 MB, window up | Main-process CPU         | 19,760 ms [19,470–21,340] | 1,090 ms [1,050–1,210] |
| Switches back to the window           | Snapshot round trip, p50 | 801 ms [641–944]          | 399 ms [305–415]       |
| Switches back to the window           | Main-process CPU         | 1,168 ms [928–1,242]      | 528 ms [452–578]       |
| Reopens the window from the tray      | Until the library shows  | 1,121 ms [1,011–1,348]    | 563 ms [461–1,010]     |
| Launches the app                      | Until the library shows  | 2,888 ms [2,087–3,663]    | 2,464 ms [1,841–3,431] |

The launch row shows no measurable difference: the ranges overlap. An earlier comparison of the receipt change alone gave 2,623 ms [2,043–2,629] against 1,929 ms [1,829–2,041].

`raw/final2-typical.txt` and `raw/final2-roundtrip.txt` hold these runs.

## The three fixes

Each fix was measured alone, against the commit before it. The in-app comparisons in this section ran before a comment review reshaped the code without changing what it does. The module-level figures and the table above ran after.

### A committed export no longer rescans the library

With the window open, every committed export made the renderer fetch a snapshot, and every snapshot rescanned the library on the queue that commits wait on. The renderer now asks for a `memory` snapshot after `library:changed`, and for a `disk` snapshot on mount, focus, retry, and a stale command.

- 20 small exports: batch 5,451 ms [4,130–5,582] to 949 ms [716–1,105]. See `raw/f1-small.txt`.
- 20 exports of 1.6 MB: batch 14,068 ms [12,359–14,507] to 2,501 ms [2,149–3,044]. See `raw/f1-typical.txt`.
- **Limiter before.** Main spent 21,070 ms of CPU on a batch that the receiver handled in 1,580 ms. A profile of the scan put its limit on main's thread: `lstat` dispatch, garbage collection, `JSON.parse`, and `path.join`.
- **Limiter after.** A profile of main during a batch put the largest shares in the snapshot's date comparator, in IPC serialization, and in `path.join`. The next fix takes the first and the third.
- **One behavior change.** A change made in Finder used to show when the next export arrived. It now shows on the next window focus, which is the rule the app already documented. `verify-source.mjs` shows both sides of this in the built app: see `raw/verify-source-base.json` and `raw/verify-source-final2.json`.

### Shaping a snapshot parses each receipt time once

`toSnapshot` sorted with a comparator that called `Date.parse` twice per comparison, and joined every bundle path again.

- `toSnapshot` alone, Node 26.13: 52.2 ms [48.3–55.9] to 13.0 ms [12.7–14.0], median of 7 alternating rounds of 20 calls. The snapshot is byte-identical. See `raw/module-benchmarks.jsonl`.
- In the app, main-process CPU for 20 exports of 1.6 MB: 1,790 ms [1,690–2,170] to 1,230 ms [1,190–1,360]. The batch total moved from 2,753 ms [2,378–3,591] to 2,405 ms [2,078–2,567], which is inside the run-to-run range. See `raw/f4-typical.txt` and `raw/f4-small.txt`.
- **Limiter after.** The grouping and sorting passes themselves.

### A rescan reuses a receipt whose file has not changed

A disk snapshot stats, reads, and parses every receipt. The scan now remembers a parsed receipt with the identity of its file, and reads it again only when that identity changes.

- Snapshot round trip from the renderer: 676 ms [644–783] to 328 ms [300–368]. Main-process CPU per snapshot: 1,036 ms [992–1,162] to 468 ms [446–490]. See `raw/f3-roundtrip.txt`.
- Reopen from the tray: 988 ms [855–1,316] to 627 ms [491–729].
- `scanCatalog` alone, Node 26.13: 458.9 ms [401.6–641.7] to 272.4 ms [233.5–344.4], median of 11 alternating rounds of 5 scans. Both sides give the same catalog fingerprint.
- **Limiter after.** Two `lstat` calls for each revision, dispatched from main's thread. A profile put 23% of the scan in the native `lstat` binding.

## Measured and left alone

- **Idle CPU.** With the window closed, every process of the app together used 10 to 40 ms of CPU in 60 s, with 1.5 to 3.2 wakeups per second. A blank Electron window used 10 to 20 ms. With the window open, the first minute after launch used 260 to 330 ms, the second minute 20 to 30 ms, and the third 20 to 70 ms. A blank window that stays open used 20 to 70 ms. Main held no timer: `process.getActiveResourcesInfo()` listed only the pipe to the receiver. See `raw/idle-*.json`.
- **Commit latency.** `library.commit` for a new node took 8.6 ms in an empty library and 9 to 12 ms at 4,994 revisions. The commit waits on fsync and stat calls, which were 40% of the profile as idle time. No fix.
- **Snapshot transport.** A snapshot is 2.2 MB at 4,994 revisions, 442 bytes for each revision. Receiving one costs the renderer 54 ms of CPU, of which app and React code is about 5 ms. A prototype that sent the snapshot as one JSON string cut that to 13 ms and the round trip from 88.8 ms to 48.5 ms. See `raw/roundtrip-proto-1.json`. It changes what `window.figmaDrop.library.getSnapshot` returns, which the synthetic bridge and seven proof scripts read. Not done.
- **Two scans at launch.** Opening the library scans it, and the window asks for a disk snapshot about 300 ms later. The receipt memory makes the second scan the cheap one. Removing it needs a rule for when a scan is fresh enough for a new window. Not done.
- **Opening a large project.** A project of 240 nodes showed all 243 previews in 497 ms [471–552], with 590 ms of main CPU, because each preview is checked and read by main. The renderer held 197 MB. A history of 120 revisions took 269 to 298 ms. See `raw/select-f4-*.json`. Lazy loading would change what a user sees while scrolling. Not done.

## Correctness

- **Same snapshot and same window.** The base build and the final build give the same snapshot hash and the same hash of the window's text for the seeded library. After five exports, the memory snapshot equals a disk snapshot. See `raw/same-output-base.json` and `raw/same-output-final2.json`.
- **Integrated flow.** In the built app, an export shows in the right project at once, an outside change shows after focus, and both survive a restart. See `raw/verify-source-final2.json`.
- **No errors.** Every timed batch checked each reply for status 200, a path inside the library, and a `node.json` file. It also checked the revision count on disk and that the sidebar shows the whole batch. All runs finished with 0 errors.
- **Tests.** The desktop suite passes 1,000 of 1,002 on Linux. The two failures need macOS `lsof` and fail on the base commit too.

## Setup

- **Machine.** 6 cores, Linux, ext4, shared with other benchmark jobs. Load average ranged from 3.8 to 12.2 during the timed runs, so every comparison alternates sides. The last round-trip comparison ran under the heaviest load and has the widest ranges.
- **Build.** Production `pnpm build` output, run unpackaged from a copy of `package.json`, `dist`, and `dist-electron`, under Xvfb with `--no-sandbox`. No run was made on macOS.
- **Base.** Commit `fc42a4f`.
- **Library.** Synthetic, committed through the real library code by `seed.mjs`: 298 files of 7 nodes with 2 revisions each, one file of 240 nodes, one file whose first node has 120 revisions, and 200 unidentified exports. Every export has an 800 by 1,000 PNG preview of 70 KB. Receipt times spread over 180 days.
- **Clones.** Each run works on a hard-linked clone of the seed. Linking gives every file a fresh change time, so the rig waits 6 s before launch, past the 5 s the receipt memory waits before it trusts a file.
- **Payloads.** The 1.6 MB export is the `typical` profile of `../library-scan/payload.mjs`. No real export has been measured.

## Reproduce

Run these from the repository root. `AUDIT_SCRATCH` must be a disposable directory with a short path, because the library path is part of every snapshot.

```sh
pnpm install --frozen-lockfile
pnpm --filter @figma-drop/desktop build
# Copy apps/desktop/{package.json,dist,dist-electron} to <builds>/base and <builds>/change, one per side.
node proof/perf/app-audit/seed.mjs "$PWD" <seeds>/L5000 1
export ELECTRON=<path to the electron binary> AUDIT_SCRATCH=<short scratch dir>
audit=proof/perf/app-audit
# The batch, then the snapshot round trip with launch and reopen, alternating sides.
$audit/alt.sh batch.mjs <out>/batch 5 <seeds>/L5000 "20 typical" <builds>/base <builds>/change
$audit/alt.sh roundtrip.mjs <out>/roundtrip 5 <seeds>/L5000 "5" <builds>/base <builds>/change
node $audit/summarize.mjs <out>/batch
# Idle CPU of the app, and of a blank window for the floor.
$audit/run.sh idle.mjs <builds>/change <seeds>/L5000 <out>/idle.json 60
mkdir <seeds>/empty && $audit/run.sh idle-control.mjs $audit/control <seeds>/empty <out>/idle-control.json 60
# Same output, the integrated flow, and a large project.
$audit/run.sh same-output.mjs <builds>/change <seeds>/L5000 <out>/same-output.json
$audit/run.sh verify-source.mjs <builds>/change <seeds>/L5000 <out>/verify-source.json
$audit/run.sh select.mjs <builds>/change <seeds>/L5000 <out>/select.json
# Module level. <baseTree> is a checkout of the base commit with node_modules in place.
node $audit/shape.mjs <baseTree> "$PWD" <seeds>/L5000
node $audit/rescan.mjs <baseTree> "$PWD" <seeds>/L5000
AUDIT_SCRATCH=<short scratch dir> node $audit/commit.mjs <baseTree> "$PWD" <seeds>/L5000
```
