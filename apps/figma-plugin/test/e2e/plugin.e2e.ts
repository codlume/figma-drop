import {
  allowedHostHeaders,
  CONTRACT_VERSION,
  JSON_CONTENT_TYPE,
} from '@figma-drop/export-contract';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vite-plus/test';
import type { FakeFigma, FakeFigmaOptions } from '../../src/sandbox/testing/fake-figma.ts';
import { type Chrome, launchChrome } from './chrome.ts';
import {
  CARD_SVG_ON_THE_WIRE,
  createFigmaFile,
  createProfileCard,
  FILE_KEY,
  FILE_NAME,
  ICON_SVG,
  IMAGE_BASE64,
  IMAGE_HASH,
  LOCAL_ICON_KEY,
  PIXEL_BASE64,
  REMOTE_BUTTON_KEY,
  SURFACE_STYLE_ID,
  SURFACE_VARIABLE_ID,
} from './fixture.ts';
import { openPlugin, type PanelSnapshot } from './plugin.ts';
import { writeSamplePayload } from './proof.ts';
import { refused, saved, savedPath, SyntheticReceiver } from './receiver.ts';

const HUNG_BUDGET_MS = 65_000;

let chrome: Chrome;

beforeAll(async () => {
  chrome = await launchChrome();
});

afterAll(async () => {
  await chrome.stop();
});

async function startedReceiver() {
  const receiver = await SyntheticReceiver.started();
  onTestFinished(() => receiver.stop());
  return receiver;
}

async function stoppedReceiver() {
  const receiver = await SyntheticReceiver.stopped();
  onTestFinished(() => receiver.stop());
  return receiver;
}

async function open(fake: FakeFigma, receiver: SyntheticReceiver) {
  const plugin = await openPlugin({ chrome, fake, port: receiver.port });
  onTestFinished(() => plugin.close());
  return plugin;
}

const online = (panel: PanelSnapshot) => panel.receiver.status === 'online';
const offline = (panel: PanelSnapshot) => panel.receiver.status === 'offline';
const exportable = (panel: PanelSnapshot) => panel.primary.disabled === false;
const finished = (panel: PanelSnapshot) => panel.notice !== null;
const rowLabels = (panel: PanelSnapshot) => panel.rows.map(({ name, label }) => [name, label]);

function batchOf(count: number) {
  const file = createFigmaFile();
  const layers = ['Header', 'Body', 'Footer', 'Sidebar']
    .slice(0, count)
    .map((name, index) => file.frame(`1:${index + 1}`, name));
  file.fake.select(layers);
  return { ...file, layers };
}

