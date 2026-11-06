# Upstream wire facts at 10c46ed

Pin is `10c46edd83cc40a3f6087ff121b3c1ffc044208c` (2026-10-29). GitHub reports no licence. Everything here is a restatement in our own words. Tags: **[V]** = VERIFIED-AT-10c46ed, read from source at the pin. **[P]** = FROM-PRIOR-RESEARCH, from the FIGMA-DROP-FOUNDATION thread and not re-run. **[I]** = inference from the Fetch/CORS spec, not observed. No fact here was observed in a real Figma client.

## POST /sync request

One JSON object per export. "Always" means upstream's plugin always sends it. No field is validated by the server except `node`. [V]

| Field           | Type   | Sent                  | Encoding and meaning                                                                  | Server use                                            |
| --------------- | ------ | --------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `outputDir`     | string | always, may be `""`   | Trimmed plugin text field. Blank does not block export                                | Base directory                                        |
| `fileKey`       | string | always, non-empty     | See identity below                                                                    | Directory name, `meta.json`                           |
| `fileName`      | string | always, may be `""`   | `figma.root.name`                                                                     | `meta.json`                                           |
| `nodeId`        | string | always                | Figma node id, such as `123:456`                                                      | Folder fallback, `meta.json`                          |
| `nodeName`      | string | always                | Layer name, untrusted                                                                 | Folder name, `meta.json`, HTML title                  |
| `folderName`    | string | batch collisions only | See batch section                                                                     | Folder name, wins over `nodeName`. Not in `meta.json` |
| `exportedAt`    | string | always                | ISO 8601 UTC from `toISOString()`, new per attempt                                    | `meta.json`, server clock if absent                   |
| `summary`       | object | always                | See below                                                                             | Copied whole into `meta.json`                         |
| `node`          | object | always                | Serialized tree                                                                       | Only required field, written to `node.json`           |
| `components`    | array  | always, may be `[]`   | See below                                                                             | `figma-components.json`, count                        |
| `remoteMasters` | array  | always, may be `[]`   | Node trees of the same shape as `node`. Empty when the plugin's resolve option is off | `remote-masters.json`, count                          |
| `variables`     | object | only if any           | `{collections, tokens}`                                                               | `variables.json`, counts                              |
| `styles`        | object | only if any           | `{styles}`                                                                            | `styles.json`, count                                  |
| `svg`           | string | when produced         | Plain UTF-8 SVG text, not base64, not a data URL                                      | `preview.svg`, `preview.html`                         |
| `png`           | string | when produced         | Bare base64 with no `data:` prefix                                                    | `preview.png`                                         |
| `assets`        | array  | if non-empty          | `{name, base64}`, bare base64                                                         | Files in `preview.assets/`                            |
| `images`        | array  | if non-empty          | `{imageHash, name, base64}`, bare base64                                              | Files in `preview.assets/`. `imageHash` is not read   |

Absent optional fields are omitted, never `null`. Unknown fields are ignored. [V]

