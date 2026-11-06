# figma-drop

## Agent routing

- Track work in GitHub Issues for `codlume/figma-drop` through `gh`. Pass multiline bodies with `--body-file`.
- When `.claude/skills/verify/SKILL.md` exists, read it before you change user-visible desktop behavior.
- When `packages/export-contract` exists, read it before you change anything on the wire.

## The product

figma-drop is a local macOS desktop app plus its own Figma plugin. It receives Figma exports, identifies the source Figma file, and groups exports from one file together.

The app is not built yet. Product decisions here are settled. Structure and toolchain are plans. Once code lands, it owns structure and `package.json` owns commands and versions.

## Non-negotiables

### 1. One Figma file is one project

The file key is the only grouping input. "Project" never means a Figma team, folder, or page. Different file keys stay separate, and projects never merge.

An export without a stable file identity goes to the Unidentified inbox and stands alone. It never joins a project, and v1 has no manual reassignment. Delete to Trash is its way out.

### 2. Revisions survive until the user trashes them

An export is compared with that node's latest revision only. A match is skipped and replies with that revision's path. Anything else adds a revision, so a revert to older content keeps its own revision.

### 3. Everything stays on this Mac

The library lives at `~/figma-drop`. figma-drop has no cloud sync and no Figma REST token.

The receiver has no shared secret. Strict controls protect it instead: loopback bind, Host allowlist, Origin policy, JSON content type, body cap, and path containment.

### 4. The receiver runs while the app runs

The receiver is on by default, with a persisted on/off toggle. Closing the window keeps the menu-bar app and the receiver alive. figma-drop registers no login item.

### 5. Compatibility is independent work

Upstream's plugin keeps exporting into the library. Upstream has no licence. Work from the wire facts written down in `packages/export-contract` once it exists, and keep upstream's source out of your context. Write source, structure, UI copy, and assets ourselves, unless the owner establishes reuse rights and records them in this file. Collaboration happens outside this repo, so agents make no outreach.

### 6. Version 1 stays small

v1 actions are browse, preview, reveal in Finder, copy path, "Copy to folder", which writes a plain bundle, and delete to Trash. v1 has no existing-bundle import and no folder watching. Target macOS with local unsigned arm64 builds, and leave releases, signing changes, and publishing alone.

## A note to agents

Favor ambitious outcomes and simple systems. Understand the real constraint, then implement the smallest model that makes the correct behavior unsurprising. Fight scope creep.

The rules below are strong defaults. Explicit developer instructions win. If a rule conflicts with the task, call it out and get human sign-off before breaking it.

## A small glossary

Use this language consistently:

- **Upstream.** `drillprop/figma-export`, the plugin and server by the owner's friend.
- **Export.** One node received through one `POST /sync`. A batch is many exports, and upstream sends no batch id.
- **Project.** All exports from one Figma file.
- **Bundle.** The plain folder with `node.json`, `figma-components.json`, `meta.json`, and optional files.
- **Revision.** One directory that holds a bundle plus a receipt.
- **Library.** The revision directories on disk. The files are the catalog.
- **Receiver.** The `utilityProcess` that runs the local HTTP server.
- **Commit.** One rename from staging into a fresh revision path, so nothing is replaced in place.

## The three ways to hurt yourself

1. **Trusting what arrives.** Everything received is untrusted, including names, SVG, and HTML.
   - `Origin: null` is not authentication, because a hostile sandboxed iframe sends it too. Assume a forged `/sync`, and limit it to a junk export inside the library.
   - Render previews as images only. Exported HTML and SVG never run as documents in the app.
   - Handle `/open` style requests inside the app. A client-supplied path never reaches the OS.
   - Let the library choose every path, and ignore `outputDir`. The receiver hands main a staging id and never names a path that main renames.
   - Expect `..`, case-only name pairs, and long names. The default APFS volume is case-insensitive, so build directory names from a slug plus a hash, and keep display names in data.
   - Show a taken port as a visible conflict, and never kill a foreign process. The plugin manifest pins port 3579, so it cannot silently change.
2. **Misattributing an export.** A wrong group looks correct to the user.
   - A missing or empty `fileKey`, `fileKey === fileName`, or `"current"` means a fallback, not an identity. The upstream wire has no fallback flag.
   - Classify with those comparisons alone. Figma documents no key shape, so use no key-shape regex.
   - Treat names as display hints. Two files named `Untitled` produce the same fallback.
3. **Losing an export.** Keep the export when anything after commit fails.
   - Make ingestion retries idempotent. A crash after the rename shows the plugin a failure, so expect a retry of a committed export. Replaying a staging id returns the first result. A re-sent export matching a project node's latest revision, or an Unidentified entry with the same claimed key (both missing counts as the same), node id, and hash, converges on that entry and adds nothing. The wire cannot tell that retry from a deliberate re-export or a byte-identical export of a second file, so those converge too. A different hash never converges.
   - Hash once at staging, excluding `exportedAt`, `outputDir`, and `folderName`. `exportedAt` changes on every retry.
   - Show a revision with an unreadable receipt as damaged, and leave its files alone.

