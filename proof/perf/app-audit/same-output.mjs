// Fingerprints what a build shows for one seeded library, so two builds can be compared.
// usage: run.sh same-output.mjs <appDir> <seedDir> <outJson>
// Prints a hash of the snapshot (library root replaced by a token), a hash of the visible text of
// the window, and, after five exports, whether the memory snapshot equals the disk snapshot.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { launch, SIDEBAR_COUNT, smallExport, waitUntil } from './rig.mjs';

const [appDir, seedDir, outJson] = process.argv.slice(2);
const app = await launch({
  appDir,
  seedDir,
  scratchRoot: process.env.AUDIT_SCRATCH,
  electron: process.env.ELECTRON,
});
const result = { app: appDir.split('/').pop(), errors: [] };
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

try {
  await app.receiverUp();
  const page = await app.page();
  await waitUntil(async () => (await page.evaluate(SIDEBAR_COUNT)) >= 1, 'library shown', 60_000);
  const snapshot = await page.evaluate(`figmaDrop.library.getSnapshot().then(JSON.stringify)`);
  result.snapshotBytes = snapshot.length;
  result.snapshotHash = sha(snapshot.replaceAll(app.library, '<library>'));
  const text = await page.evaluate(`document.body.innerText`);
  result.windowTextHash = sha(
    text.replaceAll(app.library, '<library>').replaceAll(String(app.port), '<port>'),
  );
  result.windowTextChars = text.length;

  for (let i = 0; i < 5; i += 1) {
    const reply = await app.sync(smallExport(i));
    if (reply.status !== 200) result.errors.push(reply);
  }
  const pair = await page.evaluate(`(async () => {
    const held = JSON.stringify(await figmaDrop.library.getSnapshot('memory'));
    const rescanned = JSON.stringify(await figmaDrop.library.getSnapshot('disk'));
    return { same: held === rescanned, bytes: held.length };
  })()`);
  result.memoryEqualsDiskAfterExports = pair.same;
  page.close();
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  await app.stop();
}
writeFileSync(outJson, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