describe('single export', () => {
  it('delivers the whole payload and shows the receipt path', async ({ annotate }) => {
    const receiver = await startedReceiver();
    const file = createFigmaFile();
    file.fake.select([createProfileCard(file)]);
    const plugin = await open(file.fake, receiver);

    const ready = await plugin.until('online with a target', (p) => online(p) && exportable(p));
    expect(ready.selection).toEqual({ title: 'Profile Card', detail: 'Frame' });
    expect(ready.primary.label).toBe('Export layer');
    expect(ready.unidentified).toBeNull();

    await plugin.click('#primary');
    const panel = await plugin.until('run finished', finished);

    expect(panel.rows).toEqual([
      { name: 'Profile Card', state: 'saved', label: 'Saved', detail: savedPath('10:1') },
    ]);
    expect(panel.notice).toEqual({ tone: 'success', text: 'Saved to figma-drop.' });
    expect(JSON.stringify(panel)).not.toMatch(/folder|browse/i);

    expect(receiver.exports).toHaveLength(1);
    const post = receiver.exports[0]!;
    const { payload } = post;

    expect(post.method).toBe('POST');
    expect(post.path).toBe('/sync');
    expect(post.headers['content-type']).toBe(JSON_CONTENT_TYPE);
    expect(allowedHostHeaders(receiver.port)).toContain(post.headers.host);
    const preflight = receiver.requests.find(({ method }) => method === 'OPTIONS');
    expect(preflight?.headers['access-control-request-method']).toBe('POST');
    expect(preflight?.headers['access-control-request-headers']).toBe('content-type');

    expect(post.identity).toEqual({ kind: 'file', fileKey: FILE_KEY });
    expect(payload).toMatchObject({
      fileKey: FILE_KEY,
      fileName: FILE_NAME,
      nodeId: '10:1',
      nodeName: 'Profile Card',
      contractVersion: CONTRACT_VERSION,
    });
    for (const absent of ['batchId', 'outputDir', 'folderName']) {
      expect(JSON.parse(post.body)).not.toHaveProperty(absent);
    }
    expect(new Date(payload.exportedAt ?? '').toISOString()).toBe(payload.exportedAt);

    expect(payload.node).toMatchObject({
      id: '10:1',
      type: 'FRAME',
      fillStyleId: SURFACE_STYLE_ID,
      boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: SURFACE_VARIABLE_ID }] },
      children: [
        { id: '10:2', type: 'TEXT', characters: 'Ada Example' },
        { id: '10:3', type: 'VECTOR' },
        { id: '10:4', type: 'RECTANGLE', fills: [{ type: 'IMAGE', imageHash: IMAGE_HASH }] },
        { id: '10:5', type: 'INSTANCE', mainComponentKey: LOCAL_ICON_KEY },
        { id: '10:6', type: 'INSTANCE', mainComponentKey: REMOTE_BUTTON_KEY },
      ],
    });
    expect(payload.summary).toEqual({
      target: { id: '10:1', name: 'Profile Card', type: 'FRAME' },
      totalNodes: 8,
      nodeTypes: { FRAME: 1, TEXT: 2, VECTOR: 2, RECTANGLE: 1, INSTANCE: 2 },
      textLayerCount: 2,
      textSamples: ['Ada Example', 'Follow'],
      components: { total: 2, local: 1, remote: 1 },
      sets: [],
      remoteMastersResolved: 1,
      remoteMasterErrors: [],
      variables: { collections: 1, tokens: 1 },
      styles: { paint: 1, text: 0, effect: 0, grid: 0 },
      imageAssets: 1,
      truncated: false,
      truncatedAt: null,
      preview: { svg: true, png: true, svgSkipped: false },
    });
    expect(payload.components).toEqual([
      {
        id: '20:1',
        name: 'Icon/Close',
        key: LOCAL_ICON_KEY,
        type: 'COMPONENT',
        description: '',
        remote: false,
        componentSetId: null,
      },
      {
        id: '30:1',
        name: 'Library Button',
        key: REMOTE_BUTTON_KEY,
        type: 'COMPONENT',
        description: '',
        remote: true,
        componentSetId: null,
        masterName: 'Library Button',
      },
    ]);
    expect(payload.remoteMasters).toMatchObject([
      {
        id: '30:1',
        type: 'COMPONENT',
        children: [{ id: '30:2', type: 'TEXT', characters: 'Go' }],
      },
    ]);
    expect(payload.variables).toMatchObject({
      collections: [{ id: 'VariableCollectionId:1:1', name: 'Theme' }],
      tokens: [
        {
          id: SURFACE_VARIABLE_ID,
          name: 'color/surface',
          valuesByMode: { Light: { hex: '#ffffff', rgba: { r: 1, g: 1, b: 1, a: 1 } } },
        },
      ],
    });
    expect(payload.styles).toMatchObject({
      styles: [{ id: SURFACE_STYLE_ID, name: 'Surface/Card', type: 'PAINT' }],
    });

    expect(payload.svg).toBe(CARD_SVG_ON_THE_WIRE);
    expect(payload.png).toBe(PIXEL_BASE64);
    expect(payload.assets).toEqual([
      { name: 'img-0.png', base64: PIXEL_BASE64 },
      {
        name: `Icon-Close.${LOCAL_ICON_KEY}.svg`,
        base64: Buffer.from(ICON_SVG).toString('base64'),
      },
    ]);
    expect(payload.images).toEqual([
      { imageHash: IMAGE_HASH, name: `${IMAGE_HASH}.png`, base64: IMAGE_BASE64 },
    ]);

    writeSamplePayload(payload);
    await annotate(`Chrome ${chrome.majorVersion} headless, sandboxed srcdoc iframe`, 'fact');
    await annotate(
      `Origin on POST /sync: ${post.headers.origin} (Chrome stand-in, not a Figma iframe)`,
      'fact',
    );
    await annotate(`Origin on the preflight: ${preflight?.headers.origin}`, 'fact');
  });
});

