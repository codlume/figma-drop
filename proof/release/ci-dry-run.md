# CI dry run on PR #15

Run: https://github.com/codlume/figma-drop/actions/runs/42493732736 (workflow **Release dry run**, event `pull_request`, head `ee77dc0`, conclusion `success`). It ran with the read-only `github.token` (`contents: read`, `pull-requests: read`) and no secrets.

## plan

The job ran `release-please@17.6.0 release-pr --dry-run --target-branch feat/release-workflow`. On `main` the title would read `chore(main): release 0.1.0`. The `build`, `ci`, `docs`, `test`, and `refactor` commits on this branch are hidden types, so they do not appear in the changelog. The updaters for `package-lock.json`, `npm-shrinkwrap.json`, `samples/package.json`, and `changelog.json` change only files that exist, and none do here.

```text
Would open 1 pull requests
fork: false
title: chore(feat/release-workflow): release 0.1.0
branch: release-please--branches--feat/release-workflow--components--figma-drop
draft: false
body: :robot: I have created a release *beep* *boop*
---


## 0.1.0 (2026-11-08)


### Features

* **desktop:** add the local unsigned app build and integrated proofs ([#11](https://github.com/codlume/figma-drop/issues/11)) ([a50c7f7](https://github.com/codlume/figma-drop/commit/a50c7f7784c79e9f5eaebbd58b229c1fca002836))
* **figma-plugin:** add the development plugin ([#8](https://github.com/codlume/figma-drop/issues/8)) ([5104e8e](https://github.com/codlume/figma-drop/commit/5104e8ee49249b01278edaca83d87074d1b85886))
* **ingest:** add the local export receiver ([#6](https://github.com/codlume/figma-drop/issues/6)) ([94a26ee](https://github.com/codlume/figma-drop/commit/94a26eed7fae0928a1ec6c019f70bfc2dd75385f))
* **library:** add the durable export library ([#4](https://github.com/codlume/figma-drop/issues/4)) ([df590ae](https://github.com/codlume/figma-drop/commit/df590ae3c6763ed8f444f5e69358be942c5fca9a))
* **renderer:** add the export library UI ([#9](https://github.com/codlume/figma-drop/issues/9)) ([be32028](https://github.com/codlume/figma-drop/commit/be320289ad9053e5ed6bdd54c2eda68cf18c846a))
* **renderer:** larger grid cards and a zoomable image viewer ([#13](https://github.com/codlume/figma-drop/issues/13)) ([f9f8209](https://github.com/codlume/figma-drop/commit/f9f8209b814c878063d11be080b915710c908b55))


### Bug Fixes

* **desktop:** report the switch position on a failed receiver status ([#7](https://github.com/codlume/figma-drop/issues/7)) ([34353da](https://github.com/codlume/figma-drop/commit/34353da57291edd9c3bea31d972bb18eccf43fdb))

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).
updates: 9
❯ Fetching package-lock.json from branch feat/release-workflow
⚠ file package-lock.json did not exist
❯ Fetching npm-shrinkwrap.json from branch feat/release-workflow
⚠ file npm-shrinkwrap.json did not exist
❯ Fetching samples/package.json from branch feat/release-workflow
⚠ file samples/package.json did not exist
❯ Fetching CHANGELOG.md from branch feat/release-workflow
❯ Fetching package.json from branch feat/release-workflow
✔ updating from 0.0.0 to 0.1.0
❯ Fetching changelog.json from branch feat/release-workflow
⚠ file changelog.json did not exist
❯ Fetching apps/desktop/package.json from branch feat/release-workflow
❯ Fetching apps/figma-plugin/package.json from branch feat/release-workflow
❯ Fetching .release-please-manifest.json from branch feat/release-workflow
```

## package

The job ran `pnpm typecheck`, `pnpm test`, `pnpm test:release`, and `pnpm release:dry-run` on `macos-15`. All of them passed. It uploaded no artifact.

```text
Dry run of 0.0.0: this publishes nothing. The desktop zip is unsigned (ad-hoc signature, no Developer ID, not notarized).
  figma-drop-0.0.0-mac-arm64-unsigned-dry-run.zip  128414300 bytes  sha256 f970bda72566fe54d7c5a414c35e0b868e387835621da4f688ee08774058dec1  (9 checks passed)
  figma-drop-figma-plugin-0.0.0-dry-run.zip  11685 bytes  sha256 53908b7365b8d250038318ff229efad8ce7906556dbf6397a64a8ff2558866ae  (6 checks passed)
Wrote <repo>/release-artifacts
```

The zip checksums differ from the local run, because zip entries carry file times. The artifacts are not byte-reproducible across builds, but their contents are checked.

The plan log also reports `commit could not be parsed: 0a65acc feat(desktop): add the Electron menu-bar shell and shared contracts (#5)`. That squash commit's body trips the Conventional Commit parser, so the 0.1.0 changelog leaves out #5. The commit is on `main` already, so the maintainer adds the line to the release PR body and `CHANGELOG.md` by hand, as `RELEASING.md` describes.
