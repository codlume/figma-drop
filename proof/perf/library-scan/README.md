# Library scan concurrency: benchmark evidence

Every library snapshot rescans the library on disk. The renderer asks for one after each committed export, on every window focus, and at launch. The scan sits on the same serial queue as commits, so while a batch arrives, each export waits behind a full rescan before it can commit and reply to the plugin.

Before this change, `scanCatalog` awaited every `readdir`, `lstat`, and receipt read one at a time. The change keeps the same reads but runs up to 32 at once, and records revisions in the original listing order.

## Result

On the end-to-end export path, the time per export now grows more slowly with library size.

| Library         | Exports    | Measure                 | Base median [range]       | Change median [range]  |
| --------------- | ---------- | ----------------------- | ------------------------- | ---------------------- |
| 5,000 revisions | 20 typical | Batch total             | 14,969 ms [14,927–16,012] | 3,601 ms [3,598–4,139] |
| 5,000 revisions | 20 typical | Reply per export, p50   | 783 ms [781–822]          | 186 ms [185–210]       |
| 5,000 revisions | 20 typical | Launch to library shown | 1,926 ms [1,817–2,811]    | 733 ms [716–779]       |
| 1,000 revisions | 20 typical | Reply per export, p50   | 174 ms [170–181]          | 56 ms [54–61]          |
| 1,000 revisions | 10 heavy   | Reply per export, p50   | 206 ms [190–214]          | 153 ms [147–390]       |
| empty           | 20 typical | Reply per export, p50   | 32 ms [30–34]             | 31 ms [31–32]          |

The table reports the median of 5 runs per side, with the run-to-run range in brackets. The runs alternated base and change.

- An empty library shows no measurable difference.
- Heavy exports gain less. The receiver parses the next export in its own process, which overlaps part of the scan.

## What limits the scan

These figures come from profiling runs that were not timed, at 5,000 revisions in Node 26.

- **Before.** The main thread was idle for about 64% of the profile. CPU time was 220 ms user and 283 ms system for a 450 ms scan. The scan waited on one thread-pool round trip at a time.
- **After.** The scan takes about 155 to 160 ms. Raising `UV_THREADPOOL_SIZE` from 4 to 8 makes it slower, about 175 ms, and raises system time from about 295 ms to about 440 ms. The kernel's file-metadata syscalls now limit the scan, not concurrency. `raw/scan.txt` holds these runs.

Inside the scan, shaping the snapshot (`toSnapshot`) costs about 21 ms at 5,000 revisions, and cloning it costs about 9 ms. The scan itself is about 95% of the snapshot.

Alternating microbenchmark of `scanCatalog` alone, 5 rounds per side, from `raw/scan.txt`:

| Library         | Base median [range] | Change median [range] |
| --------------- | ------------------- | --------------------- |
| 1,000 revisions | 96 ms [93–100]      | 34 ms [34–35]         |
| 5,000 revisions | 452 ms [449–471]    | 157 ms [156–169]      |

## Correctness

- **Same scan result.** `scanCatalog` gives byte-identical results on base and change, on both seeded libraries. The check is a fingerprint over every revision record, the directory maps, the blocked set, and the snapshot: `d40b727cbd92f03e` at 1,000 revisions and `d798e3ed46d908ed` at 5,000.
- **No errors.** Every timed run checked each `/sync` reply for status 200, a path inside the library, and a `node.json` file. It also checked that the revision count on disk equals the seeded count plus the batch, and that the renderer's snapshot holds every node from the batch. All 40 final runs completed with 0 errors: every export of every batch was committed, and none was left unfinished.
- **New tests.** `library.test.ts` adds two tests. One relaunches a library that has more revisions than one scan reads at once, and checks that the snapshot is unchanged. The other checks that when a copied directory claims an existing revision id, the first directory in listing order keeps it. The second test runs once with the copy listed after the original and once with it listed before. Reversing the insertion order fails both cases, and running one item per worker fails the first test.
- **Review.** Two independent reviews compared base and change scans on adversarial libraries. The libraries held duplicate ids at every level, refused and symlinked directories, bad receipts, more than 32 entries at each level, random fs delays, and injected `EIO`. Results matched base every time.