- **`node`.** Open object. Known keys are `id`, `name`, `type`, optional `truncated` (boolean), optional `children` (same shape), and optional `styledTextSegments` (`[{characters, start, end, textStyleId?, fillStyleId?}]`). Other keys are copied from Figma, and Figma's mixed sentinel becomes the string `"MIXED"`. The server checks only that it is a non-null object, so an array passes. [V]
- **`summary`.** `target {id, name, type}`, `totalNodes`, `nodeTypes` (map), `textLayerCount`, `textSamples` (strings), `components {total, local, remote}`, `sets [{name, axes}]`, `remoteMastersResolved`, `remoteMasterErrors [{name, error}]`, `truncated`, `truncatedAt` (number or null), `preview {svg, png, svgSkipped}`. Optional are `variables {collections, tokens}`, `styles {paint, text, effect, grid}`, and `imageAssets`. The plugin UI reads `totalNodes` and `components.total` from its local copy. [V]
- **`components[]`.** `id`, `name`, `key` (string or null), `type`, `description`, `remote`, `componentSetId` (string or null). Optional are `variantValues`, `masterName`, `setName`, `setKey`, `variantProperties`, `componentPropertyDefinitions`, `masterError`. [V]
- **`variables`.** `collections[]` has `id`, `name`, `key`, `remote`, `defaultModeId`, `modes [{modeId, name}]`. `tokens[]` has `id`, `name`, `key`, `remote`, `resolvedType`, `description`, `collectionId`, `collectionName`, optional `scopes`, `valuesByMode`. A mode value is a primitive, `{hex, rgba {r, g, b, a}}`, or `{alias, name}`. [V]
- **`styles.styles[]`.** `id`, `key`, `name`, `remote`, `description`, optional `boundVariables`, and `type` of `PAINT` (`paints`), `TEXT` (`text`), `EFFECT` (`effects`), or `GRID` (`layoutGrids`). [V]
- **Server shape assumptions.** A missing `variables.tokens`, `variables.collections`, or `styles.styles`, or a non-string `assets[].name`, throws after the folder is created and yields a 500. Base64 is decoded leniently with no validation. [V]
- **When previews are missing.** `svg` is omitted when the node has no export method, the tree exceeds 6000 nodes (`summary.preview.svgSkipped` is true), or the Figma export throws. `png` is omitted on the same conditions, except that it has no node limit. So a bundle can have neither. PNG is scale 2, or width-constrained to 2048 when the node is wider than 2048. [V]
- **SVG rewriting.** Before sending, the plugin moves base64 `data:image/...` values in `href` and `xlink:href` into `assets` and rewrites each reference to the relative `preview.assets/<name>`. Identical data dedupes to one file. Anything else in the SVG, scripts included, passes through. [V]
- **Asset names.** Names are `img-<n>.<png|jpg|gif|bin>` for SVG rasters, `<name>.<key>.svg` for vector icons (`-2`, `-3` before `.svg` on a clash), and `<imageHash>.<png|jpg|gif|webp>` for `images`, with the extension sniffed from magic bytes and `png` as default. A `.svg` suffix marks an icon. [V]

### File identity

The plugin computes `fileKey` in this order. A read of `figma.fileKey` that throws counts as absent. [V]

1. `figma.fileKey`, if it is a non-empty string.
2. Otherwise `figma.root.name`, if non-empty.
3. Otherwise the literal `"current"`.

Resulting wire forms, with no fallback flag and no other identity field: [V]

| Form             | `fileKey`         | `fileName` | Meaning         |
| ---------------- | ----------------- | ---------- | --------------- |
| Real             | Figma key         | file name  | Stable identity |
| Name fallback    | equals `fileName` | non-empty  | No identity     |
| Literal fallback | `"current"`       | `""`       | No identity     |

- The plugin never sends a missing or empty `fileKey`. The server tolerates both, writing `null` to `meta.json` and using directory `unknown-file`. [V]
- A file literally named `current` with no key takes the name fallback form. [V]
- The wire has no page, branch, team, project, version, user, schema, or batch field. [V]
- `figma.fileKey` needs the private plugin API flag, and Figma documents that flag as covering local development plugins. A branch has its own key, and a duplicate is a new file. [P]

## POST /sync responses

All bodies are JSON. [V]

| Case                                                       | Status | Body                                             |
| ---------------------------------------------------------- | ------ | ------------------------------------------------ |
| Written                                                    | 200    | `{ok: true, path, preview?}`                     |
| Unparseable JSON                                           | 400    | `{error}`                                        |
| `node` missing or not an object                            | 400    | `{error}`                                        |
| Blank, relative, missing, or non-directory output location | 400    | `{error}` containing `output folder` in any case |
| Any write failure                                          | 500    | `{error}`                                        |

- `path` is the absolute bundle directory. `preview` is the absolute path of `preview.html` if `svg` was sent, else `preview.png` if `png` was sent, else absent. [V]
- The plugin decides success by `res.ok` alone and never reads `ok` from the body. It parses the body tolerantly, so non-JSON becomes `{}`. It reads `path`, `preview`, and `error`. [V]
- A 2xx with no `path` still shows success, and the plugin substitutes a placeholder string for the folder path. In a batch, a missing `path` drops the Open folder button. [V]
- A rejected `fetch` means unreachable. The plugin shows a server-down banner, or a row reason in a batch. [V]
- Any HTTP response turns the plugin's connection dot green, even a 500. [V, P]
- **Substring match.** Case-insensitive `output folder`, tested against `error` on non-2xx `/sync` only. For a single export, a match outlines the plugin's folder field and shows a folder-not-found banner whose action calls `GET /pick-folder`. A non-match shows a fixed generic failure banner with a retry, and `error` is not displayed. For a batch, the match has no effect and `error` is shown verbatim in that node's row. No other substring is matched anywhere. [V]

