# Viewer proof

`verify-viewer.mjs` drives the built Electron app against a scratch library on a free test port. It posts synthetic PNG exports to `/sync`, then measures the grid and drives the image viewer through the real preload, library, and receiver. It never touches `~/figma-drop` or port 3579.

## Run it

```sh
pnpm build
node proof/viewer/verify-viewer.mjs --mode=before
node proof/viewer/verify-viewer.mjs --mode=after
```

`--mode=before` measures the grid and the detail pane only. `--mode=after` is the default. It runs everything in before mode, then the viewer checks and the screencast.

Each line of `verify-viewer.txt` is `PASS` or `FAIL` with an id. The script exits nonzero on any `FAIL`. A failing check saves a screenshot to the system temp directory and names it in the log. Every viewer wait gives up after 4 seconds, so a build without the viewer fails fast instead of hanging.

On the base build, before mode fails `G3` on purpose. The tall mobile card paints at 35% of its card width, and that sliver is the defect this change fixes.

`FIGMA_DROP_PROOF_FFMPEG` names an ffmpeg binary. Without it, the script looks for `ffmpeg` on `PATH`, and with neither it skips `interaction.mp4` and logs it as UNVERIFIED. `FIGMA_DROP_PROOF_SCRATCH` sets the scratch parent directory.

## Fixtures

`frames.mjs` draws every PNG in code. Each frame has a coloured header on the top edge, numbered content rows, and a dark tab bar or coloured strips on the other edges. Crop and zoom show at a glance, and the edge checks sample those colours from screenshots.

All of them belong to one project, `Synthetic Viewer`:

- `Mobile Home` is 750x1624 (375x812 @2x), with two revisions. The latest has a blue header.
- `Long Page` is 750x4200.
- `Desktop Dashboard` is 2880x1800.
- `Wide Banner` is 1600x400.
- `Empty Frame` has no preview.

`page-helpers.mjs` is installed into the renderer as `window.proof`. It finds elements by role and accessible name, and it measures where an image actually paints, taking `object-fit` into account.

## Checks

- `G1`, `G2`, and `G3` check that the grid gains columns from 800x560 to 1600x1000, that every card image keeps its natural aspect ratio within 1%, and that the tall mobile card fills its preview width.
- `V1` opens the viewer from the detail-pane preview. It must open in Fit, with the whole image inside the stage and the stage inside the window.
- `V2` checks the contract's roles and names in Chrome's accessibility tree.
- `V3` checks that 100% renders the image at its natural CSS width and that the readout says 100%.
- `V4` checks that zoom in and zoom out move the readout and the image width in step.
- `V5`, `V6`, and `V7` scroll Mobile Home, Long Page, and Desktop Dashboard at 100%. Every edge must come into the stage, and a screenshot sample must show that edge's colour.
- `V8` drags to pan. The scroll position must move and the dialog must stay open.
- `V9` checks the `+`, `-`, `1`, and `0` keys.
- `V10`, `V11`, and `V12` close the viewer with Escape, with a backdrop click, and with five open and close cycles. Each close must leave zero open dialogs and return focus to "Open image viewer".
- `V14` presses 100% while already at 100%, scrolls away, then presses on the stage without moving. The scroll position must not jump back to where it was at the repeated press.
- `V13` resizes the window to 1600x1000 and 800x560 while in Fit. The image must stay inside the stage.
- `M1` and `M2` record the screencast flow and encode it.
- `Z1`, `Z2`, and `Z3` require no console errors or CSP violations, a clean quit, and an untouched real library and port.

## Files

`before/` and `after/` each hold `verify-viewer.txt` and `measurements.json`. The text file is the run log, with the per-card measurement table. The JSON file holds the raw grid measurements behind that table: column count, card width, image box, painted and visible size, and natural size.

- `grid-800x560-light.png`, `grid-1600x1000-light.png`, and `grid-1280x800-dark.png` show the grid at the window minimum, wide, and in dark mode, with Mobile Home selected.
- `after/viewer-fit-mobile.png` shows the viewer opened on Mobile Home in Fit.
- `after/viewer-100-mobile-mid.png` shows Mobile Home at 100%, scrolled halfway.
- `after/viewer-fit-wide.png` shows Desktop Dashboard in Fit.
- `after/viewer-1600x1000.png` and `after/viewer-800x560.png` show Fit after resizing the window.
- `after/interaction.mp4` records the flow. It opens the viewer from the detail pane, zooms in, switches to 100%, and drags down the tall frame. It then fits, closes with Escape, reopens, and closes with a backdrop click.
