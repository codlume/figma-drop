# Electron entry bundle size: evidence

The review of PR #28 found that adopting Effect grew `dist-electron/main.cjs` from 64 KB to 357 KB. `receiver.cjs` grew to 370 KB. `electronEntry` in `apps/desktop/vite.config.ts` built the three Electron entries unminified. The change sets `minify: true` for them and keeps `sourcemap: true`.

## Result

Sizes are bytes on disk after `pnpm build`.

| File                   | Before    | After     | Before, gzip | After, gzip |
| ---------------------- | --------- | --------- | ------------ | ----------- |
| `main.cjs`             | 357,418   | 114,622   | 87,046       | 36,993      |
| `receiver.cjs`         | 369,870   | 106,363   | 90,570       | 34,725      |
| `preload.cjs`          | 2,056     | 1,234     | 712          | 537         |
| Renderer `index-*.js`  | 266,350   | 266,350   |              |             |
| Renderer `index-*.css` | 14,050    | 14,050    |              |             |
| Plugin `dist/code.js`  | 12,447    | 12,447    |              |             |
| `main.cjs.map`         | 2,359,250 | 2,343,645 |              |             |
| `receiver.cjs.map`     | 2,364,592 | 2,349,593 |              |             |

The renderer and the plugin are byte-identical before and after. Vite already minified them.

Of the 114,622 bytes that remain in `main.cjs`, 81,549 are Effect and 33,073 are the app. Before the change, the app's own code was 63,222 bytes.

## Where the bytes were

`breakdown.mjs` assigns every byte of a bundle to the source that its sourcemap names. `raw/breakdown-before.txt` and `raw/breakdown-after.txt` hold the full output.

- **Effect is most of each bundle.** Before the change, Effect was 294,196 bytes of `main.cjs` (82.3%) and 336,410 bytes of `receiver.cjs` (91.0%).
- **Schema is the largest part of Effect.** In `main.cjs` the top modules were `SchemaAST.js` at 56,943 bytes, `internal/effect.js` at 30,252, `Effect.js` at 17,570, `Schema.js` at 17,247, and `Duration.js` at 14,387.
- **No Effect module is bundled twice.** Each bundle takes Effect from one install and from its `dist` build only, and no module arrives by two paths.
- **Each process carries its own copy.** `main.cjs` and `receiver.cjs` are separate bundles for separate processes, and 279,182 bytes of Effect were in both. After the change, 77,052 bytes are.
- **Whole-package imports cost nothing.** Rewriting all 11 imports from `'effect'` to `'effect/<Module>'` changed each bundle by at most 6 bytes, minified or not. `raw/subpath-imports.txt` has the sizes. Tree-shaking already drops the re-exports that nothing uses.
- **The bundles were not minified.** Rolldown keeps JSDoc comments by default, and Effect ships long ones.

`variants.mjs` rebuilds the entries with one setting changed at a time. Its first and fifth rows reproduce `vp pack` before and after the change, byte for byte.

| Build                                                | `main.cjs` | `receiver.cjs` |
| ---------------------------------------------------- | ---------- | -------------- |
| As built before                                      | 357,418    | 369,870        |
| Comments stripped                                    | 225,013    | 207,423        |
| Whitespace removed and syntax compressed, names kept | 177,653    | 164,936        |
| Names mangled, function and class `name` kept        | 132,370    | 122,203        |
| `minify: true`, the change                           | 114,622    | 106,363        |
| `minify: true` and `propertyReadSideEffects: false`  | 101,159    | 100,846        |

Comments were 132,405 bytes of `main.cjs` (37%) and 162,447 bytes of `receiver.cjs` (44%).

## Options not taken

- **`treeshake.propertyReadSideEffects: false`** saves another 13,463 bytes in `main.cjs` and 5,517 in `receiver.cjs`. With it, `Duration.js`, `internal/dateTime.js`, and `BigDecimal.js` leave `main.cjs`, which is 9,085 bytes, and `SchemaAST.js` shrinks by 3,208. The option tells Rolldown that no property read has an effect, for every module in the bundle, and Rolldown cannot check that claim. It also moves property reads in the app's own code, for example in `src/ingest/bundle.ts`. The minifier, by contrast, must preserve behavior.
- **Keeping function and class names** costs 17,748 bytes in `main.cjs`. Two places in the bundled code read a class name, both in Effect's `Formatter`. No reply in `raw/receiver-e2e.json` changed when the names were mangled.
- **A chunk shared by `main.cjs` and `receiver.cjs`** would store the 77,052 common bytes once. Each process would still load and compile them, and the build would emit a third file.

