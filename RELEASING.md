# Releasing figma-drop

A release is one version of the whole repository, tagged `v<version>`. release-please keeps a standing release pull request on `main`. When a maintainer merges it, the release workflow tags the commit, creates a GitHub release, builds both artifacts on macOS, and attaches them to that release. Nothing goes anywhere else.

## What a release contains

The release PR bumps one version in four files. These are the root `package.json`, `apps/desktop/package.json`, `apps/figma-plugin/package.json`, and `.release-please-manifest.json`. `release-please-config.json` lists the two app files as `extra-files`, and `pnpm test:release` fails if an app is missing from that list or the versions disagree. The PR also adds the new section of `CHANGELOG.md`.

The GitHub release for `v<version>` carries three assets.

| Asset                                   | Contents                                                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `figma-drop-<version>-mac-arm64.dmg`    | A drag-to-install disk image of `figma-drop.app` for Apple silicon. The app and the DMG are each signed with a Developer ID, notarized by Apple, and stapled. The app is signed under the hardened runtime. |
| `figma-drop-figma-plugin-<version>.zip` | The plugin's `manifest.json` and its built `dist/` files, for import into the Figma desktop app.                                                                                                            |
| `SHA256SUMS.txt`                        | The SHA-256 of the DMG and the plugin zip. It hashes the final bytes, after the DMG is signed and stapled.                                                                                                  |

The release workflow also appends an install notice to the release notes. It names the DMG and the plugin zip and says how to install each.

## Signing modes

`scripts/package-local.mjs` builds the app in one of two signing modes, and `scripts/release-package.mjs` puts it in a DMG signed the same way. No mode in between exists, so a build that is signed but not notarized cannot be made.

