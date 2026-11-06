import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vite-plus/test';
import type { FakeFigma, FakeFigmaOptions } from '../../src/sandbox/testing/fake-figma.ts';
import { type Chrome, launchChrome } from './chrome.ts';
import { createFigmaFile, createProfileCard } from './fixture.ts';
import { openPlugin, type PanelSnapshot, type Plugin, type Theme } from './plugin.ts';
import { writeScreenshot } from './proof.ts';
import { refused, saved, SyntheticReceiver } from './receiver.ts';

let chrome: Chrome;

beforeAll(async () => {
  chrome = await launchChrome();
});

afterAll(async () => {
  await chrome.stop();
});

const ready = (panel: PanelSnapshot) =>
  panel.receiver.status === 'online' && panel.primary.disabled === false;
const finished = (panel: PanelSnapshot) => panel.notice !== null;

function batch() {
  const file = createFigmaFile();
  file.fake.select([
    file.frame('1:1', 'Header'),
    file.frame('1:2', 'Pricing table'),
    file.frame('1:3', 'Footer'),
  ]);
  return file.fake;
}

describe.each<Theme>(['light', 'dark'])('%s panel', (theme) => {
  async function open(fake: FakeFigma, receiver: SyntheticReceiver) {
    onTestFinished(() => receiver.stop());
    const plugin = await openPlugin({
      chrome,
      fake,
      port: receiver.port,
      theme,
      reducedMotion: true,
    });
    onTestFinished(() => plugin.close());
    return plugin;
  }

  const capture = async (state: string, plugin: Plugin) => {
    writeScreenshot(`${state}-${theme}`, await plugin.screenshot());
  };

  it('no selection', async () => {
    const plugin = await open(createFigmaFile().fake, await SyntheticReceiver.started());
    const panel = await plugin.until(
      'online and empty',
      (p) => p.receiver.status === 'online' && p.selection.title === 'Nothing selected',
    );
    expect(panel.primary).toEqual({ label: 'Export', disabled: true });
    await capture('no-selection', plugin);
  });

  it('ready', async () => {
    const file = createFigmaFile();
    file.fake.select([createProfileCard(file)]);
    const plugin = await open(file.fake, await SyntheticReceiver.started());
    await plugin.until('ready', ready);
    await capture('ready', plugin);
  });

  it('running', async () => {
    const receiver = await SyntheticReceiver.started();
    receiver.hold();
    const plugin = await open(batch(), receiver);
    await plugin.until('ready', ready);
    await plugin.click('#primary');
    await receiver.posts(1);
    receiver.release();
    await receiver.posts(2);
    await plugin.until('row 2 sending', (p) => p.rows[1]?.state === 'sending');
    await capture('running', plugin);
  });

  it('saved', async () => {
    const plugin = await open(batch(), await SyntheticReceiver.started());
    await plugin.until('ready', ready);
    await plugin.click('#primary');
    await plugin.until('all saved', (p) => p.notice?.tone === 'success');
    await capture('saved', plugin);
  });

  it('partial failure', async () => {
    const receiver = await SyntheticReceiver.started();
    receiver.reply = (post) =>
      post.payload.nodeId === '1:2' ? refused(500, 'Synthetic disk is full.') : saved(post);
    const plugin = await open(batch(), receiver);
    await plugin.until('ready', ready);
    await plugin.click('#primary');
    await plugin.until('run finished', finished);
    await capture('partial-failure', plugin);
  });

  it('offline', async () => {
    const plugin = await open(batch(), await SyntheticReceiver.stopped());
    await plugin.until('offline', (p) => p.receiver.status === 'offline');
    await capture('offline', plugin);
  });

  it('Unidentified notice', async () => {
    const options: FakeFigmaOptions = { fileKey: undefined, fileName: 'Untitled' };
    const file = createFigmaFile(options);
    file.fake.select([file.frame('1:1', 'Hero')]);
    const plugin = await open(file.fake, await SyntheticReceiver.started());
    await plugin.until('ready', ready);
    await capture('unidentified', plugin);
  });
});
