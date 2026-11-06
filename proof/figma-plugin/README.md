# Figma plugin end-to-end proof

This is a mocked run, not a real Figma export. No Figma client took part. The evidence shows that the built plugin artifacts work with each other, with a real HTTP server, and with the shared contract. It says nothing about how Figma itself behaves.

## Rerun the proof

You need macOS, Google Chrome in `/Applications`, and the Node version the repository uses. The suite never binds port 3579 and never touches `~/figma-drop`.

```sh
cd apps/figma-plugin
corepack pnpm run test:e2e
```

The script builds `dist/`, then runs `test/e2e/*.e2e.ts`. One scenario waits out the real 65 second budget, so a run takes about 90 seconds. A full run rewrites every file here. A run filtered with `-t` leaves `scenarios.txt` alone.

`corepack pnpm run test` does not run this suite.

## What is real and what is not

| Part                   | In this proof                                                                  |
| ---------------------- | ------------------------------------------------------------------------------ |
| `dist/code.js`         | Real, run in a `node:vm` context with no `TextDecoder`, `btoa`, `atob`, or DOM |
| `dist/ui.html`         | Real, with one change: the port number                                         |
| `parseExportPayload`   | Real, called on every received body                                            |
| `classifyFileIdentity` | Real, called on every received body                                            |
| HTTP, CORS, preflight  | Real, between Chrome and a `node:http` server on an ephemeral loopback port    |
| `figma` global         | Fake, from `src/sandbox/testing/fake-figma.ts`                                 |
| Plugin iframe          | Stand-in: `<iframe sandbox="allow-scripts">` with `srcdoc` in headless Chrome  |
| Figma's message relay  | Stand-in: CDP binding, then `postMessage` from the host page                   |
| Figma theme variables  | Stand-in values, written by hand in `test/e2e/plugin.ts`                       |
| Receiver               | Synthetic. It records requests and returns scripted replies                    |
| Design documents       | Synthetic fixtures in `test/e2e/fixture.ts`                                    |

## Limits of this evidence

- The `Origin` value in `scenarios.txt` comes from Chrome. A Figma plugin iframe may send something else.
- Exports come from the fake. Real `exportAsync` output, real `figma.fileKey` behavior in a branch or draft, and real variable and style data are unproven.
- `allowedDomains`, private network preflights, and Figma's handling of an inline `type="module"` script are unproven.
- The panel colors use stand-in values, so the screenshots do not show Figma's real palette.
- The synthetic receiver does not stage, commit, or write anything. A receipt path here is a scripted string, not a saved export.
- Clicks go to the iframe's own CDP target. They run Chrome's real input and hit testing inside the frame, and they do not cross a Figma host window.
- The port change also changes the port number in one error row, which then shows the test port.

## Files

- `scenarios.txt` lists each scenario's result from the test runner's own verdict, with the observed `Origin` and the hung-receiver duration.
- `sample-payload.json` is one received `POST /sync` body. Base64 and the timestamp are elided, and node trees keep only `id`, `name`, and `type`.
- `screenshots/` has the panel at 320 by 480, at 2x, in light and dark, for these states: no selection, ready, running, saved, partial failure, offline, and the Unidentified notice.