| Mode           | When                                         | What the app and the DMG get                                                                                     | DMG name                                                                                                     |
| -------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ad-hoc`       | `FIGMA_DROP_SIGN_IDENTITY` is not set        | The app gets an ad-hoc signature, and the DMG gets no signature. Gatekeeper rejects both on another Mac.         | `figma-drop-<version>-mac-arm64-unsigned-dry-run.dmg`. A release refuses this mode.                          |
| `developer-id` | `FIGMA_DROP_SIGN_IDENTITY` names an identity | The app and the DMG are each signed with a Developer ID and a secure timestamp, notarized by Apple, and stapled. | `figma-drop-<version>-mac-arm64-dry-run.dmg` in a dry run, `figma-drop-<version>-mac-arm64.dmg` in a release |

The `developer-id` mode reads three variables.

| Variable                     | Holds                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `FIGMA_DROP_SIGN_IDENTITY`   | The `codesign` identity, as its `Developer ID Application: ...` name or its SHA-1. The identity must be in an unlocked keychain. |
| `FIGMA_DROP_NOTARY_PROFILE`  | The name of a `notarytool` keychain profile that holds the Apple ID, the team ID, and an app-specific password.                  |
| `FIGMA_DROP_NOTARY_KEYCHAIN` | Optional. The keychain that holds the profile, if it is not the default keychain. An empty value is an error.                    |

If `FIGMA_DROP_SIGN_IDENTITY` is set and the profile is missing, both scripts stop before they sign anything and name each missing variable. The scripts never see an Apple password. `notarytool` reads it from the profile.

To create the profile on your Mac, run this command. `notarytool` checks the credentials with Apple before it saves them.

```sh
xcrun notarytool store-credentials figma-drop-notary --apple-id <apple-id> --team-id <team-id>
```

It then prompts for the app-specific password. Type it at the prompt, and never pass it with `--password`, because the command line goes into your shell history. Then set `FIGMA_DROP_NOTARY_PROFILE=figma-drop-notary`. `security find-identity -v -p codesigning` lists the identity names.

### How a Developer ID build is signed

A `developer-id` build runs these steps in order.

1. `package-local.mjs` signs the app from the inside out. Each Mach-O file, framework, and `.app` in the bundle gets its own signature, deepest first, with the hardened runtime and a secure timestamp. Each `.app`, which is the app and its four Electron helpers, gets `apps/desktop/entitlements.mac.plist`. That file holds only `com.apple.security.cs.allow-jit`. Nothing else gets an entitlement, and the script reads back every signature and fails on any other entitlement.
2. It zips the app with `ditto` and submits the zip with `xcrun notarytool submit --wait`.
3. It always fetches the notary log, also when Apple accepts the submission, and saves it as `apps/desktop/release/notary-log-app.json`. It fails unless the status is `Accepted` and the log holds no issue other than a warning. It prints each warning.
4. It staples the ticket to the app, with up to five attempts, and runs `xcrun stapler validate` on the app.
5. `release-package.mjs` builds a read-only, zlib-compressed `UDZO` DMG from the stapled app with dmgbuild. The volume holds `figma-drop.app`, an `Applications` symlink to `/Applications`, and the Finder layout from `apps/desktop/dmg/`.
6. It signs the DMG with `codesign --sign <identity> --timestamp --identifier com.codlume.figma-drop.dmg`.
7. It notarizes the DMG itself the same way, reads its log into `notary-log-dmg.json`, staples the DMG, and validates the ticket.
8. It verifies the final DMG and only reads it. `hdiutil imageinfo` must report `UDZO`, and `hdiutil verify` must pass. It mounts the DMG read-only and checks the volume entries, the `Applications` symlink and its target, and the volume icon. For the app inside, it checks the version, bundle id, and `arm64` executable, that the bundled `dist` and `dist-electron` match the build, `codesign --verify --deep --strict`, `xcrun stapler validate`, and `spctl -a -t exec`, which must report `Notarized Developer ID`. For the DMG, it checks the `disk image` format, the identifier, the Developer ID authority, the app's team ID, the timestamp, `codesign --verify --strict`, `xcrun stapler validate`, and `spctl -a -t open --context context:primary-signature`, which must report `Notarized Developer ID`. The DMG's SHA-256 must not change during these checks.
9. It zips and verifies the plugin, then writes `SHA256SUMS.txt` and `release-plan.json`, which names the signing mode and both notary submission ids. Nothing writes the DMG after it is stapled, so the checksum covers the released bytes.

Apple asks only for the outer container to be notarized. figma-drop notarizes the app too, so the app keeps its own stapled ticket after the user drags it out of the DMG, and Gatekeeper can check it while the Mac is offline. The DMG's ticket stays with the DMG. So every `developer-id` build makes two notary submissions.

`release-package.mjs` reads the app's mode with `codesign`, `xcrun stapler validate`, and `spctl`. It fails on an app that matches neither mode. A release, `--tag`, accepts only `developer-id`. A dry run accepts both. It also refuses a `developer-id` app without the variables to sign its DMG, and an `ad-hoc` app while `FIGMA_DROP_SIGN_IDENTITY` is set. If a `developer-id` run fails after the DMG is built, it keeps the notary logs in `release-artifacts/notary/`.

## Prerequisites

- Turn on **Allow GitHub Actions to create and approve pull requests** in **Settings > Actions > General > Workflow permissions**. Without it, release-please cannot open the release PR. To read the setting, run `gh api repos/codlume/figma-drop/actions/permissions/workflow`. It reports the setting as `can_approve_pull_request_reviews`.
- The workflows declare their own token permissions in YAML, so the repository's default token permission does not matter.
- A DMG build needs `python3` 3.10 or later on `PATH` and access to PyPI. `node scripts/dmg.mjs --setup`, also `pnpm dmg:setup`, installs dmgbuild, ds_store, and mac_alias into a virtual environment in `node_modules/.cache/figma-drop-dmgbuild`. `scripts/dmgbuild-requirements.txt` pins each wheel by version and SHA-256. A later run with the same requirements changes nothing and needs no network.
- The GitHub environment `release` holds the signing and notarization secrets, and only `main` may deploy to it. The `package` job of `.github/workflows/package-macos.yml` is the only job that uses it. The **Release dry run** workflow uses no secrets.

  | Secret                         | Holds                                                                            |
  | ------------------------------ | -------------------------------------------------------------------------------- |
  | `MACOS_CERTIFICATE_P12_BASE64` | The Developer ID Application certificate and its private key, as a base64 `.p12` |
  | `MACOS_CERTIFICATE_PASSWORD`   | The password of that `.p12`                                                      |
  | `APPLE_ID`                     | The Apple ID that submits the app and the DMG to the notary service              |
  | `APPLE_APP_SPECIFIC_PASSWORD`  | An app-specific password for that Apple ID                                       |
  | `APPLE_TEAM_ID`                | The 10-character team ID of the Developer ID certificate                         |

  A called workflow gets an environment secret only when its caller passes it by name. So the release workflow's `build` job passes all five to `package-macos.yml`. In the `package` job, only the step **Import the signing and notary credentials** sees them. It runs `scripts/ci-import-signing.sh`, which checks each secret by name and never prints a value. The script decodes the `.p12` into a throwaway keychain in `$RUNNER_TEMP` and deletes the file. It then requires exactly one valid Developer ID Application identity for `APPLE_TEAM_ID` and takes that identity's SHA-1. It stores the profile `figma-drop-notary` in the same keychain with `notarytool store-credentials`, which checks the credentials with Apple. `notarytool` takes the password only as an argument or at an interactive prompt, so on the runner it gets an argument. Later steps get `FIGMA_DROP_SIGN_IDENTITY`, `FIGMA_DROP_NOTARY_PROFILE`, and `FIGMA_DROP_NOTARY_KEYCHAIN`, and no Apple password. The step **Delete the signing keychain** runs `ci-import-signing.sh --cleanup`, also when an earlier step fails.

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
   3. `build` calls `.github/workflows/package-macos.yml` with the tag and the tagged commit, with a read-only token. Its `package` job runs on `macos-15` in the `release` environment and checks out that commit. It installs Node from `.node-version`, pnpm from `packageManager` through corepack, and the dependencies with `pnpm install --frozen-lockfile`, so the whole toolchain comes from the lockfile. It runs `pnpm typecheck`, `pnpm test`, `pnpm test:release`, `pnpm build`, and `node scripts/dmg.mjs --setup`, and no secret is in reach of those steps. Then it imports the credentials, as the prerequisites describe. It runs `node scripts/package-local.mjs` in `developer-id` mode and `node scripts/release-package.mjs --tag v<version>`, which run the steps in [How a Developer ID build is signed](#how-a-developer-id-build-is-signed). The step **Record the signing and notarization evidence** runs `scripts/dmg-evidence.sh` on the DMG and writes the output to `release-artifacts/notary/dmg-evidence.txt` and to the job summary. Then it deletes the keychain. The job stores two workflow artifacts for 7 days. `release-v<version>` holds the DMG, the plugin zip, and `SHA256SUMS.txt`. `notary-logs-v<version>` holds both notary logs and `dmg-evidence.txt`.
   4. `upload` downloads `release-v<version>` and runs `sha256sum -c SHA256SUMS.txt`. It fails if the artifact holds any file that `SHA256SUMS.txt` does not list. Then it attaches every file to the release with `gh release upload --clobber`, and appends the install notice to the release notes, unless a line of the notes is exactly `<!-- figma-drop-install-notice -->`. The notary logs never reach the release.

   `release-please`, `release-pr`, and `upload` run no repository code, and they are the only jobs with write access. The release is public from the first job, and its assets attach when `upload` finishes. Two notarizations can take a while, so the `package` job has a 90-minute timeout.

5. Download the assets and check them, as [Check a downloaded DMG](#check-a-downloaded-dmg) describes. You can also download the assets from the release page at `https://github.com/codlume/figma-drop/releases`.