## Other routes

The plugin has exactly three network call sites. [V]

| Route              | Plugin calls it                            | Request                                        | Response                                                                                                        |
| ------------------ | ------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `POST /sync`       | On Export, once per node                   | As above                                       | As above                                                                                                        |
| `POST /open`       | User clicks an open button after an export | `{path}` with `Content-Type: application/json` | Upstream replies `{ok: true}`. Errors are `{error}` with 400, 404, 500, or 501                                  |
| `GET /pick-folder` | Browse button, or the folder banner action | No body, no custom headers                     | One of `{path}`, `{cancelled: true}`, `{error}`. Upstream uses 200 for the first two, and 500 or 501 for errors |
| `GET /`            | Never                                      | None                                           | Plain text. A human check only                                                                                  |

- `/open` receives one of three values, all derived from `/sync` replies. They are the single-export reply `path`, the reply `preview`, and for a batch **the parent directory of the first successful reply `path`**, computed client-side by stripping the last path segment. [V]
- On `/open` the plugin reads only `res.ok` and `error`. A non-2xx displays `error` verbatim in its status line. [V]
- On `/pick-folder` the plugin ignores the status code. `path` fills the folder field, `cancelled` clears the status silently, and anything else displays `error` or a fixed fallback. [V]
- The base URL is the endpoint field with a trailing `/sync` removed. [V]
- Upstream's `/open` runs the OS `open` on any existing absolute path, and `/pick-folder` shows a native dialog. These are the behaviours our app must not reproduce. [V]
- There is no health probe, and no other route exists. [V, P]

## Headers, limits, timeouts

- `POST /sync` and `POST /open` send `Content-Type: application/json` exactly. No auth or custom headers. Upstream's server never checks the content type. [V]
- A stand-in test found upstream's server parses `text/plain` POSTs that need no preflight. [P]
- `application/json` is not a CORS-safelisted type, so both POSTs preflight. `GET /pick-folder` needs no preflight, but the plugin reads its body, so it still needs an allow-origin header. Without one, `fetch` rejects and the plugin shows the server as down. [I]
- Upstream's CORS policy is any origin, with methods `GET`, `POST`, `OPTIONS`. It replies `Access-Control-Allow-Origin: *` on every route and error. [V]
- Preflight comes from Hono 4.13.1 (lockfile version). It replies 204 with `Access-Control-Allow-Methods` and echoes `Access-Control-Request-Headers` into `Access-Control-Allow-Headers`. Our preflight must allow `content-type`. [V]
- Origin evidence is a source comment saying the iframe has a `null` origin, and nothing stronger. Upstream's server never inspects Origin. [V] A hostile sandboxed iframe also sends `Origin: null`. [P]
- Upstream's server binds `127.0.0.1` only. The plugin reaches it as `localhost`. Node, curl, and Chrome tried `::1` first in prior measurement. [V, P]
- No body size limit exists on either side. Plugin-side caps limit size indirectly: 40000 serialized nodes (then `truncated`), 5000 nodes per remote master, 500 icons, 500 images. [V]
- Neither side sets a timeout. The plugin's `fetch` has no abort signal, and the batch loop waits for each POST to settle with no limit. [V]
- Dense structural JSON makes a size cap insufficient to bound parse time, which led to the 256 MiB cap plus parse deadline decision. [P]

## Plugin manifest

`name` is `Export to Repo`, `id` is `figma-export-local`, `api` is `1.0.0`, `main` is `code.js`, `ui` is `ui.html`, `editorType` is `["figma", "dev"]`, `documentAccess` is `dynamic-page`, `enablePrivatePluginApi` is `true`. `networkAccess.allowedDomains` is exactly `["http://localhost:3579"]`, with no `devAllowedDomains`. [V]

The default endpoint is `http://localhost:3579/sync`. The field is user-editable and persists in Figma `clientStorage` with `outputDir`, but the manifest pins the origin and port. An old `outputDir` keeps being sent after our app takes over. [V]

