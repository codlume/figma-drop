# figma-drop desktop

The macOS Electron app. It stays in the menu bar when its window closes and persists its receiver on/off setting. Exports are received only once the A-INGEST ticket lands. Until then the window and tray say so.

## Run

Run these from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm fmt:check
pnpm dev
```

`pnpm dev` uses a scratch library in `apps/desktop/.dev/`, port 13579, and the dev server on port 5791. Arguments after `--` go to Electron:

```sh
pnpm dev -- --remote-debugging-port=9222
```

Restart `pnpm dev` after you add `src/ingest/receiver-process.ts`, because the config reads the file list once. `pnpm install` does not download the Electron binary. The first `pnpm dev` does, or run `pnpm --filter @figma-drop/desktop exec install-electron`.

## Environment

An unpackaged build reads these variables. A packaged build ignores all of them, and uses `~/figma-drop` and port 3579.

| Variable               | Default                    | Purpose                                                               |
| ---------------------- | -------------------------- | --------------------------------------------------------------------- |
| `FIGMA_DROP_USER_DATA` | `<appData>/figma-drop-dev` | Electron user data, `settings.json`, and the single-instance lock     |
| `FIGMA_DROP_LIBRARY`   | `<userData>/library`       | Library root                                                          |
| `FIGMA_DROP_PORT`      | `13579`                    | Receiver port                                                         |
| `FIGMA_DROP_TEST`      | unset                      | `1` exposes `globalThis.figmaDropTest` in main, for the proof scripts |

`pnpm dev` sets the first three to its scratch values unless you set them. An unpackaged build touches the real library only when you name it:

```sh
FIGMA_DROP_LIBRARY="$HOME/figma-drop" FIGMA_DROP_PORT=3579 pnpm dev
```

## Local app

Run these from the repository root to build and open the app.

```sh
pnpm install --frozen-lockfile
pnpm app:local
open apps/desktop/release/figma-drop.app
```

`pnpm app:local` builds the workspace and writes `apps/desktop/release/figma-drop.app`, replacing any earlier build. Run it again to pick up a change. Quit a running copy first.

The first run uses the real library at `~/figma-drop` and port 3579, and keeps its settings in `~/Library/Application Support/figma-drop`. It ignores every variable in the table above.

The app is an Electron bundle with an ad-hoc signature, which lets it run locally on arm64. It has no signing identity and no notarization, so it is not for distribution. The executable must keep a name other than `Electron`, because Electron derives `app.isPackaged` from it. Under the old name the app reads as a development build.

## Ownership

Each ticket adds its own files. No ticket edits another's files, and none edits `src/main/integrations.ts`, which finds these seams at build time.

| Ticket    | Owns                                                                                                      | Contract                                                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-INGEST  | `src/ingest/**`                                                                                           | `receiver-controller.ts` exports `createReceiverController: CreateReceiverController`. `receiver-process.ts` is the `utilityProcess` entry. Land both together. |
| B-LIBRARY | `src/library/**`                                                                                          | `index.ts` exports `createLibrary: CreateLibrary`                                                                                                               |
| C-UI      | `src/renderer/App.tsx`, `src/renderer/style.css`, `src/renderer/test-setup.ts`, `src/renderer/synthetic/` | `App.tsx` exports `App` and imports its own `./style.css`                                                                                                       |
| D-PLUGIN  | `apps/figma-plugin/**`                                                                                    | `packages/export-contract`                                                                                                                                      |

The shell owns `src/main/**`, `src/preload/**`, `src/node/atomic-json.ts`, and `src/renderer/{index.html,main.tsx}`.

A controller is created only when the library is present, because it needs `ReceiverLibrary`.

## Proof

Build first. These scripts use scratch directories and a free port under the system temp dir, and they stop only the processes they started.

```sh
pnpm app:local
node proof/shell/verify-shell.mjs
node proof/shell/verify-copy-to-folder.mjs
node proof/shell/verify-chrome.mjs
node proof/shell/verify-bundle.mjs
```

| Script                      | Proves                                                                                                                                    | Does not prove                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `verify-shell.mjs`          | The window, tray, persistence, and quit lifecycle over CDP. It expects a receiver exactly when `src/ingest` exists.                       | The packaged app                                             |
| `verify-copy-to-folder.mjs` | Copy to folder through the real button and library, with the dialog answered from the inspector. An unstubbed run shows the call pending. | That a person can pick a folder in the native panel          |
| `verify-chrome.mjs`         | The window options, and the drag strip's computed style and geometry.                                                                     | A native window drag, or where the traffic lights really are |
| `verify-bundle.mjs`         | The bundle's metadata, signature, and `app.isPackaged`, using a probe entry point in a scratch copy.                                      | The bundle's own `main.cjs`, which it never launches         |

Never launch the bundle to test it with only `HOME` changed. On macOS `app.getPath('home')` ignores `HOME` and follows `CFFIXED_USER_HOME`, so the app would open the real `~/figma-drop`.
