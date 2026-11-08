# Releasing figma-drop

A release is one version of the whole repository, tagged `v<version>`. release-please keeps a standing release pull request on `main`. When a maintainer merges it, the release workflow tags the commit, creates a GitHub release, builds both artifacts on macOS, and attaches them to that release. Nothing goes anywhere else.

## What a release contains

The release PR bumps one version in four files. These are the root `package.json`, `apps/desktop/package.json`, `apps/figma-plugin/package.json`, and `.release-please-manifest.json`. `release-please-config.json` lists the two app files as `extra-files`, and `pnpm test:release` fails if an app is missing from that list or the versions disagree. The PR also adds the new section of `CHANGELOG.md`.

The GitHub release for `v<version>` carries three assets.

| Asset                                         | Contents                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `figma-drop-<version>-mac-arm64-unsigned.zip` | `figma-drop.app` for Apple silicon. It has an ad-hoc signature and no notarization.              |
| `figma-drop-figma-plugin-<version>.zip`       | The plugin's `manifest.json` and its built `dist/` files, for import into the Figma desktop app. |
| `SHA256SUMS.txt`                              | The SHA-256 of both zips.                                                                        |

The release workflow also appends an install notice to the release notes. It says the app is unsigned and shows how to open it.

## Prerequisites

- Turn on **Allow GitHub Actions to create and approve pull requests** in **Settings > Actions > General > Workflow permissions**. Without it, release-please cannot open the release PR. To read the setting, run `gh api repos/codlume/figma-drop/actions/permissions/workflow`. It reports the setting as `can_approve_pull_request_reviews`.
- The workflows declare their own token permissions in YAML, so the repository's default token permission does not matter.
- No secrets are required. Both workflows use only `github.token`.

GitHub starts no workflow for a pull request, push, or tag that `github.token` creates. So the release dry-run workflow does not run on the release PR, and the tag starts no workflow. The release workflow builds the assets in the same run that creates the tag for that reason.

These are not available, because the repository holds none of the credentials they need:

- Developer ID signing. It needs a Developer ID Application certificate from an Apple Developer Program membership.
- Notarization. It needs an Apple notarization account, which is an Apple ID with an app-specific password or an App Store Connect API key.
- Figma Community publishing. It needs a Figma-assigned plugin id and Figma's own publish flow. `apps/figma-plugin/manifest.json` uses the local id `figma-drop-local`.
- Auto-update. It needs signed builds and a hosted update feed.

## Cut a release

1. Merge pull requests with Conventional Commit titles into `main`. Each merge updates the standing release PR, titled `chore(main): release <version>`.
2. Review the release PR. Check the version in its title, the new `CHANGELOG.md` section, the version in the three `package.json` files, and `.release-please-manifest.json`.
3. Merge the release PR.
4. Watch the **Release** run for that merge in the **Actions** tab. Its jobs run in this order:
   1. `release-please` creates the tag `v<version>` and the GitHub release with the changelog section as its notes. This job and `upload` run no repository code, and they are the only jobs with write access.
   2. `build` runs on `macos-15` with a read-only token. It checks out the tagged commit and runs `pnpm typecheck`, `pnpm test`, and `pnpm test:release`. Then it runs `pnpm app:local` and `node scripts/release-package.mjs --tag v<version>`, which writes and checks the zips and `SHA256SUMS.txt`. It stores them as the workflow artifact `release-v<version>` for 7 days.
   3. `upload` downloads that artifact and attaches the three files to the release with `gh release upload --clobber`. Then it appends the install notice to the release notes, unless the notes already contain `<!-- figma-drop-unsigned-notice -->`.
5. Download the assets and check them.

   ```sh
   gh release download v<version> -R codlume/figma-drop -D figma-drop-v<version>
   cd figma-drop-v<version>
   shasum -a 256 -c SHA256SUMS.txt
   ```

   `shasum` prints `OK` for each zip. You can also download the assets from the release page at `https://github.com/codlume/figma-drop/releases`.

## Install the release

To install the app:

1. Quit any running copy of figma-drop.
2. Unzip `figma-drop-<version>-mac-arm64-unsigned.zip`, and move `figma-drop.app` to `~/Applications` or `/Applications`.
3. Clear the quarantine flag, so macOS lets the unsigned app open.

   ```sh
   xattr -dr com.apple.quarantine ~/Applications/figma-drop.app
   ```

   Instead, you can open the app once, then select **Open Anyway** in **System Settings > Privacy & Security**.

4. Open the app. It uses the library at `~/figma-drop` and port 3579.

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

It needs no token. It builds `apps/desktop/release/figma-drop.app` and writes these files to `release-artifacts/`:

- `figma-drop-<version>-mac-arm64-unsigned-dry-run.zip`
- `figma-drop-figma-plugin-<version>-dry-run.zip`
- `SHA256SUMS-dry-run.txt`
- `release-plan.json`

`<version>` is the current version in `package.json`, not the next one.

The **Release dry run** workflow runs on every pull request and on manual dispatch, with a read-only token and no secrets. It has two jobs:

- `plan` runs `release-please release-pr --dry-run` against the branch. Its job summary shows the release PR that release-please would open if that branch were `main`. It skips pull requests from forks, because release-please reads the branch from this repository.
- `package` runs the same gates as `build`, then `pnpm release:dry-run`, and prints `release-artifacts/release-plan.json`. It uploads nothing, because anyone can download a workflow artifact on a public repository.

## How versions bump

release-please reads the Conventional Commit types merged since the last release.

- `fix`, `perf`, and `revert` bump the patch version.
- `feat` bumps the minor version.
- A breaking change, written as `feat!:` or with a `BREAKING CHANGE:` footer, bumps the major version. The config does not set `bump-minor-pre-major`, so a breaking change on `0.x` bumps to `1.0.0`.
- `chore`, `docs`, `ci`, `build`, `refactor`, `style`, and `test` do not start a release by themselves.

The manifest starts at `0.0.0`, and the config sets no `initial-version`. So the first release is `1.0.0`.

To force a version, merge a commit to `main` with this footer in its message:

```text
Release-As: 1.4.0
```

The release PR then proposes that version.

## Recover from a failed release

- If `build` or `upload` fails, open the run and select **Re-run failed jobs** within 7 days. The rerun keeps the outputs of `release-please`, and `upload` is safe to repeat. `--clobber` replaces assets that already exist, and the marker line stops a second install notice.
- If `build` fails because of the code, the tag and the release exist without assets. Fix the problem on `main` with a `fix:` pull request. The next release carries the fix.
- Never move, delete, or re-push a tag. Never edit a version by hand. A new release is the only way to replace a published one.
