# Renderer proof

`verify-renderer.mjs` drives the built Electron app against the real preload, library, and receiver. It posts synthetic exports over HTTP into a scratch library, on a free port.

The receiver must be in the build, so run this on a tree that has `src/library` and `src/ingest`.

```sh
pnpm build
node proof/renderer/verify-renderer.mjs
```

A default run leaves the machine alone: no clipboard write, no real Trash, no Finder, and no window capture. Those checks report UNVERIFIED.

`FIGMA_DROP_PROOF_OS_EFFECTS=1` runs them too. Each run then moves two synthetic scratch folders to the macOS Trash, and may ask for Screen Recording permission. The clipboard's text is put back afterwards; other clipboard content is lost.

`FIGMA_DROP_PROOF_SCRATCH` sets the scratch parent directory. `FIGMA_DROP_PROOF_FFMPEG` names an ffmpeg binary, which records `interaction.mp4`.

`5b-trace.txt` records why check 5b once failed, and what settled it.
