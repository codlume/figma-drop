# Figma plugin performance audit: benchmark evidence

This audit covers the plugin: the sandbox code that walks a selection and builds an export, and the UI code that encodes it and posts it to the receiver. It looked for time a user would feel between pressing Export and the receiver getting the body. This file records what each number in the plugin table of PR #33 means, which command produced it, and what the fake Figma cannot measure.

## Result

Each cell is the CPU time of one `exportNode` call on a document from `docs.mjs`, built on the repo's fake Figma. A cell is the median over separate processes per side, and each process reports the median of its own timed exports. Base and change processes alternated, and every range is disjoint.

| Document               | QuickJS base | QuickJS change | Node base | Node change |
| ---------------------- | ------------ | -------------- | --------- | ----------- |
| `screen`, 1,005 nodes  | 164 ms       | 93 ms          | 38.5 ms   | 27.4 ms     |
| `page`, 10,029 nodes   | 1,439 ms     | 776 ms         | 303 ms    | 233 ms      |
| `deep30`, 10,059 nodes | 1,709 ms     | 826 ms         | 392 ms    | 269 ms      |
| `cap`, 38,994 nodes    | 5,422 ms     | 2,912 ms       | 1,187 ms  | 895 ms      |

- **QuickJS.** `qjs/run.mjs` bundles the sandbox with esbuild and runs it in quickjs-emscripten 0.32.0. QuickJS is the engine Figma documents for plugin sandboxes, and this build of it has no JIT. 7 processes per side, each 1 warm-up and 3 timed exports. For `cap`, 5 processes with 2 timed exports. Asset bytes are 64 bytes each, because the sandbox never reads them and filling megabytes in an interpreter would time only the fixture. See `raw/final-qjs.txt`.
- **Node.** `bench.mjs --mode export` imports the TypeScript sources directly in Node 26.13. 7 processes per side, each 3 warm-up and 7 timed exports. See `raw/final-node.txt`.
- **CPU time.** Each export reads `process.cpuUsage()` before and after. Wall time is printed next to it. CPU time is the headline because wall time moved with the other jobs on the machine.
- **Same output.** Every comparison line ends with `payload IDENTICAL` and a hash of the export. Node hashes the POST body with SHA-256, and QuickJS hashes its export with FNV-1a.

The other figures in PR #33 come from these files:

- **The UI.** `raw/browser-final.txt` holds the Chromium runs of `encodeExport`, `JSON.stringify`, and the whole path from `structuredClone` to the POST answer. It was captured as `browser-final.json`, but it is plain text. A line that named a local screenshot was removed here and in `raw/results.txt`.
- **Each fix alone.** `raw/per-commit.txt` compares each commit with the one before it, in QuickJS, Node, and Chromium. It also lists the changes that were tried and not kept, and the alias-limit probes.
- **Byte identity.** `raw/identity-result.txt` shows that the POST body of the base and the change are byte-identical for all 18 documents, with `exportedAt` fixed, and that each export survives `structuredClone`.
- **All of it.** `raw/results.txt` joins the four files above under one header.

The SHAs in `raw/` are from before the stack was rebased. The plugin sources at each of them match the branch commit with the same subject. The final SHA `82a66bf` is `b8d16bc` on the branch.

## What the fake Figma cannot measure

The fake answers every API call from memory at once. These numbers time the plugin's own JavaScript and nothing that Figma does.

- **API latency.** Real calls to `getMainComponentAsync`, `getVariableByIdAsync`, `getStyleByIdAsync`, and `exportAsync` cross into Figma. `bench.mjs --doc page --mode counts` shows 5,412 `getMainComponentAsync` calls and 400 `getVariableByIdAsync` calls for one export of `page`. Their cost in Figma is unknown. A per-export cache and batched variable lookups depend on it and were not tried.
- **The real sandbox.** Figma's QuickJS build, stack limit, and memory limit may differ from quickjs-emscripten's. `qjs/run.mjs` removes the stack limit unless `--stack default` is passed. `qjs/alias-limit.mjs` keeps the default limit.
- **The real UI iframe.** Chromium 157 headless shell stands in for Figma's plugin iframe. Whether that iframe has `Uint8Array.prototype.toBase64` is unknown, so the change does not rely on it.
- **The real transport.** The POST goes to a same-origin sink that counts bytes, not to the receiver. Figma's `postMessage` between the sandbox and the UI is modelled with `structuredClone`.