describe('a file with no key', () => {
  it.each<[string, FakeFigmaOptions['fileKey']]>([
    ['undefined', undefined],
    ['empty', ''],
    ['a throwing read', new Error('private plugin API is off')],
  ])('goes to Unidentified when figma.fileKey is %s', async (_label, fileKey) => {
    const receiver = await startedReceiver();
    const file = createFigmaFile({ fileKey, fileName: 'Untitled' });
    file.fake.select([file.frame('1:1', 'Hero')]);
    const plugin = await open(file.fake, receiver);

    const ready = await plugin.until('online with a target', (p) => online(p) && exportable(p));
    expect(ready.unidentified).toContain('Unidentified in figma-drop');

    await plugin.click('#primary');
    const panel = await plugin.until('run finished', finished);

    expect(panel.rows[0]?.state).toBe('saved');
    expect(receiver.exports).toHaveLength(1);
    const post = receiver.exports[0]!;
    expect(JSON.parse(post.body)).not.toHaveProperty('fileKey');
    expect(post.payload.fileName).toBe('Untitled');
    expect(post.identity).toEqual({ kind: 'unidentified', claimedKey: null });
  });

  it('keeps two files with one name unidentified, never sharing a key', async () => {
    const receiver = await startedReceiver();
    for (const nodeId of ['1:1', '2:1']) {
      const file = createFigmaFile({ fileKey: undefined, fileName: 'Untitled' });
      file.fake.select([file.frame(nodeId, 'Hero')]);
      const plugin = await open(file.fake, receiver);
      await plugin.until('online with a target', (p) => online(p) && exportable(p));
      await plugin.click('#primary');
      await plugin.until('run finished', finished);
    }

    expect(receiver.nodeIdsPosted).toEqual(['1:1', '2:1']);
    for (const post of receiver.exports) {
      expect(JSON.parse(post.body)).not.toHaveProperty('fileKey');
      expect(post.identity).toEqual({ kind: 'unidentified', claimedKey: null });
    }
  });
});

describe('batch', () => {
  it('sends one POST at a time, keeps order, and retries only the rejected node', async () => {
    const receiver = await startedReceiver();
    const { fake } = batchOf(3);
    receiver.hold();
    receiver.reply = (post) =>
      post.payload.nodeId === '1:2' ? refused(500, 'Synthetic disk is full.') : saved(post);
    const plugin = await open(fake, receiver);

    const ready = await plugin.until('online with targets', (p) => online(p) && exportable(p));
    expect(ready.primary.label).toBe('Export 3 layers');
    expect(ready.selection.title).toBe('3 layers selected');

    await plugin.click('#primary');
    for (const position of [1, 2, 3]) {
      await receiver.posts(position);
      const panel = await plugin.until(
        `row ${position} sending`,
        (p) => p.rows[position - 1]?.state === 'sending',
      );
      expect(receiver.exports).toHaveLength(position);
      expect(panel.primary).toEqual({ label: `Exporting ${position} of 3`, disabled: true });
      receiver.release();
    }
    const panel = await plugin.until('run finished', finished);

    expect(receiver.maxPostsInFlight).toBe(1);
    expect(receiver.nodeIdsPosted).toEqual(['1:1', '1:2', '1:3']);
    expect(panel.rows).toEqual([
      { name: 'Header', state: 'saved', label: 'Saved', detail: savedPath('1:1') },
      { name: 'Body', state: 'failed', label: 'Failed', detail: 'Synthetic disk is full.' },
      { name: 'Footer', state: 'saved', label: 'Saved', detail: savedPath('1:3') },
    ]);
    expect(panel.notice).toEqual({
      tone: 'warning',
      text: '2 of 3 saved. See each row for the reason, then retry.',
    });
    expect(panel.primary).toEqual({ label: 'Retry 1 layer', disabled: false });

    receiver.reply = saved;
    receiver.release();
    await plugin.click('#primary');
    const retried = await plugin.until('all saved', (p) => p.notice?.tone === 'success');

    expect(receiver.nodeIdsPosted).toEqual(['1:1', '1:2', '1:3', '1:2']);
    expect(retried.notice?.text).toBe('All 3 saved to figma-drop.');
    expect(retried.rows.map(({ detail }) => detail)).toEqual(
      ['1:1', '1:2', '1:3'].map((id) => savedPath(id)),
    );
  });
});