## Earlier test failure

One full `pnpm test` run failed an earlier version of the first new test, which committed 90 revisions. Its error text was not saved. Eight full workspace runs of that version, at load averages up to 10.8, did not reproduce it.

Inside the full suite, that version took 3,759–4,293 ms on base `disk.ts` and 4,151–4,468 ms on the change. Both are close to vitest's 5 s default timeout, and the time goes to 90 fsync'd commits, not to the scan. A timeout is the likely cause but is not confirmed.

The test now commits 45 revisions, which still passes the concurrency bound of 32, and sets an explicit 60 s timeout as the library's other fsync-heavy tests do. `raw/tests.txt` holds these runs and the final gates.

## Setup

- **Build.** Production `vp build && vp pack` output. Each side ran unpackaged from its own copy of `package.json`, `dist`, and `dist-electron`, under Electron 44.4.5 with a scratch library and a scratch port.
- **Revisions.** Base is `d127aea9a1e69fe2e615ca6e753c573e8562ca66`. Change is the commit that adds this file. The benchmarked change build was compiled from the working tree. Its `dist-electron/main.cjs` is byte-identical to a build of the final source.
- **Machine.** 8 cores, shared with other jobs. Load average ranged from 3.3 to 5.2 during the runs.
- **Libraries.** The seeded libraries are synthetic, committed through the real library code: about 40 nodes per project, 2 revisions per node, and 5% unidentified exports.
- **Payloads.** Deterministic synthetic payloads. A typical export is 1,500 nodes, a 300 KB PNG, a 60 KB SVG, and 4 images of 80 KB, about 1.6 MB of JSON. A heavy export is 12,000 nodes, a 2 MB PNG, a 400 KB SVG, and 12 images of 250 KB, about 12.5 MB. No real export has been measured.

## Reproduce

Run these from the repository root. Each command writes only under the directories you give it.

```sh
pnpm install --frozen-lockfile
# Build each side, then copy apps/desktop/{package.json,dist,dist-electron} to <baseApp> and <changeApp>.
pnpm --filter @figma-drop/desktop build
# Seed disposable libraries through the real library code.
for n in 0 1000 5000; do node proof/perf/library-scan/seed.mjs "$PWD" <seeds>/L$n $n; done
# Scan alone: fingerprint and timings. <sources> is a checkout of either side.
node proof/perf/library-scan/scan.mjs <sources> <seeds>/L5000 5
# End to end, alternating base and change.
BENCH_SCRATCH=<tmp> proof/perf/library-scan/alternate.sh <baseApp> <changeApp> <seeds> <out> 5 20 typical 5000 1000 0
BENCH_SCRATCH=<tmp> proof/perf/library-scan/alternate.sh <baseApp> <changeApp> <seeds> <out-heavy> 5 10 heavy 1000
node proof/perf/library-scan/summarize.mjs <out>
```

`e2e.mjs` launches the built app with a scratch library, user-data directory, and port, then stops only the process group it started. The scripts committed here differ from the ones that produced these numbers only in path handling and formatting. A one-round smoke run of the committed scripts completed with 0 errors.

## Raw files

| File                    | Contents                                                                  |
| ----------------------- | ------------------------------------------------------------------------- |
| `raw/e2e-typical.jsonl` | One line per typical-profile run, 30 runs, in run order                   |
| `raw/e2e-heavy.jsonl`   | One line per heavy-profile run, 10 runs, in run order                     |
| `raw/e2e-log.txt`       | Run order, load average before each run, and each run's summary line      |
| `raw/scan.txt`          | Alternating scan microbenchmark output and the thread-pool profiling runs |
| `raw/tests.txt`         | The failure reproduction, test durations, and final gate output           |

Every raw file is captured output. Local paths under the session scratch directory are replaced with `<scratch>`. `node proof/perf/library-scan/summarize.mjs proof/perf/library-scan/raw/e2e-typical.jsonl` reprints the end-to-end table.

## Limitations

- The runs used the unpackaged built app, not a signed DMG install.
- Library and payload sizes are guesses at real use.
- Runs on a cold disk cache were not separated out. The first scan after seeding was slower in microbenchmarks: 720 ms against 92 ms at 1,000 revisions.