## The sourcemaps are larger than the bundles

Each map is 2.3 MB, and 2.0 MB of it is the text of Effect's sources. `scripts/package-local.mjs` copies `dist-electron` whole, so both maps ship inside the app. This change does not touch that.

Do not turn on `--enable-source-maps` to use them at run time. Node parses the whole map when it loads the bundle, which adds 65 to 70 ms of CPU time per process. For `main.cjs`, 12.2 ms becomes 82.6 ms, and the load is slower in 100 of 100 rounds.

## Stack traces

Neither build maps a stack trace at run time, because Electron does not enable sourcemaps. A frame that read `main.cjs:11746:21` now reads `main.cjs:5:93161`, and function names in the trace are mangled. The map beside the bundle resolves both to `src/main/index.ts:33:13`. `raw/stack.txt` shows the four cases.

## Load time

Loading is slightly faster. The difference does not show in a launch.

| Bundle         | Before, CPU ms   | After, CPU ms    | Rounds where after is lower | Saving per round |
| -------------- | ---------------- | ---------------- | --------------------------- | ---------------- |
| `main.cjs`     | 15.8 [14.3–17.4] | 12.2 [11.2–13.8] | 92 of 100                   | 3.6 [2.2–4.7]    |
| `receiver.cjs` | 16.8 [15.2–19.2] | 13.4 [12.0–16.0] | 86 of 100                   | 3.4 [1.9–4.9]    |

Each cell is the median of 100 runs, with the 25th and 75th percentiles in brackets. `loadone.cjs` requires the bundle with `electron` stubbed and reports the CPU time of the process. `loadbench.mjs` runs every side in every round, so each round's difference is between runs made seconds apart. All 800 loads completed, and each receiver load registered its message listener.

Wall time moved the same way, with a wider spread: 18.2 ms [14.2–26.5] became 14.8 ms [10.6–19.9] for `main.cjs`. The machine was busy, so CPU time is the steadier measure. `raw/load.txt` has both.

- **Limiter.** One thread of V8. The fastest wall time is within 0.5 ms of the fastest CPU time. `phases.cjs` splits a load of `main.cjs` into its parts, and these are the fastest of 30 runs. Reading fell from 1.2 ms to 0.3 ms and compiling from 9.8 ms to 6.4 ms, while evaluating the module top level stayed at 8.4 ms and 8.3 ms. Minifying shortens the text that V8 scans. It does not shorten what Effect runs when it loads.
- **Share of a launch.** A launch of the built app takes about 600 ms from spawn until the receiver answers `GET /`. The median was 605 ms [416–888] before and 577 ms [496–933] after, over 15 alternating launches per side, which is no measurable difference.
- **Comments account for most of it.** Stripping comments alone saves 3.0 ms for `main.cjs`.

## Behavior on the built artifacts

The desktop tests run the sources, not the bundles, so these checks ran the built files.

- **The receiver as a child process.** `receiver-e2e.mjs` forks a built `receiver.cjs` behind `parent-port-shim.cjs` and sends 26 requests. They cover `/sync` with `Origin: null`, three fallback identities, hostile names, a bad Origin, a bad Host, a wrong content type, malformed bodies, `/open`, and `/pick-folder`. The script prints every reply, every staged export that the receiver sent to its parent, and a hash of each file of the first export. Three alternating rounds gave byte-identical output for the two builds. Each run answered 403 to the bad Origin, exited with code 0 on stop, and then refused connections. `raw/receiver-e2e.json` is that output.
- **The app under Electron.** `app-restart.mjs` launches the built app, sends five exports and one request with a bad Origin, quits, relaunches, and reads the renderer's snapshot each time. Both builds gave identical output: two projects by file key, one Unidentified entry, a repeat that added nothing, the same snapshot after the restart, no page errors, and exit code 0 on each quit. `raw/app-restart.json` is that output.
- **The existing receiver proof.** `proof/ingest/verify-receiver.mjs` passed its first 11 steps on each build and then failed on both. A second run of the minified build failed one step earlier. Both failing steps send very large bodies. See Limitations.
- **Tests.** The desktop suite passed 973 of 975 tests. The two failures need the macOS `lsof` and fail without this change too.

## Setup

