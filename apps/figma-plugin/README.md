# figma-drop Figma plugin

This development plugin sends the layers you select in Figma to the figma-drop desktop app on this Mac. Each layer goes out as one `POST http://localhost:3579/sync` in the figma-export payload format. The desktop app chooses where every export lands, so the plugin has no destination setting.

## Build the plugin

Run the build from this directory:

```sh
corepack pnpm run build
```

The build writes `dist/code.js` and `dist/ui.html`, then runs `scripts/check-artifacts.mjs`. That script fails the build if `code.js` is not one classic script, or if `ui.html` loads anything from outside itself.

## Run the plugin in Figma

You need the Figma desktop app. The browser version cannot import a development plugin.

1. Start figma-drop and turn its receiver on.
2. Open a design file in the Figma desktop app.
3. Open the main menu, then select **Plugins > Development > Import plugin from manifest**.
4. Select `apps/figma-plugin/manifest.json`.
5. Select one or more layers.
6. Open the main menu, then select **Plugins > Development > figma-drop**.
7. Click **Export layer**.

You import the manifest once. After a rebuild, close the plugin and run it again.

## What each state means

The line at the top of the panel reports the receiver. Export stays available in every receiver state, because the POST is the real test.

| Receiver line               | Meaning                                | What to do                                                         |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| Looking for figma-drop      | The plugin is calling `GET /`.         | Wait.                                                              |
| figma-drop is ready         | The last call or export got an answer. | Export.                                                            |
| figma-drop is not answering | Nothing answered on port 3579.         | Open figma-drop, turn its receiver on, then click **Check again**. |

A note appears when Figma gives no file key. The export still saves, but it goes to Unidentified in figma-drop and joins no project.

Each export gets a row, and rows run one at a time.

| Row      | Meaning                                                                |
| -------- | ---------------------------------------------------------------------- |
| Queued   | The row waits for the rows above it.                                   |
| Reading  | Figma is building the export.                                          |
| Sending  | The plugin is posting the export.                                      |
| Saved    | figma-drop confirmed the save. The row shows the path it replied with. |
| Failed   | The row shows the reason, including any `error` text from figma-drop.  |
| Not sent | An earlier row lost the receiver, so the plugin did not try this one.  |

A run continues after a layer fails to read, a rejected export, or a reply with no path. A run stops when figma-drop cannot be reached or does not reply within 65 seconds, because later exports would fail the same way.

When a run ends with failures, **Retry** sends the failed and not-sent rows again and leaves saved rows alone. **Done** clears the rows. A row rejected as too large is never retried, because figma-drop would reject it again. When only such rows remain, the panel offers neither button, and the rows stay until the next export. A timed-out export may already be saved. A retry converges on that entry when the export's bytes match, and adds a revision when they differ. Whether Figma's export bytes stay the same across calls is not known yet.

## What stays unverified

Nothing here has run in a real Figma client. The tests use a real HTTP server, and a sandboxed iframe in headless Chrome sent `Origin: null`, a preflight, and the POST to a stub receiver. That iframe stands in for Figma's.

Check these in the Figma desktop app:

- The `Origin` header from the plugin iframe. The receiver assumes `null`, and a different value shows up as a 403 or as "not answering".
- Whether Figma sends a private network preflight to `localhost`, and whether the receiver must answer it.
- Whether `figma.fileKey` reads at all in an imported development plugin. Figma's typings limit it to private organization plugins, and the manifest docs say `enablePrivatePluginApi` covers local development. If it reads `undefined`, every export goes to Unidentified, and the panel says so.
- What `figma.fileKey` returns in a branch, a draft, and an unsaved file.
- Whether Figma's export bytes stay the same across calls, which decides whether a retry converges.
- Whether Figma accepts the string `id` in `manifest.json` at import.
- Whether Figma enforces `allowedDomains` on an imported development plugin.
- Whether Figma's iframe runs the inlined `type="module"` script.
- Whether every `--figma-color-*` variable in `src/ui.css` exists in both themes. Light and dark were checked with stand-in values.
- Whether the plugin behaves the same in Dev Mode, and what happens to a run when the plugin window closes.