## Setup

- **Machine.** 6 cores, 11 GB RAM, Linux, shared with other benchmark jobs. The load average ranged from 3 to 35 during the session, and was about 4 for the final Chromium runs. Every comparison alternates sides.
- **Base.** Commit `fc42a4f`.
- **Change.** Commit `b8d16bc`.
- **Engines.** Node 26.13.0, quickjs-emscripten 0.32.0 with esbuild 0.28.2, and Chromium 157.0.8103.38 headless shell.
- **Documents.** `docs.mjs` builds 20 deterministic documents from a seeded generator on the side's own copy of the fake Figma, so both sides get the same document. `identity.mjs` skips `deep3000` by default. `raw/identity-result.txt` covers 18 documents. A rerun with the default list also covers `tokencap`, 19 in all, and gives the same hash for each of the 18.

## Reproduce

Run these from the repository root. A side is the `apps/figma-plugin/src` directory of a tree. The base side needs only the plugin and the contract sources, plus a link that resolves `@figma-drop/export-contract`.

```sh
pnpm install --frozen-lockfile
pl=proof/perf/plugin
base=<snapshots>/base
mkdir -p "$base/apps/figma-plugin/node_modules/@figma-drop"
git archive fc42a4f apps/figma-plugin packages/export-contract | tar -x -C "$base"
ln -sfn ../../../../packages/export-contract "$base/apps/figma-plugin/node_modules/@figma-drop/export-contract"
src=apps/figma-plugin/src
# Node: the Node columns.
node $pl/ab.mjs --base "$base/$src" --work $src --docs screen,page,deep30,cap --rounds 7 --iters 7 --warmup 3
# QuickJS: the QuickJS columns. cap ran on its own with --rounds 5 --iters 2.
npm install --prefix $pl/qjs --no-package-lock
node $pl/ab.mjs --engine qjs --base "$base/$src" --work $src --docs screen,page,deep30 --rounds 7 --iters 3 --warmup 1
node $pl/ab.mjs --engine qjs --base "$base/$src" --work $src --docs cap --rounds 5 --iters 2 --warmup 1
# Byte identity of the POST body for every document.
node $pl/identity.mjs --base "$base/$src" --work $src --out <out>/bodies
# The alias limit, in Node and in QuickJS.
node $pl/alias-limit.mjs "$base/$src"
node $pl/qjs/alias-limit.mjs "$base/$src"
# Phase times, Figma API counts, and the body size by field.
node $pl/bench.mjs --src $src --doc page --mode phases
node $pl/bench.mjs --src $src --doc page --mode counts
node $pl/sizes.mjs $src screen page cap
# A profile of one side, and its summary.
node --cpu-prof --cpu-prof-dir=<out>/prof $pl/bench.mjs --src $src --doc page --mode export
node $pl/prof.mjs <out>/prof/<file>.cpuprofile 25
```

For the comparison of one commit with the one before it, unpack each commit into its own directory under `<snapshots>` the same way, and pass the two directories as `--base` and `--work`.

The UI runs in a browser. `serve.mjs` serves `page.mjs`, the sides under `<snapshots>` named in its `SNAPSHOTS` list, the working tree as `work`, and a `/sync` sink.

```sh
node $pl/serve.mjs <port> "$PWD" <snapshots>
```

Open `http://127.0.0.1:<port>/` in Chromium and wait for the page to say `ready`. Then call `window.bench` from the console or a browser driver. `bench.encode(['base', 'work'], 'page')` times `encodeExport` and `JSON.stringify`. `bench.ui(['base', 'work'], 'page')` times the whole path to the POST answer. `bench.b64(32, 5)` compares base64 encoders. A long call can run as a job with `start('page', () => bench.ui(['base', 'work'], 'page'))`, and its result shows in `jobs.page`. For the same encoder comparison in Node, run `node $pl/b64-micro.mjs 32 5`. `sink.mjs` is the same sink on its own, for `bench.mjs --mode ui --sink http://127.0.0.1:<port>`.
