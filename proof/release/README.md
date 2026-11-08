# Release proof

This folder holds the evidence that the release pipeline packages both products without publishing anything. All of it is synthetic and local. No tag, release, or upload was made.

| File                  | What it shows                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-proof.sh`      | The rerunnable local proof. Run `bash proof/release/local-proof.sh` from the repository root on an Apple silicon Mac. It needs no token.                                                                              |
| `local-proof.txt`     | Its output: the release tests, three rejected invocations, `pnpm release:dry-run`, checksums, both zip listings, the extracted plugin manifest compared with the source, and the extracted app's plist and signature. |
| `gates.txt`           | `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm fmt:check`, and `actionlint` on the same head.                                                                                                                      |
| `check-workflows.mjs` | A policy check over both workflows: read-only dry run, write access only on `release-please` and `upload`, pinned actions, no expressions in `run:`, and an idempotent install notice.                                |
| `mutate.mjs`          | Injects three defects and shows `check-workflows.mjs` catches each one.                                                                                                                                               |
| `workflow-policy.txt` | Output of both scripts.                                                                                                                                                                                               |
| `ci-dry-run.md`       | The **Release dry run** workflow run on the implementation PR.                                                                                                                                                        |

The two workflow scripts need the `yaml` package, which the repository does not install. To rerun them, copy both into a scratch folder, run `npm install yaml@2.6.1` there, and run `node check-workflows.mjs <repo>` and `node mutate.mjs <repo>`.

`spctl` rejects the extracted app. That is expected for an ad-hoc signature, and it is why the release notes tell users how to open an unsigned app. The release workflow itself has not run, because only merging a release PR on `main` starts it.
