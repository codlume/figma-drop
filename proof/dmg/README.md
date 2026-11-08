# DMG proof

This folder shows the drag-to-install DMG that `scripts/release-package.mjs` builds. The screenshot and the evidence come from a local ad-hoc dry run, `pnpm release:dry-run`, on an Apple silicon Mac. Neither comes from a signed DMG.

| File                     | What it shows                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `finder-window.png`      | The Finder window of `figma-drop-<version>-mac-arm64-unsigned-dry-run.dmg`, mounted read-only. The app is on the left and the `Applications` link on the right, with an arrow between them and the hint "Drag figma-drop to Applications" below. No toolbar, sidebar, or status bar shows. The app icon is still Electron's default icon.  |
| `adhoc-dmg-evidence.txt` | The sanitized output of `bash scripts/dmg-evidence.sh` on the same dry-run DMG, version 0.1.1, whose SHA-256 `b5ae92c5...` matches `proof/release/local-proof.txt`. It shows `UDZO`, a valid `hdiutil verify`, a passing `codesign --verify --deep --strict` on the embedded app, the volume entries, and `Applications -> /Applications`. |
| `premerge-blocker.txt`   | Why the signed package test cannot run from a pull request branch. GitHub refuses to dispatch `package-macos.yml` before it exists on `main`, and the `release` environment accepts only `main`. It also lists the environment's secret names, never their values.                                                                         |

The signed DMG has the same layout, because `apps/desktop/dmg/layout.json` and the background in that folder set it in both signing modes. Only the signatures and tickets differ.

Some lines of `adhoc-dmg-evidence.txt` fail, as they do for every ad-hoc build:

- `codesign -dv` and `codesign --verify --strict` on the DMG report `code object is not signed at all`, because an ad-hoc DMG gets no signature.
- `xcrun stapler validate` exits 65 for the DMG and for the app, because neither has a ticket.
- `spctl -a -t open --context context:primary-signature` rejects the DMG with `source=no usable signature`, and `spctl -a -t exec` rejects the app. Both exit 3.
- The entitlements of the app and its helpers are empty, because only a Developer ID build gets `com.apple.security.cs.allow-jit`.

`RELEASING.md` lists what the same script shows for a notarized release DMG.
