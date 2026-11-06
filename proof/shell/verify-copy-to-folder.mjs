import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import {
  assert,
  clickAt,
  createLog,
  freePort,
  launchApp,
  repoDir,
  stopTracked,
  waitUntil,
} from './driver.mjs';
import { BUNDLE, seedLibrary } from './fixture-library.mjs';

// No desktop driver can click a native panel, so the stubbed run covers everything after the choice
// and the unstubbed run can only show the call staying pending. The window is long enough to outlast
// a stubbed reply by orders of magnitude, and a pending promise is the only evidence it gives.
const PENDING_WINDOW_MS = 3_000;
const QUIT_DEADLINE_MS = 4_000;
const COPY = 'Copy to folder';
const COPYING = 'Copying…';

const log = createLog();
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'figma-drop-copy-')));
const paths = { userData: join(scratch, 'user-data'), library: join(scratch, 'library') };
// An open panel starts in the user's home, so the run keeps it out of the real one.
const env = { HOME: scratch, CFFIXED_USER_HOME: scratch };
const destination = join(scratch, 'chosen folder');

async function step(label, run) {
  await run();
  log.write(`PASS ${label}`);
}

async function filesUnder(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .toSorted();
}

const buttonCenter = (label) => `(() => {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)});
  if (!button) return null;
  const { left, top, width, height } = button.getBoundingClientRect();
  return { x: left + width / 2, y: top + height / 2 };
})()`;

async function pressCopy(page) {
  const center = await waitUntil(
    () => page.evaluate(buttonCenter(COPY)),
    'the Copy to folder button',
  );
  await clickAt(page, center);
}

const answerDialogWith = (reply) => `(() => {
  const { dialog } = process.mainModule.require('electron');
  globalThis.proofDialogCalls ??= [];
  dialog.showOpenDialog = async (...args) => {
    globalThis.proofDialogCalls.push({ argumentCount: args.length, options: args.at(-1) });
    return ${JSON.stringify(reply)};
  };
})()`;

const statusText = (page) =>
  page.evaluate(
    `[...document.querySelectorAll('[role=status]')].map((n) => n.textContent).join(' | ')`,
  );

async function assertPlainBundle(copy, source) {
  const copied = await filesUnder(copy);
  const expected = await filesUnder(source);
  assert(
    JSON.stringify(copied) === JSON.stringify(expected),
    `copied ${copied.join(', ')}, source ${expected.join(', ')}`,
  );
  assert(expected.length === Object.keys(BUNDLE).length, `fixture files ${expected.join(', ')}`);
  assert(existsSync(join(dirname(source), 'receipt.json')), 'the revision holds a receipt');
  assert(!copied.some((name) => name.endsWith('receipt.json')), 'no receipt in the copy');
  for (const name of copied) {
    const [from, to] = await Promise.all([
      readFile(join(source, name)),
      readFile(join(copy, name)),
    ]);
    assert(from.equals(to), `${name} is byte-equal to the source`);
  }
}

async function quit(app) {
  await app.hook(`clickTray('quit')`).catch(() => {});
  const exit = await app.exitWithin(QUIT_DEADLINE_MS);
  assert(exit?.code === 0, `the app quits cleanly, got ${JSON.stringify(exit)}`);
}

