import { expect, it } from 'vite-plus/test';
import { fake } from './testing/installed-fake.ts';
import '../code.ts';

it('opens the themed UI, answers ui-ready, and follows selectionchange', async () => {
  expect(fake.shownUi).toEqual([
    { html: '<ui/>', options: { width: 320, height: 420, themeColors: true } },
  ]);

  fake.fromUi({ type: 'ui-ready' });
  await expect.poll(() => fake.posted.length).toBe(1);
  expect(fake.posted[0]).toEqual({ type: 'selection', targets: [], hasFileKey: true });

  fake.select([fake.node('FRAME', { id: '1:1', name: 'A' })]);
  fake.emit('selectionchange');
  expect(fake.posted[1]).toEqual({
    type: 'selection',
    targets: [{ id: '1:1', name: 'A', type: 'FRAME' }],
    hasFileKey: true,
  });

  fake.fromUi({ type: 'export-node', nodeId: '1:1' });
  await expect.poll(() => fake.posted.length).toBe(3);
  expect(fake.posted[2]).toMatchObject({ type: 'node-exported', nodeId: '1:1' });
});
