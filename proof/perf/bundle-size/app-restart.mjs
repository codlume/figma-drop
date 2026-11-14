// Drives the built app under Electron: synthetic exports, the right project, a quit, a relaunch,
// and the same library after it. Prints a summary free of run-specific values, so the output of
// two builds can be diffed. Uses the build in apps/desktop, a scratch library, and a free port.
// usage: node app-restart.mjs <scratchDir>
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';

import {
  assert,
  freePort,
  launchApp,
  refusesConnection,
  stopTracked,
  waitUntil,
} from '../../shell/driver.mjs';

const scratch = await mkdtemp(join(process.argv[2], 'app-'));
const library = join(scratch, 'library');
const options = { userData: join(scratch, 'user-data'), library, port: await freePort() };
const { port } = options;

const exportBody = (overrides = {}) =>
  JSON.stringify({
    outputDir: '/tmp/ignored',
    fileKey: 'SyntheticKeyA1',
    fileName: 'Synthetic file',
    nodeId: '1:2',
    nodeName: 'Card',
    exportedAt: '2026-01-01T00:00:00.000Z',
    summary: { totalNodes: 1, truncated: false },
    node: { id: '1:2', name: 'Card', type: 'FRAME', revision: 'a' },
    components: [],
    remoteMasters: [],
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ...overrides,
  });
const revisionB = { node: { id: '1:2', name: 'Card', type: 'FRAME', revision: 'b' } };

async function post(body, origin = 'null') {
  const res = await fetch(`http://127.0.0.1:${port}/sync`, {
    method: 'POST',
    headers: { host: `localhost:${port}`, origin, 'content-type': 'application/json' },
    body,
  });
  return {
    status: res.status,
    allowOrigin: res.headers.get('access-control-allow-origin'),
    json: await res.json(),
  };
}

const snapshot = (page) => page.evaluate(`window.figmaDrop.library.getSnapshot()`);
const summarize = ({ state, projects, unidentified }) => ({
  state,
  projects: projects.map((project) => ({
    fileKey: project.fileKey,
    nodes: project.nodes.map((node) => `${node.figmaNodeId} x${node.revisions.length}`),
  })),
  unidentified: unidentified.length,
});
const listening = (app) =>
  waitUntil(
    async () => (await app.hook('receiverStatus()')).state === 'listening',
    'the receiver listening',
    60_000,
  );
const fileNamesOnDisk = async () =>
  (await readdir(library, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .toSorted()
    .join(',');
const quit = async (app, page) => {
  page.close();
  await app.hook(`clickTray('quit')`).catch(() => {});
  return app.exitWithin(15_000);
};

const out = {};
try {
  let app = launchApp(options);
  let page = await app.page();
  const pageErrors = await page.collectErrors();
  await app.waitForHooks();
  await listening(app);

  const first = await post(exportBody());
  assert(first.status === 200 && first.json.path.startsWith(`${library}${sep}`), 'first saved');
  const repeat = await post(exportBody({ exportedAt: '2026-02-02T00:00:00.000Z' }));
  const changed = await post(exportBody(revisionB));
  const otherFile = await post(exportBody({ fileKey: 'SyntheticKeyB2' }));
  const noKey = await post(exportBody({ fileKey: undefined, nodeId: '2:4' }));
  const badOrigin = await post(exportBody(), 'https://evil.example');
  out.replies = {
    first: [first.status, first.allowOrigin],
    repeatSamePath: repeat.json.path === first.json.path,
    changedNewPath: changed.status === 200 && changed.json.path !== first.json.path,
    otherFile: otherFile.status,
    noKey: noKey.status,
    badOrigin: [badOrigin.status, badOrigin.allowOrigin, badOrigin.json],
  };
  await waitUntil(async () => (await snapshot(page)).projects.length === 2, 'both projects shown');
  out.beforeRestart = summarize(await snapshot(page));
  out.filesBeforeRestart = await fileNamesOnDisk();
  out.pageErrors = pageErrors;
  out.quit = await quit(app, page);
  out.portClosedAfterQuit = await refusesConnection('127.0.0.1', port);

  app = launchApp(options);
  page = await app.page();
  await app.waitForHooks();
  await waitUntil(async () => (await snapshot(page)).state === 'ready', 'library after restart');
  await listening(app);
  out.afterRestart = summarize(await snapshot(page));
  out.filesAfterRestart = await fileNamesOnDisk();
  const sameAsLatest = await post(exportBody(revisionB));
  const revert = await post(exportBody());
  out.afterRestartReplies = {
    latestConverges: sameAsLatest.status === 200 && sameAsLatest.json.path === changed.json.path,
    revertAddsRevision:
      revert.status === 200 &&
      revert.json.path !== first.json.path &&
      revert.json.path !== changed.json.path,
  };
  await waitUntil(
    async () =>
      (await snapshot(page)).projects.some((project) =>
        project.nodes.some((node) => node.revisions.length === 3),
      ),
    'the revert shown',
  );
  out.afterRevert = summarize(await snapshot(page));
  out.secondQuit = await quit(app, page);
} finally {
  out.neededSigkill = await stopTracked();
  await rm(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 1));