async function main() {
  await mkdir(destination);
  const source = await seedLibrary(paths.library);
  const port = await freePort();

  let app = launchApp({ ...paths, port, env });
  let page = await app.page();
  await app.waitForHooks();
  await app.evaluateInMain(answerDialogWith({ canceled: false, filePaths: [destination] }));

  let firstCopy;
  await step('the real button copies into a new child of the chosen folder', async () => {
    await pressCopy(page);
    const status = await waitUntil(async () => {
      const text = await statusText(page);
      return text.includes('Copied to') && text;
    }, 'the Copied to message');
    const children = await readdir(destination);
    assert(children.length === 1, `one child, got ${children.join(', ')}`);
    firstCopy = join(destination, children[0]);
    assert(status.includes(firstCopy), `the window names the copy, got ${status}`);
    log.write(`  child folder "${children[0]}"`);
  });

  await step('main asked for a folder, attached to the window', async () => {
    const [call] = await app.evaluateInMain('globalThis.proofDialogCalls');
    assert(call.argumentCount === 2, `window and options, got ${call.argumentCount} arguments`);
    const wanted = ['openDirectory', 'createDirectory'];
    assert(
      JSON.stringify(call.options.properties) === JSON.stringify(wanted),
      `properties ${JSON.stringify(call.options.properties)}`,
    );
  });

  await step('the copy is a plain bundle, byte-equal, with no receipt', () =>
    assertPlainBundle(firstCopy, source),
  );

  await step('copying again adds a second child and leaves the first alone', async () => {
    const secondCopy = `${firstCopy} 2`;
    await pressCopy(page);
    await waitUntil(
      async () => (await statusText(page)).includes(secondCopy),
      'the window to name the second copy',
    );
    const children = (await readdir(destination)).map((name) => join(destination, name)).toSorted();
    assert(
      JSON.stringify(children) === JSON.stringify([firstCopy, secondCopy]),
      `exactly the two copies and no temp folder, got ${children.join(', ')}`,
    );
    await assertPlainBundle(firstCopy, source);
    await assertPlainBundle(secondCopy, source);
  });

  await step('cancel writes nothing and returns the button to idle', async () => {
    await waitUntil(() => page.evaluate(buttonCenter(COPY)), 'the idle button');
    await app.evaluateInMain(answerDialogWith({ canceled: true, filePaths: [] }));
    const before = (await app.evaluateInMain('globalThis.proofDialogCalls')).length;
    await pressCopy(page);
    await waitUntil(
      async () => (await app.evaluateInMain('globalThis.proofDialogCalls')).length === before + 1,
      'the cancelled dialog call',
    );
    await waitUntil(() => page.evaluate(buttonCenter(COPY)), 'the idle button after cancel');
    assert(!(await statusText(page)).includes('Copied to'), 'no copied message after cancel');
    assert((await readdir(destination)).length === 2, 'the chosen folder gained nothing');
  });

  await quit(app);

  log.write('UNSTUBBED: a fresh launch with dialog.showOpenDialog left alone');
  app = launchApp({ ...paths, port, env });
  page = await app.page();
  await app.waitForHooks();

  await step(
    'PENDING ONLY: the real call stays pending, and no panel click is proven',
    async () => {
      await pressCopy(page);
      await waitUntil(() => page.evaluate(buttonCenter(COPYING)), 'the busy button');
      const deadline = Date.now() + PENDING_WINDOW_MS;
      while (Date.now() < deadline) {
        assert(
          await page.evaluate(buttonCenter(COPYING)),
          'the call settled with no one answering',
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert((await readdir(destination)).length === 2, 'nothing was written');
      log.write(`  still pending after ${PENDING_WINDOW_MS} ms, with no new copy on disk`);
    },
  );

  await step('SIGTERM ends the app with that call still pending', async () => {
    process.kill(app.child.pid, 'SIGTERM');
    const exit = await app.exitWithin(QUIT_DEADLINE_MS);
    assert(exit?.code === 0, `exit ${JSON.stringify(exit)}`);
  });
}

let failure = null;
try {
  await main();
  log.write('ALL PASS');
} catch (error) {
  failure = error;
  log.write(`FAIL ${error.message}`);
} finally {
  const forced = await stopTracked();
  if (forced && !failure) {
    failure = new Error('a process outlived the run and needed SIGKILL');
    log.write(`FAIL ${failure.message}`);
  }
  await rm(scratch, { recursive: true, force: true });
  await writeFile(
    join(repoDir, 'proof/shell/verify-copy-to-folder.txt'),
    `${log.lines.join('\n')}\n`,
  );
}
process.exit(failure ? 1 : 0);
