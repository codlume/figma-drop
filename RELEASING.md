# Releasing figma-drop

A release is one version of the whole repository, tagged `v<version>`. release-please keeps a standing release pull request on `main`. When a maintainer merges it, the release workflow tags the commit, creates a GitHub release, builds both artifacts on macOS, and attaches them to that release. Nothing goes anywhere else.

## What a release contains

The release PR bumps one version in four files. These are the root `package.json`, `apps/desktop/package.json`, `apps/figma-plugin/package.json`, and `.release-please-manifest.json`. `release-please-config.json` lists the two app files as `extra-files`, and `pnpm test:release` fails if an app is missing from that list or the versions disagree. The PR also adds the new section of `CHANGELOG.md`.

The GitHub release for `v<version>` carries three assets.

| Asset                                   | Contents                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `figma-drop-<version>-mac-arm64.zip`    | `figma-drop.app` for Apple silicon. It is signed with a Developer ID under the hardened runtime, notarized by Apple, and stapled. |
| `figma-drop-figma-plugin-<version>.zip` | The plugin's `manifest.json` and its built `dist/` files, for import into the Figma desktop app.                                  |
| `SHA256SUMS.txt`                        | The SHA-256 of both zips.                                                                                                         |

The release workflow also appends an install notice to the release notes. It names both zips and says how to install each.

## Signing modes

`scripts/package-local.mjs` builds the app in one of two signing modes. No mode in between exists, so a build that is signed but not notarized cannot be made.

| Mode           | When                                         | What the app gets                                                                                                                                                            | Desktop zip name                              |
| -------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `ad-hoc`       | `FIGMA_DROP_SIGN_IDENTITY` is not set        | An ad-hoc signature. Gatekeeper blocks it on another Mac.                                                                                                                    | `figma-drop-<version>-mac-arm64-unsigned.zip` |
| `developer-id` | `FIGMA_DROP_SIGN_IDENTITY` names an identity | A Developer ID signature with the hardened runtime, a secure timestamp, and `apps/desktop/entitlements.mac.plist`. Apple notarizes it, and the ticket is stapled to the app. | `figma-drop-<version>-mac-arm64.zip`          |

