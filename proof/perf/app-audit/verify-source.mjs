// Integrated check of where a snapshot comes from, in the built app.
// A project folder is moved out of the library behind the app's back, then one export arrives.
// The export must show at once. The outside change must show after the window regains focus.
// usage: run.sh verify-source.mjs <appDir> <seedDir> <outJson>
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, SIDEBAR_COUNT, smallExport, waitUntil } from './rig.mjs';

const [appDir, seedDir, outJson] = process.argv.slice(2);
const app = await launch({
  appDir,
  seedDir,
  scratchRoot: process.env.AUDIT_SCRATCH,
  electron: process.env.ELECTRON,
});
const result = { app: appDir.split('/').pop(), errors: [] };
const rows = `[...document.querySelectorAll('[role=listbox][aria-label=Library] [role=option]')].map((r) => r.firstElementChild?.textContent ?? r.textContent)`;
const has = (page, name) =>
  page.evaluate(`${rows}.some((text) => text.startsWith(${JSON.stringify(name)}))`);

try {
  await app.receiverUp();
  const page = await app.page();
  await waitUntil(async () => (await page.evaluate(SIDEBAR_COUNT)) >= 1, 'library shown', 60_000);
  result.checkoutShownAtStart = await has(page, 'Checkout flow');

  const files = join(app.library, 'files');
  const checkout = readdirSync(files).find((name) => name.startsWith('checkout-flow-'));
  mkdirSync(join(app.scratch, 'outside'));
  renameSync(join(files, checkout), join(app.scratch, 'outside', checkout));

  const reply = await app.sync(smallExport(0));
  if (reply.status !== 200) result.errors.push(reply);
  await waitUntil(() => has(page, 'Bench File'), 'the export in the sidebar');
  result.checkoutShownAfterExport = await has(page, 'Checkout flow');

  await page.evaluate(`window.dispatchEvent(new Event('focus')), 0`);
  await waitUntil(
    async () => !(await has(page, 'Checkout flow')),
    'the outside change after focus',
  );
  result.checkoutShownAfterFocus = await has(page, 'Checkout flow');
  result.benchShownAfterFocus = await has(page, 'Bench File');
  page.close();
  await app.stop(true);

  const again = await launch({
    appDir,
    scratchRoot: process.env.AUDIT_SCRATCH,
    electron: process.env.ELECTRON,
    relaunchIn: app.scratch,
  });
  try {
    await again.receiverUp();
    const relaunched = await again.page();
    await waitUntil(
      async () => (await relaunched.evaluate(SIDEBAR_COUNT)) >= 1,
      'relaunch',
      60_000,
    );
    result.benchShownAfterRestart = await has(relaunched, 'Bench File');
    result.checkoutShownAfterRestart = await has(relaunched, 'Checkout flow');
    result.rowsAfterRestart = await relaunched.evaluate(SIDEBAR_COUNT);
    relaunched.close();
  } finally {
    await again.stop();
  }
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
  await app.stop();
}
writeFileSync(outJson, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