## On-disk bundle (upstream's writer)

Location is `<outputDir>/<fileKey segment>/<node segment>/`. The node segment comes from the first truthy of `folderName`, `nodeName`, `nodeId`. To form a segment, each run of characters outside ASCII letters, digits, `.`, `_`, `-` becomes one `-`, leading and trailing `-` are trimmed, and the result is cut to 80 characters. Empty falls back to `unknown-file`, `node`, `asset`, or `image`. `..` survives this. [V]

| File                       | Source                                                                | Written when      |
| -------------------------- | --------------------------------------------------------------------- | ----------------- |
| `node.json`                | `node`                                                                | Always            |
| `figma-components.json`    | `components`, or `[]`                                                 | Always            |
| `meta.json`                | Derived, below                                                        | Always            |
| `remote-masters.json`      | `remoteMasters`                                                       | Non-empty         |
| `variables.json`           | `variables`                                                           | Truthy            |
| `styles.json`              | `styles`                                                              | Truthy            |
| `preview.svg`              | `svg`, verbatim text                                                  | `svg` is a string |
| `preview.html`             | Generated page inlining `svg`, titled from `nodeName` or `nodeId`     | `svg` is a string |
| `preview.png`              | `png`, decoded                                                        | `png` is a string |
| `preview.assets/<segment>` | `assets` and `images`, decoded, names passed through the segment rule | Either non-empty  |

- JSON files use two-space indent. [V]
- **`meta.json` keys.** `fileKey`, `fileName`, `nodeId`, `nodeName` (each null if absent), `exportedAt`, `componentCount`, `remoteMasterCount`, `hasSvg`, `hasPng`, `assetCount`, `assetImageCount`, `assetSvgCount`, `hasPreviewHtml`, `hasVariables`, `variableCount`, `variableCollectionCount`, `hasStyles`, `styleCount`, `imageAssetCount`, `summary` (or null). It holds no `outputDir` or `folderName`. [V]
- Repeat exports overwrite in place, leave stale files behind, and write non-atomically, with `meta.json` written in parallel with the rest, so it does not mark completion. [V]
- The bundle consumer in upstream's skill reads `meta.json` for `nodeName`, `summary.truncated`, and the `has*` flags. Its review script adds extra files to a bundle. [V, P]

## Batch behaviour

- A batch is any selection of 2 or more nodes after dropping nodes nested inside another selected node. If that leaves one node, it takes the single path, with its different failure UI. [V]
- Order is Figma's selection array order. Exactly one POST is in flight per run. The next node is not serialized until the previous POST settles. A busy flag blocks a second run in that plugin window. [V]
- Each node gets one ordinary `POST /sync` with its own `exportedAt`. No batch id, index, or total crosses the wire. [V]
- Failure is best-effort per node, and later nodes proceed. A serialization failure sends no POST. The plugin never auto-retries. The single-export banner has a manual retry that rebuilds the payload. [V]
- `folderName` is set only for a later node whose name segment clashes in that run, as the segment plus `-` plus the last 4 alphanumerics of the node id, with `-2` and up on further clashes. The first node takes no `folderName`. So the value depends on selection order, and one node can send different values across runs. [V]
- `variables` and `styles` are built per node, so a batch resends them in every POST. [V]

## Gaps

- The real `Origin` value from a Figma client, on desktop and in the browser. Unverified, because no real plugin run has recorded it. [P]
- Whether the Figma client sends Private Network Access or Local Network Access preflight headers to loopback, or needs a reply to them. Upstream's server sends nothing specific for them. Not established.
- The value of `figma.fileKey` inside a branch, and on plans other than the ones Figma documents. [P]
- How often `figma.fileKey` is absent for a saved file, so how common the fallback forms are.
- Whether Figma's PNG and SVG output is byte-stable across repeat exports of unchanged content. This decides how often identical re-exports hash equal. [P]
- Whether collection and asset order in the payload is stable across runs. The code iterates in tree order, but Figma's APIs do not promise it.
- Real payload sizes. No sample exists, so the 256 MiB cap is a measured-memory decision, not a measured-traffic one.
- Concurrent POSTs from two Figma windows are possible by inference, since the busy flag is per window. Not observed.