## Hit every surface

The most common defect is fixing one path and leaving another inconsistent. Before calling a feature done, check:

- **Senders.** Our plugin and upstream reach the same receiver.
- **Entry points.** The window and the menu-bar app may expose the same behavior.
- **States.** Every way into a state needs a way out. Show `listening` only after the bind succeeds, and saved only after commit.
- **Lifecycle.** Check a closed window, a quit during a receive, a receiver crash, and a restart.
- **Degraded mode.** A full disk and an unreadable library are normal runtime states.

## Development safety

- Point development builds at a scratch library and a test port. Touch `~/figma-drop` only when explicitly asked.
- If you start a process, track exactly what you started and stop only that process.

## Test data

An empty happy path is a bad test. Keep a small deterministic fixture set that covers:

- every fallback form, two files with one name, and a repeat that differs only in `exportedAt`,
- `..`, non-ASCII names, case-only pairs, and long names,
- exports with no preview, and SVG or HTML that carries scripts,
- bad Host, bad Origin, wrong content type, an oversized body, a crash at each commit step, and a damaged receipt.

Fixtures are synthetic. Keep real user exports out of the repo, issues, and PR evidence.

## Verifying

Use the smallest proof that the change works.

- Run focused tests for the behavior you changed. CI owns the repo-wide sweep once it exists.
- Prefer observable behavior over tests that mirror implementation details.
- Await a real signal for async state, with no arbitrary sleeps.
- For user-visible changes, the integrated flow is `synthetic export -> disposable instance -> right project -> survives restart`.

Plugin behavior is proven only in a Figma client. Without one, report it as unverified, such as the real `Origin` header or `figma.fileKey` on a branch.

## Pull requests

- Land every change on `main` through a reviewed PR. Open a PR when the developer or the ticket asks for one.
- Keep one concern per PR, with a conventional commit title.
- Describe the problem first, then the fix.
- Include before/after evidence for UI changes, using github-image-upload.

## Documentation

Most code changes need no documentation change. Update guidance only when a maintainer would otherwise make the wrong decision. Rewrite stale guidance instead of appending a second version of the truth.

## Plans and work artifacts

Keep scratch notes, temporary plans, and debugging captures out of commits. Track active work in its issue. A merged PR is the implementation record.

## How it works

This is the plan. A plugin sends each node as one `POST http://localhost:3579/sync` JSON request. The receiver stages it, main commits it, and the receiver replies. Main builds its index from receipts, without reading bundles.

`export -> receive -> stage -> commit -> index -> show`

- Reply `{path, preview?}` on success and `{error}` on failure, always within a deadline. Upstream's plugin has no timeout, so silence stalls a batch forever.
- Keep the words "output folder" out of `{error}`. Upstream's plugin matches them.
- On `POST` and `OPTIONS`, accept only the Origin the plugin iframe sends, and reply 403 to anything else. That value stays unverified until a real plugin run records it, and `null` is the working assumption. Answer an accepted preflight, and send a CORS allow-origin on every reply to an accepted Origin, errors included. Without them both plugins report the receiver as down.
- Keep the routes upstream's plugin calls: `GET /`, `POST /open`, which focuses the export in the app, and `GET /pick-folder`, which replies `{error}` and opens no dialog.
- Make new wire fields additive and optional. Grouping never depends on them.
- Bind both `127.0.0.1` and `::1`, because `localhost` can resolve to either. `EADDRINUSE` on either releases both and shows the conflict.
- Persist with atomic JSON writes, not SQLite, until a scan is measurably slow.

## Where complexity belongs

The plan is a pnpm monorepo:

- **`packages/export-contract`** owns the wire contract, the only code both apps share. Its root export holds constants with no imports. A parser subpath holds the schema and the types derived from it, which desktop uses on hostile input.
- **`apps/figma-plugin`** owns Figma Plugin API details.
  - Ship one classic-script `code.js` and one self-contained `ui.html`, and post from the UI iframe. Keep `import(` text out of `code.js`, even in strings.
  - Import root constants, and parser types through `import type` only, so the plugin stays free of the schema runtime.
  - Omit `fileKey` when Figma gives none. A file name never travels as a key.
  - Present the app-managed workflow. The library chooses where exports go, so the plugin has no folder field and no Browse action.
  - Style with plain CSS and Figma's theme variables.
- **`apps/desktop`** is Electron, React, StyleX, and Vite+, with three processes:
  - The receiver owns the HTTP listener, parsing, decoding, hashing, and staged writes.
  - Main owns the library and is the only committer.
  - The renderer renders state and sends commands.

Anything crossing process boundaries should use explicit typed contracts.

Workspace config, dependencies, and the contract are shared. Change one in its own small PR, merged before the work that needs it. Parallel work stays inside its own directory.

## Taste

- Complexity belongs at adapter boundaries. Keep orchestration boring.
- Idle should actually mean idle. The app stays resident in the menu bar.
- Prefer explicit states over combinations of unrelated booleans.
- Prefer inferred types and avoid `any`.
- Comments explain intent, constraints, and usage, not line-by-line behavior.
