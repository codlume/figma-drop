# CI dry run on PR #15

Run: https://github.com/codlume/figma-drop/actions/runs/42499388912. The workflow is **Release dry run**, on event `pull_request`, at head `08ac0976486cae055b2e06e03fbaaec5467fdd7b`, with conclusion `success`. It ran with the read-only `github.token` (`contents: read`, `pull-requests: read`) and no secrets. It uploaded no artifact.

## plan

The job ran `release-please@17.6.0 release-pr --dry-run --target-branch feat/release-workflow`. On `main`, the title would read `chore(main): release 0.1.0`. The changelog would then list the PR #15 squash commit, not this branch's own commits. The updaters for `package-lock.json`, `npm-shrinkwrap.json`, `samples/package.json`, and `changelog.json` change only files that exist, and none of those files exist here.

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
* **release:** keep AppleDouble entries out of the app zip and document the release window ([9dacfcd](https://github.com/codlume/figma-drop/commit/9dacfcd138b3c324e603e7af449482f4b9b438ca))
* **release:** split the release PR job and install the toolchain from the lockfile ([55b6448](https://github.com/codlume/figma-drop/commit/55b644827718f6f4be803a73b7a645e885dbbc5a))
* **release:** verify the packaged app can start and stage artifacts until complete ([7eadc9e](https://github.com/codlume/figma-drop/commit/7eadc9e5d6908f408c267ba8275af0ab9eb4a99c))

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
  package-lock.json:  [class PackageLockJson]
  npm-shrinkwrap.json:  [class PackageLockJson]
  samples/package.json:  [class SamplesPackageJson extends DefaultUpdater]
  CHANGELOG.md:  [class Changelog extends DefaultUpdater]
  package.json:  [class PackageJson extends DefaultUpdater]
  changelog.json:  [class ChangelogJson extends DefaultUpdater]
  apps/desktop/package.json:  [class GenericJson]
  apps/figma-plugin/package.json:  [class GenericJson]
  .release-please-manifest.json:  [class ReleasePleaseManifest extends DefaultUpdater]
```

The log also reports this line:

```text
❯ commit could not be parsed: 0a65acc463400b074f09b462b337657a588e868e feat(desktop): add the Electron menu-bar shell and shared contracts (#5)
```

The 0.1.0 changelog leaves out #5 until the merged PR #5 carries a `BEGIN_COMMIT_OVERRIDE` block, as `RELEASING.md` and `proof/release-review/owner-setup-checklist.md` describe.

## package

The job runs on `macos-15`. It installs Node from `.node-version`, runs `corepack enable`, and then runs `pnpm install --frozen-lockfile`, which logged `Lockfile is up to date, resolution step is skipped`. Then it runs `pnpm typecheck`, `pnpm test` (Test Files 1, 16, and 30 passed), and `pnpm test:release` (14 passed, 0 failed). It finishes with `pnpm release:dry-run` and a release-mode run that uploads nothing.

```text
Dry run of 0.0.0: this publishes nothing. The desktop zip is unsigned (ad-hoc signature, no Developer ID, not notarized).
  figma-drop-0.0.0-mac-arm64-unsigned-dry-run.zip  128414300 bytes  sha256 bcb7373781c150e95f407e9c2b51fb82a5b5a10f239b72311ce6d0013e3aa9b9  (16 checks passed)
  figma-drop-figma-plugin-0.0.0-dry-run.zip  11685 bytes  sha256 e8e383408a0f647aaade7cc8ef560e7b4a4c9d60f3439ba671860fe6aa137a00  (7 checks passed)
```

```text
Release v0.0.0: artifacts for GitHub release v0.0.0. The desktop zip is unsigned (ad-hoc signature, no Developer ID, not notarized).
  figma-drop-0.0.0-mac-arm64-unsigned.zip  128414300 bytes  sha256 bcb7373781c150e95f407e9c2b51fb82a5b5a10f239b72311ce6d0013e3aa9b9  (16 checks passed)
  figma-drop-figma-plugin-0.0.0.zip  11685 bytes  sha256 59de311e5256d40fd596dff8df5fbffd010e17884cca7ad64da1b0dfdee88fdd  (7 checks passed)
```

Zip entries carry file times, so the checksums differ between runs. The checks run on the extracted contents, not on the zip bytes.
