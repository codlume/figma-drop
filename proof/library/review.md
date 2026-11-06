# Library review record

Three independent reviews ran on `apps/desktop/src/library/**`, each in its own checkout, with live probes. None of the reviewers wrote the code.

The reviewed SHAs below are local commits from before the history was regrouped into three commits, so they are not on the remote. The record of what changed after each review is in the table of findings.

| Review               | Model      | Reviewed           | Verdict          |
| -------------------- | ---------- | ------------------ | ---------------- |
| 1. Full review       | Fable 5.1  | `da5e61f`          | SHIP, 5 findings |
| 2. Delta re-check    | Opus 5.5   | `da5e61f..7d9e106` | BLOCK, 1 finding |
| 3. Fix re-check      | Fable 5.1  | `e343de2`          | SHIP             |
| 4. Integration delta | see the PR | see the PR         | see the PR       |

After review 3, production code changed in three lines, all from lint: two `.sort()` calls became `.toSorted()`, and one `[...listeners]` copy was removed.

## Findings

| From | Severity | Finding                                                                                 | Outcome                                                                             |
| ---- | -------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1    | Medium   | One unreadable folder stopped all ingestion                                             | Fixed, and the first fix was replaced after review 2                                |
| 1    | Low      | A read-only copy destination reported the library as unavailable                        | Fixed                                                                               |
| 1    | Low      | `copyTo` can replace an empty folder created between its check and its rename           | Accepted, no data is lost                                                           |
| 1    | Low      | A Finder restore while the app runs can duplicate a sequence number                     | Accepted, no data is lost                                                           |
| 1    | Low      | Two test assertions could not fail                                                      | Fixed                                                                               |
| 2    | Blocking | An unreadable node looked empty, so `seq` reset and a real revert was falsely `skipped` | Fixed with `Catalog.blocked`, a folder the OS refuses to list is unknown, not empty |
| 2    | Test gap | The second liveness check and `O_NOFOLLOW` had no test                                  | Fixed, both are pinned                                                              |
| 3    | Note     | A refused folder leaves the snapshot with no message                                    | Open, issue #3                                                                      |

## Mutants on the real code, review 1

17 of 18 were killed. The survivor removed the separator from the containment prefix check, which is unreachable because the library builds every candidate path and refuses symlinks first.

Killed: `contain` ignoring symlinks, `decide` skipping on any latest, Unidentified convergence ignoring `claimedKey`, receipt location and id checks, `..` in a segment, a copy destination inside the library, non-regular staged files, required files, the liveness check, the outcome memo, scanning into symlinks, trash symlink refusal, `latestOf` picking the oldest, both receipt size caps, and `isStagingId`.

After the blocking fix, four more mutants were killed: `decide` ignoring `blocked`, the tolerance catching every error, `O_NOFOLLOW` dropped, and the second liveness check dropped. Without `O_NOFOLLOW`, the receipt write really overwrote a file outside the library.

## Probes, review 3

P1 to P5 reproduced the blocking finding and now behave correctly: no false `skipped`, no mis-sequenced revision, no duplicate node directory. P6 to P10 showed no regression. Q1 to Q7 attacked the new model, including a damaged highest revision, a folder blocked after the catalog was cached, and a replay into a blocked node, and none broke it.

## What no review covered

The real macOS Trash, a real Figma export, the receiver end to end, permission refusals from macOS privacy controls rather than `chmod`, and `copyTo` or `bundlePath` racing a queued commit.