- **Revisions.** Before is `1eb2d30`, the head of `refactor/adopt-effect`. After is the commit that changes `apps/desktop/vite.config.ts`.
- **Runtime.** Electron 44.4.5 for Linux x64, which carries Node 24.21.0 and V8 15.2. Load timings ran the Electron binary with `ELECTRON_RUN_AS_NODE=1`. The receiver child ran under Node 24.22.3.
- **Machine.** Linux, 6 cores, shared with other jobs. The load average was 11 to 13 during the load timings and the launches.
- **Data.** Every export is synthetic. Every run used a scratch library and a free port.

## Reproduce

Run these from the repository root. `<before>` and `<after>` are directories that each hold a copy of `apps/desktop/package.json`, `dist`, and `dist-electron` from one build.

```sh
pnpm install --frozen-lockfile
pnpm build
node proof/perf/bundle-size/breakdown.mjs apps/desktop/dist-electron/main.cjs \
	--shared-with apps/desktop/dist-electron/receiver.cjs
node proof/perf/bundle-size/variants.mjs <scratch>/variants

electron=apps/desktop/node_modules/electron/dist/electron
ELECTRON_RUN_AS_NODE=1 node proof/perf/bundle-size/loadbench.mjs 100 $electron <scratch>/samples.json \
	before=<before>/dist-electron after=<after>/dist-electron \
	after-source-maps=<after>/dist-electron=--enable-source-maps
ELECTRON_RUN_AS_NODE=1 $electron proof/perf/bundle-size/phases.cjs 30 \
	<before>/dist-electron/main.cjs <after>/dist-electron/main.cjs
ELECTRON_RUN_AS_NODE=1 $electron proof/perf/bundle-size/stackprobe.cjs <after>/dist-electron/main.cjs
node proof/perf/bundle-size/launchbench.mjs 15 $electron <scratch> before=<before> after=<after>

node proof/perf/bundle-size/receiver-e2e.mjs <after>/dist-electron/receiver.cjs <scratch> <port>
node proof/perf/bundle-size/app-restart.mjs <scratch>
```

`launchbench.mjs` and `app-restart.mjs` start Electron. On Linux without a display, run them under `xvfb-run -a` with `ELECTRON_DISABLE_SANDBOX=1`. `loadbench.mjs` reads `/proc/loadavg`, so it runs on Linux only.

## Raw files

| File                        | Contents                                                                 |
| --------------------------- | ------------------------------------------------------------------------ |
| `raw/breakdown-before.txt`  | `breakdown.mjs` on the three entries before the change                   |
| `raw/breakdown-after.txt`   | The same after the change                                                |
| `raw/variants.txt`          | `variants.mjs` output                                                    |
| `raw/subpath-imports.txt`   | `variants.mjs` output with the imports rewritten to subpaths             |
| `raw/load.txt`              | `loadbench.mjs` output, 100 rounds of four sides                         |
| `raw/load-samples.json`     | Every sample behind `raw/load.txt`                                       |
| `raw/phases.txt`            | `phases.cjs` output, 30 runs per bundle                                  |
| `raw/launch.txt`            | `launchbench.mjs` output                                                 |
| `raw/stack.txt`             | `stackprobe.cjs` on both builds, with and without `--enable-source-maps` |
| `raw/receiver-e2e.json`     | `receiver-e2e.mjs` output, the same bytes for both builds                |
| `raw/receiver-e2e-runs.txt` | Exit code and output hash of each of the six receiver runs               |
| `raw/app-restart.json`      | `app-restart.mjs` output, the same bytes for both builds                 |
| `raw/app-restart-runs.txt`  | Exit code and output hash of both app runs                               |
| `raw/verify-receiver.txt`   | Three runs of `proof/ingest/verify-receiver.mjs`                         |
| `raw/tests.txt`             | Desktop suite summary                                                    |

Every raw file is captured output, some under an added heading line. The `comments-stripped` side in `raw/load.txt` is the build of that name from `variants.mjs`.

## Limitations

- Nothing ran on macOS arm64, the target. Sizes do not depend on the platform. Timings do.
- The runs used the unpackaged built app, not a signed DMG install.
- `proof/ingest/verify-receiver.mjs` did not finish on this machine on either build. It stopped with `socket hang up` or `write EPIPE` in the steps that send the largest bodies, some over 200 MB, and the machine's swap was full at the time. Its last steps, which cover a restart, a quit during a stalled receive, and an occupied port, did not run. `app-restart.mjs` covers the restart. The cause of the failure is not confirmed.
- No test reads a stack trace from the minified bundle beyond the one frame in `raw/stack.txt`.