describe('receiver down', () => {
  it('shows the offline state, then Check again goes online', async () => {
    const receiver = await stoppedReceiver();
    const { fake } = batchOf(1);
    const plugin = await open(fake, receiver);

    const down = await plugin.until('offline', offline);
    expect(down.receiver).toEqual({
      status: 'offline',
      text: 'figma-drop is not answering',
      hint: 'Open figma-drop and turn its receiver on.',
    });
    expect(down.checkAgain).toBe('Check again');

    await receiver.start();
    await plugin.click('#check-again');
    const up = await plugin.until('online', online);

    expect(up.receiver).toEqual({
      status: 'online',
      text: 'figma-drop is ready',
      hint: null,
    });
    expect(up.checkAgain).toBeNull();
  });

  it('fails an export while down, then Retry saves it', async () => {
    const receiver = await stoppedReceiver();
    const { fake } = batchOf(1);
    const plugin = await open(fake, receiver);
    await plugin.until('offline with a target', (p) => offline(p) && exportable(p));

    await plugin.click('#primary');
    const failed = await plugin.until('run finished', finished);

    expect(failed.rows).toEqual([
      {
        name: 'Header',
        state: 'failed',
        label: 'Failed',
        detail: 'figma-drop could not be reached.',
      },
    ]);
    expect(failed.notice).toEqual({
      tone: 'danger',
      text: 'Nothing was saved. Open figma-drop, turn its receiver on, then retry.',
    });
    expect(failed.primary).toEqual({ label: 'Retry 1 layer', disabled: false });

    await receiver.start();
    await plugin.click('#primary');
    const retried = await plugin.until('saved', (p) => p.notice?.tone === 'success');

    expect(retried.rows[0]?.detail).toBe(savedPath('1:1'));
    expect(retried.receiver.status).toBe('online');
    expect(receiver.nodeIdsPosted).toEqual(['1:1']);
  });
});

describe('connection lost mid-batch', () => {
  it('fails the row in flight, marks the rest not sent, and posts nothing further', async () => {
    const receiver = await startedReceiver();
    const { fake } = batchOf(3);
    receiver.reply = (post) => (post.payload.nodeId === '1:2' ? { kind: 'crash' } : saved(post));
    const plugin = await open(fake, receiver);
    await plugin.until('online with targets', (p) => online(p) && exportable(p));

    await plugin.click('#primary');
    const panel = await plugin.until('run finished', finished);

    expect(rowLabels(panel)).toEqual([
      ['Header', 'Saved'],
      ['Body', 'Failed'],
      ['Footer', 'Not sent'],
    ]);
    expect(panel.rows[1]?.detail).toBe('figma-drop could not be reached.');
    expect(panel.receiver.status).toBe('offline');
    expect(panel.notice).toEqual({
      tone: 'warning',
      text: '1 of 3 saved. Open figma-drop, turn its receiver on, then retry.',
    });
    expect(panel.primary.label).toBe('Retry 2 layers');
    expect(receiver.nodeIdsPosted).toEqual(['1:1', '1:2']);
  });
});