## Check a downloaded DMG

To download the release and check the checksums, run:

```sh
gh release download v<version> -R codlume/figma-drop -D figma-drop-v<version>
cd figma-drop-v<version>
shasum -a 256 -c --ignore-missing SHA256SUMS.txt
```

`shasum` prints `OK` for each asset it finds. `--ignore-missing` skips an asset you did not download.

To check the signatures, run `scripts/dmg-evidence.sh` from a checkout of the repository on a Mac:

```sh
bash scripts/dmg-evidence.sh figma-drop-v<version>/figma-drop-<version>-mac-arm64.dmg
```

It prints each command and its exit code, and judges nothing. It mounts the DMG read-only and always detaches it. A good release shows these results:

- `hdiutil verify` reports that the checksum `is VALID`.
- `codesign -dv --verbose=4` on the DMG shows `Format=disk image`, `Identifier=com.codlume.figma-drop.dmg`, an `Authority=Developer ID Application: ...` line, and a `Timestamp=` line.
- `xcrun stapler validate` exits 0 for the DMG and for the app inside it.
- `spctl -a -t open --context context:primary-signature -vvv` on the DMG shows `accepted` and `source=Notarized Developer ID`.
- `readlink` on `Applications` prints `/Applications`.
- `codesign --verify --deep --strict` on the app reports `valid on disk`.
- `spctl -a -t exec -vvv` on the app shows `accepted` and `source=Notarized Developer ID`.
- The entitlements of the app and of each `.app` in its `Contents/Frameworks` hold only `com.apple.security.cs.allow-jit`.

The release run recorded the same output as `dmg-evidence.txt`, in its job summary and in the `notary-logs-v<version>` artifact. After you install the app, run `spctl -a -t exec -vvv /Applications/figma-drop.app`. It must show `accepted` and `source=Notarized Developer ID`.

## Install the release

To install the app:

1. Quit any running copy of figma-drop.
2. Open `figma-drop-<version>-mac-arm64.dmg`.
3. Drag `figma-drop` to the `Applications` folder in the same window.
4. Eject the disk image.
5. Open figma-drop from your Applications folder. Apple notarized it, so macOS opens it after one confirmation. It uses the library at `~/figma-drop` and port 3579.

To install the plugin:

1. Unzip `figma-drop-figma-plugin-<version>.zip` into a folder you keep. Figma loads a development plugin from that folder each time it runs.
2. In the Figma desktop app, select **Plugins > Development > Import plugin from manifest**.
3. Select `manifest.json` in the unzipped folder.