The `developer-id` mode also needs `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for `xcrun notarytool`, and the identity in an unlocked keychain. It stops before it signs anything and names each variable that is missing. If Apple rejects the app, it prints the `notarytool log` and fails.

`scripts/release-package.mjs` reads the mode from the built app with `codesign`, `xcrun stapler validate`, and `spctl`. It fails on an app that matches neither mode. A release, `--tag`, accepts only `developer-id`. A dry run accepts both.

## Prerequisites

- Turn on **Allow GitHub Actions to create and approve pull requests** in **Settings > Actions > General > Workflow permissions**. Without it, release-please cannot open the release PR. To read the setting, run `gh api repos/codlume/figma-drop/actions/permissions/workflow`. It reports the setting as `can_approve_pull_request_reviews`.
- The workflows declare their own token permissions in YAML, so the repository's default token permission does not matter.
- The GitHub environment `release` holds the signing and notarization secrets, and only `main` may deploy to it. The `build` job of the release workflow is the only job that uses it. The **Release dry run** workflow uses no secrets.

  | Secret                         | Holds                                                                            |
  | ------------------------------ | -------------------------------------------------------------------------------- |
  | `MACOS_CERTIFICATE_P12_BASE64` | The Developer ID Application certificate and its private key, as a base64 `.p12` |
  | `MACOS_CERTIFICATE_PASSWORD`   | The password of that `.p12`                                                      |
  | `APPLE_ID`                     | The Apple ID that submits the app to the notary service                          |
  | `APPLE_APP_SPECIFIC_PASSWORD`  | An app-specific password for that Apple ID                                       |
  | `APPLE_TEAM_ID`                | The team ID of the Developer ID certificate                                      |

  A maintainer replaces the certificate before it expires, and the app-specific password if Apple revokes it. Agents never read, set, or rotate these secrets.

A push or tag that `github.token` creates starts no workflow. So the tag starts no workflow, and the release workflow builds the assets in the same run that creates the tag. A pull request that `github.token` opens gets `pull_request` runs that wait for approval. The **Release dry run** on the release PR waits that way. A maintainer may approve it. Its token is read-only, so approving is safe, and its `package` job packages the bumped version.

release-please marks the open release PR with the `autorelease: pending` label and the released one with `autorelease: tagged`. It releases only a merged PR that carries `autorelease: pending`. Labels go through the issues API, so the `release-please` and `release-pr` jobs hold `issues: write`. The repository has neither label yet. GitHub creates a missing label when a token with `issues: write` adds it, so the first run should create both. If the first `release-pr` run fails on a label, a maintainer creates both with `gh label create "autorelease: pending"` and `gh label create "autorelease: tagged"` and reruns the failed job.

These are not available:

- Figma Community publishing. It needs a Figma-assigned plugin id and Figma's own publish flow. `apps/figma-plugin/manifest.json` uses the local id `figma-drop-local`.
- Auto-update. It needs a hosted update feed.

## Cut a release

1. Merge pull requests with Conventional Commit titles into `main`. Each merge updates the standing release PR, titled `chore(main): release <version>`.
2. Review the release PR. Check the version in its title, the new `CHANGELOG.md` section, the version in the three `package.json` files, and `.release-please-manifest.json`.

   release-please leaves out a commit whose message it cannot parse, and the release run log names it. To add it back, edit the description of the merged pull request that made that commit. Add a block that holds the message release-please should read instead. For example, for #5:

   ```text
   BEGIN_COMMIT_OVERRIDE
   feat(desktop): add the Electron menu-bar shell and shared contracts (#5)
   END_COMMIT_OVERRIDE
   ```

   The next **Release** run on `main` rebuilds the release PR with that message. As a fallback, edit the release PR body, which becomes the GitHub release notes, and `CHANGELOG.md` on its branch. Keep `## <version>` as the first heading of the body and keep both `---` lines, because release-please reads the notes between them. Do this just before you merge, because release-please rewrites the PR on every push to `main`.

3. Merge the release PR only after the latest **Release** run on `main` has finished. A run still in progress can rewrite the release PR after you review it.
4. Watch the **Release** run for that merge in the **Actions** tab. Its jobs run in this order:
   1. `release-please` creates the tag `v<version>` and the GitHub release with the changelog section as its notes.
   2. `release-pr` opens the next release PR. It runs apart from the other jobs, and nothing waits for it, so its failure cannot block the build.
   3. `build` runs on `macos-15` in the `release` environment, with a read-only token. It checks out the tagged commit. It installs Node from `.node-version`, pnpm from `packageManager` through corepack, and the dependencies with `pnpm install --frozen-lockfile`, so the whole toolchain comes from the lockfile. It runs `pnpm typecheck`, `pnpm test`, `pnpm test:release`, and `pnpm build`, and no secret is in reach of those steps. Then it imports the certificate into a throwaway keychain in `$RUNNER_TEMP` and deletes the `.p12` file. It runs `node scripts/package-local.mjs` in `developer-id` mode, which signs, notarizes, and staples the app. Then `node scripts/release-package.mjs --tag v<version>` writes and checks the zips and `SHA256SUMS.txt`. A last step deletes the keychain, also when an earlier step fails. The job stores the files as the workflow artifact `release-v<version>` for 7 days.
   4. `upload` downloads that artifact and runs `sha256sum -c SHA256SUMS.txt`. It fails if the artifact holds any file that `SHA256SUMS.txt` does not list. Then it attaches every file to the release with `gh release upload --clobber`, and appends the install notice to the release notes, unless a line of the notes is exactly `<!-- figma-drop-install-notice -->`.

   `release-please`, `release-pr`, and `upload` run no repository code, and they are the only jobs with write access. The release is public from the first job, and its assets attach a few minutes later, when `upload` finishes.

5. Download the assets and check them.

   ```sh
   gh release download v<version> -R codlume/figma-drop -D figma-drop-v<version>
   cd figma-drop-v<version>
   shasum -a 256 -c --ignore-missing SHA256SUMS.txt
   ```

   `shasum` prints `OK` for each zip it finds. `--ignore-missing` skips a zip you did not download. You can also download the assets from the release page at `https://github.com/codlume/figma-drop/releases`.

## Install the release

To install the app:

1. Quit any running copy of figma-drop.
2. Unzip `figma-drop-<version>-mac-arm64.zip`, and move `figma-drop.app` to `~/Applications` or `/Applications`.
3. Open the app. Apple notarized it, so macOS opens it after one confirmation. It uses the library at `~/figma-drop` and port 3579.

To install the plugin:

1. Unzip `figma-drop-figma-plugin-<version>.zip` into a folder you keep. Figma loads a development plugin from that folder each time it runs.
2. In the Figma desktop app, select **Plugins > Development > Import plugin from manifest**.
3. Select `manifest.json` in the unzipped folder.

The browser version of Figma cannot import a development plugin.

## Run a dry run

To build both artifacts locally without publishing anything, run this on an Apple silicon Mac:

```sh
pnpm install --frozen-lockfile
pnpm release:dry-run
```

It needs no token. It builds `apps/desktop/release/figma-drop.app` in `ad-hoc` mode and writes these files to `release-artifacts/`:

- `figma-drop-<version>-mac-arm64-unsigned-dry-run.zip`
- `figma-drop-figma-plugin-<version>-dry-run.zip`
- `SHA256SUMS-dry-run.txt`
- `release-plan.json`, which names the signing mode

`<version>` is the current version in `package.json`, not the next one.

To dry-run the `developer-id` mode, first set `FIGMA_DROP_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`, with the identity in your login keychain. `security find-identity -v -p codesigning` lists the identity names. The run then submits the app to Apple's notary service, and the desktop zip is `figma-drop-<version>-mac-arm64-dry-run.zip`.

The **Release dry run** workflow runs on every pull request and on manual dispatch, with a read-only token and no secrets. It has two jobs:

- `plan` runs `release-please release-pr --dry-run` against the branch. Its job summary shows the release PR that release-please would open if that branch were `main`. The plan lists each commit on the branch. `main` gets one squash commit per pull request, so the real release PR lists that commit instead. It skips pull requests from forks, because release-please reads the branch from this repository.
- `package` installs the same toolchain and runs the same gates as `build`, then `pnpm release:dry-run` in `ad-hoc` mode, and prints `release-artifacts/release-plan.json`. Then it runs release mode with `--tag v<version>` and checks that release mode refuses the ad-hoc build. It uploads nothing, because anyone can download a workflow artifact on a public repository.

## How versions bump

release-please reads the Conventional Commit types merged since the last release.

- `fix`, `perf`, and `revert` bump the patch version.
- `feat` bumps the minor version.
- A breaking change bumps the major version. A breaking change is any type with `!`, such as `fix!:` or `refactor!:`, or any commit with a `BREAKING CHANGE:` footer. The config does not set `bump-minor-pre-major`, so a breaking change on `0.x` bumps to `1.0.0`.
- `chore`, `docs`, `ci`, `build`, `refactor`, `style`, and `test` do not start a release by themselves.

The manifest starts at `0.0.0`, which release-please reads as "never released". The config sets `initial-version` to `0.1.0`, so the first release is `0.1.0`.

To force a version, merge a commit to `main` with this footer in its message:

```text
Release-As: 1.4.0
```

The release PR then proposes that version.

## Recover from a failed release

- If `build` or `upload` fails, open the run and select **Re-run failed jobs**. GitHub allows a rerun for 30 days after the run. The rerun keeps the outputs of `release-please`, and `upload` is safe to repeat. `--clobber` replaces assets that already exist, and the marker line stops a second install notice.
- A rerun of `upload` alone needs the `release-v<version>` artifact, which lasts 7 days. After that, rerun the `build` job from its page. GitHub reruns `upload` after it.
- **Re-run all jobs** does nothing. `release-please` finds no merged release PR still labeled `autorelease: pending`, so it creates no release, and `build` and `upload` skip.
- If `release-pr` fails, the release still builds. The next push to `main` opens the release PR.
- If `build` fails because of the code, the tag and the release exist without assets. A maintainer marks the release as a prerelease, so it is no longer the latest release, and adds a note to its notes that it has no assets.

  ```sh
  gh release edit vX.Y.Z -R codlume/figma-drop --prerelease
  ```

  Then fix the problem on `main` with a `fix:` pull request. The next release carries the fix.

- Never move, delete, or re-push a tag. Never edit a version by hand. A new release is the only way to replace a published one.
