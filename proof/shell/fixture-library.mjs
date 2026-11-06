import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';

import { assert, desktopDir } from './driver.mjs';

registerHooks({
  resolve(specifier, context, next) {
    const extensionless = specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier);
    return next(extensionless ? `${specifier}.ts` : specifier, context);
  },
});
const { createLibrary } = await import(join(desktopDir, 'src/library/index.ts'));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// Every file differs, so a copy that swaps two of them cannot pass a byte comparison.
export const BUNDLE = {
  'node.json': '{"id":"1:2","name":"Hero Card","type":"FRAME"}\n',
  'figma-components.json': '[{"key":"synthetic-component"}]\n',
  'meta.json': '{"fileName":"Synthetic File","nodeId":"1:2"}\n',
  'preview.png': PNG,
};

// Commits one synthetic export through the real library, and returns its bundle path.
export async function seedLibrary(root) {
  const library = await createLibrary({ root, trashItem: async () => {} });
  const stagingId = randomUUID();
  const bundle = join(library.stagingDir, stagingId, 'bundle');
  await mkdir(bundle, { recursive: true });
  for (const [name, bytes] of Object.entries(BUNDLE)) {
    await mkdir(dirname(join(bundle, name)), { recursive: true });
    await writeFile(join(bundle, name), bytes);
  }
  const result = await library.commit({
    stagingId,
    identity: { kind: 'file', fileKey: 'synthetic-key' },
    fileName: 'Synthetic File',
    figmaNodeId: '1:2',
    nodeName: 'Hero Card',
    contentHash: createHash('sha256').update('hero').digest('hex'),
    exportedAt: null,
  });
  assert(result.ok, `the fixture export commits, got ${JSON.stringify(result)}`);
  return result.path;
}