describe('replies that are not a save', () => {
  it('shows 400 and 413 errors, a non-JSON 500, and refuses to call a pathless 200 saved', async () => {
    const receiver = await startedReceiver();
    const { fake } = batchOf(4);
    const replies = {
      '1:1': refused(400, 'Synthetic refusal: bad export.'),
      '1:2': refused(413, 'Synthetic refusal: too large.'),
      '1:3': { kind: 'text', status: 500, body: '<html>not json</html>' },
      '1:4': { kind: 'json', status: 200, body: { ok: true } },
    } as const;
    receiver.reply = (post) => replies[post.payload.nodeId as keyof typeof replies];
    const plugin = await open(fake, receiver);
    await plugin.until('online with targets', (p) => online(p) && exportable(p));

    await plugin.click('#primary');
    const panel = await plugin.until('run finished', finished);

    expect(rowLabels(panel)).toEqual([
      ['Header', 'Failed'],
      ['Body', 'Failed'],
      ['Footer', 'Failed'],
      ['Sidebar', 'Failed'],
    ]);
    expect(panel.rows.map(({ detail }) => detail)).toEqual([
      'Synthetic refusal: bad export.',
      'Synthetic refusal: too large.',
      'figma-drop could not save this export (HTTP 500).',
      `Something answered on port ${receiver.port} without confirming a save. Check that figma-drop is the app using that port.`,
    ]);
    expect(panel.notice).toEqual({
      tone: 'danger',
      text: 'Nothing was saved. See each row for the reason, then retry.',
    });
    expect(panel.receiver.status).toBe('online');
    expect(panel.primary.label).toBe('Retry 4 layers');
    expect(receiver.nodeIdsPosted).toEqual(['1:1', '1:2', '1:3', '1:4']);

    await plugin.click('#dismiss');
    const dismissed = await plugin.until('rows cleared', (p) => p.rows.length === 0);
    expect(dismissed.primary).toEqual({ label: 'Export 4 layers', disabled: false });
  });
});

describe('hung receiver', () => {
  it(
    'times out at the real budget, keeps the rest unsent, and a retry saves',
    { timeout: HUNG_BUDGET_MS + 25_000 },
    async ({ annotate }) => {
      const receiver = await startedReceiver();
      const { fake } = batchOf(2);
      receiver.reply = () => ({ kind: 'hang' });
      const plugin = await open(fake, receiver);
      await plugin.until('online with targets', (p) => online(p) && exportable(p));

      const startedAt = performance.now();
      await plugin.click('#primary');
      await receiver.posts(1);
      const panel = await plugin.until('run finished', finished, HUNG_BUDGET_MS + 10_000);
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeGreaterThanOrEqual(HUNG_BUDGET_MS);
      expect(elapsedMs).toBeLessThan(HUNG_BUDGET_MS + 2_000);
      expect(rowLabels(panel)).toEqual([
        ['Header', 'Failed'],
        ['Body', 'Not sent'],
      ]);
      expect(panel.rows[0]?.detail).toBe(
        'figma-drop did not reply in time. This export may still have been saved.',
      );
      expect(panel.notice).toEqual({
        tone: 'danger',
        text: 'Nothing was saved. figma-drop stopped replying. Check that it is running, then retry. Retrying will not save a duplicate.',
      });
      expect(receiver.nodeIdsPosted).toEqual(['1:1']);

      receiver.reply = saved;
      await plugin.click('#primary');
      const retried = await plugin.until('all saved', (p) => p.notice?.tone === 'success');
      expect(retried.notice?.text).toBe('All 2 saved to figma-drop.');
      expect(receiver.nodeIdsPosted).toEqual(['1:1', '1:1', '1:2']);

      console.info(`hung receiver: row failed after ${Math.round(elapsedMs)} ms`);
      await annotate(`row failed after ${Math.round(elapsedMs / 1000)} s, real budget`, 'fact');
    },
  );
});