The browser version of Figma cannot import a development plugin.

## Test the signed package without a release

The **Package macOS app** workflow runs the release's signed build without publishing anything. To start it, a maintainer dispatches it on `main`, from the **Actions** tab or with this command:

```sh
gh workflow run package-macos.yml --ref main
```

Without a tag, the `package` job runs `release-package.mjs --dry-run`. It signs, notarizes, and staples the app and the DMG, verifies them, and records the evidence. It stores the workflow artifact `package-test-<run_id>` for 3 days. The artifact holds `figma-drop-<version>-mac-arm64-dry-run.dmg`, the dry-run plugin zip, `SHA256SUMS-dry-run.txt`, `release-plan.json`, and the `notary/` folder with both notary logs and `dmg-evidence.txt`. The run touches no release, tag, or release PR, and its token is read-only. Each run makes two notary submissions.

The workflow cannot run from another branch, for two reasons. GitHub dispatches only a workflow that exists on `main`, and refuses with HTTP 404 otherwise. The `release` environment also accepts only `main`, so a job from any other ref cannot read its secrets. `proof/dmg/premerge-blocker.txt` records both.

## Run a dry run

To build both artifacts locally without publishing anything, run this on an Apple silicon Mac:

```sh
pnpm install --frozen-lockfile
pnpm release:dry-run
```

It needs no token and no credentials, but it needs `python3` and PyPI, as the prerequisites describe. It runs `pnpm app:local`, which builds `apps/desktop/release/figma-drop.app` in `ad-hoc` mode, then `node scripts/dmg.mjs --setup`, then `node scripts/release-package.mjs --dry-run`. It writes these files to `release-artifacts/`:

- `figma-drop-<version>-mac-arm64-unsigned-dry-run.dmg`, an unsigned DMG around the ad-hoc app. Gatekeeper rejects it on another Mac.
- `figma-drop-figma-plugin-<version>-dry-run.zip`
- `SHA256SUMS-dry-run.txt`
- `release-plan.json`, which names the signing mode

`<version>` is the current version in `package.json`, not the next one. To build only the ad-hoc app, run `pnpm app:local`. It needs no Python, network access to PyPI, or credentials.

To dry-run the `developer-id` mode, first set `FIGMA_DROP_SIGN_IDENTITY` and `FIGMA_DROP_NOTARY_PROFILE`, as [Signing modes](#signing-modes) describes. The run then submits the app and the DMG to Apple's notary service. It writes `figma-drop-<version>-mac-arm64-dry-run.dmg` and both notary logs in `release-artifacts/notary/`.

The **Release dry run** workflow runs on every pull request and on manual dispatch, with a read-only token and no secrets. It has two jobs:

- `plan` runs `release-please release-pr --dry-run` against the branch. Its job summary shows the release PR that release-please would open if that branch were `main`. The plan lists each commit on the branch. `main` gets one squash commit per pull request, so the real release PR lists that commit instead. It skips pull requests from forks, because release-please reads the branch from this repository.
- `package` installs the same toolchain and runs the same gates as the release's `package` job. Then it runs `node scripts/dmg.mjs --setup` and `pnpm release:dry-run` in `ad-hoc` mode, and prints `release-artifacts/release-plan.json`. Then it runs release mode with `--tag v<version>` and checks that release mode refuses the ad-hoc build. It uploads nothing, because anyone can download a workflow artifact on a public repository.

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

- If `build` or `upload` fails, open the run and select **Re-run failed jobs**. GitHub allows a rerun for 30 days after the run. The rerun keeps the outputs of `release-please`. A rerun of `build` signs and notarizes again, and `upload` is safe to repeat. `--clobber` replaces assets that already exist, and the marker line stops a second install notice.
- If Apple rejects a submission, the `package` job fails and its log prints each issue from the notary log. The job uploads its artifacts only when it succeeds, so a failed run has no `notary-logs-v<version>` artifact.
- A rerun of `upload` alone needs the `release-v<version>` artifact, which lasts 7 days. After that, rerun the `build` job from its page. GitHub reruns `upload` after it.
- **Re-run all jobs** does nothing. `release-please` finds no merged release PR still labeled `autorelease: pending`, so it creates no release, and `build` and `upload` skip.
- If `release-pr` fails, the release still builds. The next push to `main` opens the release PR.
- If `build` fails because of the code, the tag and the release exist without assets. A maintainer marks the release as a prerelease, so it is no longer the latest release, and adds a note to its notes that it has no assets.

  ```sh
  gh release edit vX.Y.Z -R codlume/figma-drop --prerelease
  ```

  Then fix the problem on `main` with a `fix:` pull request. The next release carries the fix.

- Never move, delete, or re-push a tag. Never edit a version by hand. A new release is the only way to replace a published one.