describe('hostile text', () => {
  it('renders a layer name and an error reply as text, and no script runs', async () => {
    const receiver = await startedReceiver();
    const attack = (by: string) =>
      `<img src=x onerror="fetch('http://localhost:${receiver.port}/pwned?by=${by}',{mode:'no-cors'})">`;
    const layerName = attack('layer-name');
    const script = (by: string) =>
      `<script>fetch('http://localhost:${receiver.port}/pwned?by=${by}',{mode:'no-cors'})</script>`;
    const errorText = `${attack('error-reply')}${script('error-reply-script')}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${script('svg')}</svg>`;

    const file = createFigmaFile();
    file.fake.select([
      file.fake.node('FRAME', {
        id: '1:1',
        name: layerName,
        renders: { SVG: new TextEncoder().encode(svg) },
      }),
    ]);
    receiver.reply = () => refused(500, errorText);
    const plugin = await open(file.fake, receiver);

    const ready = await plugin.until('online with a target', (p) => online(p) && exportable(p));
    expect(ready.selection.title).toBe(layerName);

    await plugin.click('#primary');
    const panel = await plugin.until('run finished', finished);

    expect(panel.rows).toEqual([
      { name: layerName, state: 'failed', label: 'Failed', detail: errorText },
    ]);
    expect(await plugin.count('img')).toBe(0);
    expect(await plugin.count('script')).toBe(1);
    expect(receiver.exports[0]?.payload.nodeName).toBe(layerName);
    expect(receiver.exports[0]?.payload.svg).toBe(svg);

    await plugin.parseAsMarkup(attack('control'));
    const attacks = () => receiver.requests.filter(({ path }) => path.startsWith('/pwned'));
    await receiver.until('the control attack', () => attacks().length > 0);
    expect(attacks().map(({ path }) => path)).toEqual(['/pwned?by=control']);
  });

  it('carries awkward layer names verbatim', async () => {
    const receiver = await startedReceiver();
    const names = ['..', 'Zażółć gęślą jaźń 日本語', 'x'.repeat(300)];
    const file = createFigmaFile();
    file.fake.select(names.map((name, index) => file.frame(`1:${index + 1}`, name)));
    const plugin = await open(file.fake, receiver);
    await plugin.until('online with targets', (p) => online(p) && exportable(p));

    await plugin.click('#primary');
    const panel = await plugin.until('run finished', finished);

    expect(panel.rows.map(({ name }) => name)).toEqual(names);
    expect(receiver.exports.map(({ payload }) => payload.nodeName)).toEqual(names);
  });
});

describe('the file changes under a run', () => {
  it('fails a deleted node and continues the batch', async () => {
    const receiver = await startedReceiver();
    const { fake, layers } = batchOf(3);
    const plugin = await open(fake, receiver);
    await plugin.until('online with targets', (p) => online(p) && exportable(p));

    fake.remove(layers[1]!);
    await plugin.click('#primary');
    const panel = await plugin.until('run finished', finished);

    expect(panel.rows).toEqual([
      { name: 'Header', state: 'saved', label: 'Saved', detail: savedPath('1:1') },
      {
        name: 'Body',
        state: 'failed',
        label: 'Failed',
        detail:
          'This layer could not be exported: This layer no longer exists. Select it again and retry.',
      },
      { name: 'Footer', state: 'saved', label: 'Saved', detail: savedPath('1:3') },
    ]);
    expect(receiver.nodeIdsPosted).toEqual(['1:1', '1:3']);
  });

  it('keeps the run’s targets when the selection changes mid-run', async () => {
    const receiver = await startedReceiver();
    const { fake, frame } = batchOf(2);
    const other = frame('9:9', 'Other');
    receiver.hold();
    const plugin = await open(fake, receiver);
    await plugin.until('online with targets', (p) => online(p) && exportable(p));

    await plugin.click('#primary');
    await receiver.posts(1);
    fake.select([other]);
    fake.emit('selectionchange');
    const mid = await plugin.until('new selection shown', (p) => p.selection.title === 'Other');

    expect(rowLabels(mid)).toEqual([
      ['Header', 'Sending'],
      ['Body', 'Queued'],
    ]);

    receiver.release();
    await receiver.posts(2);
    receiver.release();
    const panel = await plugin.until('run finished', finished);

    expect(receiver.nodeIdsPosted).toEqual(['1:1', '1:2']);
    expect(rowLabels(panel)).toEqual([
      ['Header', 'Saved'],
      ['Body', 'Saved'],
    ]);
    expect(panel.primary).toEqual({ label: 'Export layer', disabled: false });
  });
});
