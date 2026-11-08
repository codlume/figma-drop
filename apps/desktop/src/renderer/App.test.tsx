import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { App } from './App.tsx';
import type { CommandResult, ReceiverStatus, RevisionId } from './bridge.ts';
import { createSyntheticBridge, type SyntheticOptions } from './synthetic/createSyntheticBridge.ts';
import { emptyLibrary, mintId, populatedLibrary, syntheticName } from './synthetic/fixtures.ts';

const name = syntheticName;
const revision = (slug: string) => mintId<RevisionId>(`rev-${slug}`);

// jsdom has no modal dialog, so this mirrors what the browser does with open state and focus.
beforeAll(() => {
  const opener = new WeakMap<HTMLDialogElement, Element | null>();
  HTMLDialogElement.prototype.showModal = function showModal() {
    opener.set(this, document.activeElement);
    this.setAttribute('open', '');
  };
  Element.prototype.scrollIntoView = () => {};
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    const previous = opener.get(this);
    if (previous instanceof HTMLElement) previous.focus();
  };
  // jsdom does no layout, so every observed element reports an 800x600 content box.
  globalThis.ResizeObserver = class {
    readonly #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element) {
      const contentRect = DOMRectReadOnly.fromRect({ width: 800, height: 600 });
      this.#callback([{ target, contentRect } as ResizeObserverEntry], this);
    }
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  Reflect.deleteProperty(window, 'figmaDrop');
});

function setup(options: SyntheticOptions = {}) {
  const synthetic = createSyntheticBridge(options);
  Object.defineProperty(window, 'figmaDrop', { value: synthetic.bridge, configurable: true });
  return { ...synthetic, user: userEvent.setup() };
}

function start(options: SyntheticOptions = {}) {
  const context = setup(options);
  render(<App />);
  return context;
}

const library = () => screen.findByRole('listbox', { name: 'Library' });
const details = () => screen.getByRole('complementary', { name: 'Export details' });
const actionButton = (label: string) => within(details()).getByRole('button', { name: label });
const receiverSwitch = () => screen.findByRole('switch', { name: 'Receiver' });
const actionStatus = () => within(details()).getByRole('status');

async function openProject(user: ReturnType<typeof userEvent.setup>, projectName: RegExp | string) {
  await user.click(within(await library()).getByRole('option', { name: projectName }));
}

async function openNode(user: ReturnType<typeof userEvent.setup>, nodeName: string) {
  const grid = await screen.findByRole('listbox', { name: /^Nodes in/ });
  await user.click(within(grid).getByRole('option', { name: new RegExp(nodeName) }));
}

async function openHero(user: ReturnType<typeof userEvent.setup>) {
  await openNode(user, name('Hero banner'));
  return screen.findByRole('listbox', { name: 'History' });
}

describe('selection stability', () => {
  it('keeps the open file when an export arrives for another file', async () => {
    const { control } = start();
    await screen.findByRole('heading', { level: 1, name: name('Marketing site') });

    control.pushExport();

    await within(await library()).findByRole('option', { name: /Incoming exports/ });
    expect(screen.getByRole('heading', { level: 1, name: name('Marketing site') })).toBeVisible();
  });

  it('keeps an older revision on screen when an export arrives', async () => {
    const { control, user } = start();
    const history = await openHero(user);
    const older = within(history).getAllByRole('option')[1];
    if (!older) throw new Error('the fixture needs two revisions');
    await user.click(older);

    control.pushExport();

    await within(await library()).findByRole('option', { name: /Incoming exports/ });
    expect(within(details()).getByText(/Actions apply to the older revision/)).toBeVisible();
  });
});

describe('library', () => {
  it('shows Figma files and a separate Unidentified row', async () => {
    start();
    const list = await library();
    const files = within(list).getByRole('group', { name: 'Figma files' });
    expect(within(files).getAllByRole('option')).toHaveLength(populatedLibrary.projects.length);
    expect(within(files).queryByRole('option', { name: /^Unidentified/ })).toBeNull();
    expect(within(list).getByRole('option', { name: /^Unidentified/ })).toHaveTextContent(
      String(populatedLibrary.unidentified.length),
    );
    expect(screen.getByRole('heading', { level: 1, name: name('Marketing site') })).toBeVisible();
    expect(within(screen.getByRole('main')).getByText('c3-marketing-synthetic')).toBeVisible();
  });

  it('tells two files with one name apart by key hint', async () => {
    start();
    const rows = within(await library()).getAllByRole('option', {
      name: new RegExp(`^${name('Untitled')}`),
    });
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('a1-untit'),
      expect.stringContaining('b2-untit'),
    ]);
  });

  it('shows the claim as a claim, and why Unidentified exports stand alone', async () => {
    const { user } = start();
    await openProject(user, /^Unidentified/);
    expect(screen.getByRole('heading', { level: 1, name: 'Unidentified' })).toBeVisible();
    expect(screen.getByText(/no stable Figma file identity/)).toBeVisible();
    const grid = screen.getByRole('listbox', { name: 'Unidentified exports' });
    expect(
      within(grid).getByRole('option', { name: new RegExp(name('Missing key')) }),
    ).toHaveTextContent(`Claim: ${name('Offline draft')}`);
    expect(within(details()).queryByRole('listbox', { name: 'History' })).toBeNull();
  });

  it('gives an emptied Unidentified inbox its own message', async () => {
    const { bridge, user } = setup();
    vi.spyOn(bridge.library, 'getSnapshot').mockResolvedValue({
      ...populatedLibrary,
      unidentified: [],
    });
    render(<App />);
    await openProject(user, /^Unidentified/);
    expect(screen.getByRole('heading', { name: 'Nothing unidentified' })).toBeVisible();
    expect(screen.queryByRole('complementary', { name: 'Export details' })).toBeNull();
  });

  it('shows a pushed export without a reload', async () => {
    const { control } = start();
    await library();
    control.pushExport();
    expect(
      await screen.findByRole('option', { name: new RegExp(name('Incoming exports')) }),
    ).toBeVisible();
  });
});

describe('selection', () => {
  it('moves preview and action target with the node and the history row', async () => {
    const { bridge, user } = start();
    const reveal = vi.spyOn(bridge.library, 'reveal');
    const history = await openHero(user);
    const rows = within(history).getAllByRole('option');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Latest');
    expect(rows[1]).not.toHaveTextContent('Latest');
    expect(within(details()).getByText(/latest revision/)).toBeVisible();
    const latestPreview = within(details()).getByRole('img').getAttribute('src');

    await user.click(rows[1]!);

    expect(rows[1]).toHaveAttribute('aria-selected', 'true');
    expect(within(details()).getByText(/older revision/)).toBeVisible();
    expect(within(details()).getByRole('img').getAttribute('src')).not.toBe(latestPreview);
    await user.click(actionButton('Reveal in Finder'));
    expect(reveal).toHaveBeenCalledWith(revision('hero-2'));
  });

  it('clears the previous result when the selection moves', async () => {
    const { user } = start();
    await openHero(user);
    await user.click(actionButton('Copy path'));
    await waitFor(() => expect(actionStatus()).not.toBeEmptyDOMElement());
    await openNode(user, name('Icon/Arrow'));
    expect(actionStatus()).toBeEmptyDOMElement();
  });
});

describe('previews', () => {
  it('says so when an export has no preview', async () => {
    const { user } = start();
    await openNode(user, name('HTML-only export'));
    expect(within(details()).getByText('No preview in this export')).toBeVisible();
    expect(within(details()).queryByRole('img')).toBeNull();
  });

  it('replaces an image that fails to load', async () => {
    const { user } = start();
    await openHero(user);
    fireEvent.error(within(details()).getByRole('img'));
    expect(within(details()).getByText('Preview could not be loaded')).toBeVisible();
    expect(within(details()).queryByRole('img')).toBeNull();
  });

  it('renders a hostile SVG only as an image', async () => {
    document.title = 'before';
    const { user } = start();
    await openNode(user, name('SVG with a script'));
    const image = within(details()).getByRole('img', {
      name: `Preview of ${name('SVG with a script')}`,
    });
    expect(image.tagName).toBe('IMG');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image).toHaveAttribute('draggable', 'false');
    expect(document.querySelector('script, iframe, object, embed, webview')).toBeNull();
    expect(document.body.innerHTML).not.toContain('<script');
    expect(document.title).toBe('before');
  });
});

// A 750x1624 frame in the stubbed 800x600 stage fits at 600 / 1624, shown as 37%.
function loadTallFrame(dialog: HTMLElement) {
  const image = within(dialog).getByRole('img');
  Object.defineProperty(image, 'naturalWidth', { value: 750 });
  Object.defineProperty(image, 'naturalHeight', { value: 1624 });
  fireEvent.load(image);
}

describe('image viewer', () => {
  const opener = () => within(details()).getByRole('button', { name: 'Open image viewer' });
  const heroViewer = () =>
    screen.getByRole('dialog', { name: `Preview of ${name('Hero banner')}` });
  const control = (label: string) => within(heroViewer()).getByRole('button', { name: label });
  const readout = () => within(heroViewer()).getByRole('status');

  async function openViewer(user: ReturnType<typeof userEvent.setup>) {
    await openHero(user);
    await user.click(opener());
    const dialog = heroViewer();
    loadTallFrame(dialog);
    return dialog;
  }

  it('opens on the stage in fit mode', async () => {
    const { user } = start();
    const dialog = await openViewer(user);
    expect(within(dialog).getByRole('group', { name: 'Image, scroll to pan' })).toHaveFocus();
    expect(control('Fit')).toHaveAttribute('aria-pressed', 'true');
    expect(control('100%')).toHaveAttribute('aria-pressed', 'false');
    expect(readout()).toHaveTextContent('37%');
  });

  it('switches between fit and actual size', async () => {
    const { user } = start();
    await openViewer(user);
    await user.click(control('100%'));
    expect(control('100%')).toHaveAttribute('aria-pressed', 'true');
    expect(control('Fit')).toHaveAttribute('aria-pressed', 'false');
    expect(readout()).toHaveTextContent('100%');
    await user.click(control('Fit'));
    expect(control('Fit')).toHaveAttribute('aria-pressed', 'true');
    expect(readout()).toHaveTextContent('37%');
  });

  it('steps along the zoom ladder from buttons and keys', async () => {
    const { user } = start();
    await openViewer(user);
    await user.click(control('Zoom in'));
    expect(readout()).toHaveTextContent('50%');
    expect(control('Fit')).toHaveAttribute('aria-pressed', 'false');
    await user.click(control('Zoom in'));
    expect(readout()).toHaveTextContent('67%');
    await user.click(control('Zoom out'));
    expect(readout()).toHaveTextContent('50%');
    await user.keyboard('+');
    expect(readout()).toHaveTextContent('67%');
    await user.keyboard('-');
    expect(readout()).toHaveTextContent('50%');
    await user.keyboard('1');
    expect(readout()).toHaveTextContent('100%');
    await user.keyboard('0');
    expect(readout()).toHaveTextContent('37%');
    expect(control('Fit')).toHaveAttribute('aria-pressed', 'true');
  });

  it('stops zooming in at the top of the ladder', async () => {
    const { user } = start();
    await openViewer(user);
    await user.keyboard('1');
    await user.keyboard('======');
    expect(readout()).toHaveTextContent('800%');
    expect(control('Zoom in')).toHaveAttribute('aria-disabled', 'true');
    await user.click(control('Zoom in'));
    expect(readout()).toHaveTextContent('800%');
  });

  it("closes on the dialog's cancel event, which Escape fires, and returns focus", async () => {
    const { user } = start();
    const dialog = await openViewer(user);
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener()).toHaveFocus();
  });

  it('closes on a backdrop click, but not on a click inside', async () => {
    const { user } = start();
    const dialog = await openViewer(user);
    await user.click(within(dialog).getByRole('group', { name: 'Image, scroll to pan' }));
    await user.click(within(dialog).getByRole('heading', { name: name('Hero banner') }));
    expect(heroViewer()).toBeVisible();
    await user.click(dialog);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener()).toHaveFocus();
  });

  it('opens fresh in fit mode each time', async () => {
    const { user } = start();
    await openHero(user);
    for (let round = 0; round < 3; round += 1) {
      await user.click(opener());
      loadTallFrame(heroViewer());
      expect(control('Fit')).toHaveAttribute('aria-pressed', 'true');
      expect(readout()).toHaveTextContent('37%');
      await user.click(control('100%'));
      await user.click(control('Close'));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(opener()).toHaveFocus();
    }
  });

  it('shows the older revision picked in history', async () => {
    const { user } = start();
    const history = await openHero(user);
    await user.click(within(history).getAllByRole('option')[1]!);
    const olderSource = within(details()).getByRole('img').getAttribute('src');
    await user.click(opener());
    expect(within(heroViewer()).getByRole('img')).toHaveAttribute('src', olderSource);
  });

  it('closes rather than go stale when main moves the selection, and stays closed', async () => {
    const { control: bridgeControl, user } = start();
    await openViewer(user);
    bridgeControl.focusExport({ kind: 'revision', revisionId: revision('arrow-upper') });
    await screen.findByRole('heading', { level: 2, name: name('Icon/Arrow') });
    expect(screen.queryByRole('dialog')).toBeNull();
    await openHero(user);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes and returns focus to the opener when a new revision of the open node arrives', async () => {
    const { control: bridgeControl, user } = start();
    bridgeControl.pushExport();
    await openProject(user, /Incoming exports/);
    await openNode(user, name('Pushed node'));
    await user.click(opener());
    expect(screen.getByRole('dialog')).toBeVisible();
    bridgeControl.pushExport();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener()).toHaveFocus();
  });

  it('reports an image that fails to load and offers no zoom', async () => {
    const { user } = start();
    await openHero(user);
    await user.click(opener());
    fireEvent.error(within(heroViewer()).getByRole('img'));
    expect(within(heroViewer()).getByText('Preview could not be loaded')).toBeVisible();
    expect(readout()).toBeEmptyDOMElement();
    expect(control('Zoom in')).toHaveAttribute('aria-disabled', 'true');
    expect(control('Zoom out')).toHaveAttribute('aria-disabled', 'true');
  });

  it('offers no viewer for a damaged, missing, or failed preview', async () => {
    const { user } = start();
    await openNode(user, name('Damaged latest revision'));
    expect(within(details()).queryByRole('button', { name: 'Open image viewer' })).toBeNull();
    await openNode(user, name('HTML-only export'));
    expect(within(details()).queryByRole('button', { name: 'Open image viewer' })).toBeNull();
    await openHero(user);
    fireEvent.error(within(opener()).getByRole('img'));
    expect(within(details()).queryByRole('button', { name: 'Open image viewer' })).toBeNull();
  });
});

describe('actions', () => {
  it.each([
    ['Reveal in Finder', 'reveal'],
    ['Copy path', 'copyPath'],
    ['Copy to folder', 'copyToFolder'],
  ] as const)('%s calls main and reports success', async (label, command) => {
    const { bridge, user } = start();
    const call = vi.spyOn(bridge.library, command);
    await openHero(user);
    await user.click(actionButton(label));
    expect(call).toHaveBeenCalledWith(revision('hero-3'));
    await waitFor(() => expect(actionStatus()).not.toBeEmptyDOMElement());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stays quiet when the folder dialog is cancelled', async () => {
    const { bridge, user } = start({ copyCancelled: true });
    const copy = vi.spyOn(bridge.library, 'copyToFolder');
    await openHero(user);
    await user.click(actionButton('Copy to folder'));
    await waitFor(() => expect(copy).toHaveBeenCalled());
    await waitFor(() =>
      expect(actionButton('Copy to folder')).not.toHaveAttribute('aria-disabled', 'true'),
    );
    expect(actionStatus()).toBeEmptyDOMElement();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows progress on the running button and locks the others', async () => {
    const { bridge, user } = start();
    let finish: (result: CommandResult) => void = () => {};
    vi.spyOn(bridge.library, 'reveal').mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    await openHero(user);
    await user.click(actionButton('Reveal in Finder'));
    expect(actionButton('Revealing…')).toHaveAttribute('aria-disabled', 'true');
    expect(actionButton('Copy path')).toHaveAttribute('aria-disabled', 'true');
    expect(actionButton('Move to Trash')).toHaveAttribute('aria-disabled', 'true');
    await act(async () => finish({ ok: true }));
    expect(actionButton('Reveal in Finder')).not.toHaveAttribute('aria-disabled', 'true');
  });

  it.each(['Dismiss', 'Retry'])('hands focus back to the actions after %s', async (label) => {
    const { user } = start({ scenario: 'actions-fail' });
    await openHero(user);
    await user.click(actionButton('Reveal in Finder'));
    await within(await screen.findByRole('alert')).findByRole('button', { name: label });
    await user.click(screen.getByRole('button', { name: label }));
    expect(within(details()).getByRole('group', { name: 'Revision actions' })).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it('holds keyboard focus on the running button and ignores a second press', async () => {
    const { bridge, user } = start();
    let finish: (result: CommandResult) => void = () => {};
    const reveal = vi
      .spyOn(bridge.library, 'reveal')
      .mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await openHero(user);
    actionButton('Reveal in Finder').focus();
    await user.keyboard(' ');
    expect(actionButton('Revealing…')).toHaveFocus();
    expect(actionButton('Revealing…')).toBeEnabled();
    await user.keyboard(' ');
    expect(reveal).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    expect(actionButton('Reveal in Finder')).toHaveFocus();
  });

  it.each(['actions-fail', 'actions-reject'] as const)(
    '%s reports inline and Retry recovers',
    async (scenario) => {
      const { control, user } = start({ scenario });
      await openHero(user);
      await user.click(actionButton('Copy path'));
      const alert = await within(details()).findByRole('alert');
      expect(alert).toHaveTextContent("Couldn't copy the path");
      control.recover();
      await user.click(within(alert).getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(actionStatus()).not.toBeEmptyDOMElement());
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('Dismiss clears a failure', async () => {
    const { user } = start({ scenario: 'actions-fail' });
    await openHero(user);
    await user.click(actionButton('Reveal in Finder'));
    const alert = await within(details()).findByRole('alert');
    expect(alert).toHaveTextContent('Synthetic: the command failed.');
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('damaged revisions', () => {
  async function openDamaged(user: ReturnType<typeof userEvent.setup>) {
    await openNode(user, name('Damaged latest revision'));
  }

  it('explains itself, hides Copy to folder, and keeps the other actions', async () => {
    const { user } = start();
    await openDamaged(user);
    expect(
      within(details()).getByText(
        /This revision's receipt can't be read\. Its files have been left alone/,
      ),
    ).toBeVisible();
    expect(within(details()).queryByRole('button', { name: 'Copy to folder' })).toBeNull();
    expect(actionButton('Reveal in Finder')).not.toHaveAttribute('aria-disabled', 'true');
    expect(actionButton('Copy path')).not.toHaveAttribute('aria-disabled', 'true');
    expect(actionButton('Move to Trash')).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('brings Copy to folder back on a healthy revision of the same node', async () => {
    const { user } = start();
    await openDamaged(user);
    const rows = within(screen.getByRole('listbox', { name: 'History' })).getAllByRole('option');
    await user.click(rows[1]!);
    expect(actionButton('Copy to folder')).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('confirms by folder, because a damaged name may be a directory slug', async () => {
    const { user } = start();
    await openProject(user, /synthetic-lost-receipt-3fa9c1/);
    await user.click(actionButton('Move to Trash'));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('/synthetic/library/lost-receipt');
    expect(dialog).not.toHaveTextContent('synthetic-lost-node-9be204');
    expect(dialog).toHaveTextContent('macOS Trash');
  });
});

describe('trash', () => {
  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await openHero(user);
    await user.click(actionButton('Move to Trash'));
    return screen.getByRole('dialog', { name: 'Move to Trash?' });
  }

  it('names what moves and focuses Cancel', async () => {
    const { user } = start();
    const dialog = await openDialog(user);
    expect(dialog).toHaveTextContent(name('Hero banner'));
    expect(dialog).toHaveTextContent('macOS Trash');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('Cancel does nothing and returns focus', async () => {
    const { bridge, user } = start();
    const trash = vi.spyOn(bridge.library, 'trash');
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trash).not.toHaveBeenCalled();
    expect(actionButton('Move to Trash')).toHaveFocus();
  });

  it("the dialog's cancel event, which Escape fires, cancels", async () => {
    const { bridge, user } = start();
    const trash = vi.spyOn(bridge.library, 'trash');
    const dialog = await openDialog(user);
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trash).not.toHaveBeenCalled();
  });

  it('confirming trashes that revision and leaves focus on the grid', async () => {
    const { bridge, user } = start();
    const trash = vi.spyOn(bridge.library, 'trash');
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Move to Trash' }));
    expect(trash).toHaveBeenCalledWith(revision('hero-3'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('listbox', { name: 'History' })).getAllByRole('option'),
      ).toHaveLength(2),
    );
    await waitFor(() => expect(document.activeElement).toHaveAttribute('role', 'option'));
    expect(screen.getByRole('listbox', { name: /^Nodes in/ })).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it('keeps focus usable when the last node of a file leaves', async () => {
    const { user } = start();
    await openProject(user, new RegExp(name('Brand kit')));
    await user.click(actionButton('Move to Trash'));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Move to Trash' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: new RegExp(name('Brand kit')) })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it('says it worked and keeps focus in the app when the last export leaves', async () => {
    const [entry] = populatedLibrary.unidentified;
    const { bridge, user } = setup();
    const getSnapshot = vi
      .spyOn(bridge.library, 'getSnapshot')
      .mockResolvedValue({ ...emptyLibrary, unidentified: [entry!] });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Move to Trash' }));
    getSnapshot.mockResolvedValue(emptyLibrary);
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Move to Trash' }),
    );
    expect(await screen.findByRole('heading', { name: 'No exports yet' })).toBeVisible();
    expect(within(screen.getByRole('main')).getByRole('status')).toHaveTextContent(
      'Moved to Trash',
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  it('treats a revision that is already gone as done and falls back', async () => {
    const { user } = start({ trashAlreadyGone: true });
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(actionStatus()).toHaveTextContent('That revision is already gone'));
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() =>
      expect(
        within(screen.getByRole('listbox', { name: 'History' })).getAllByRole('option'),
      ).toHaveLength(2),
    );
  });
});

describe('library states', () => {
  it("shows a skeleton while the sidebar's receiver stays live", async () => {
    const { user } = start({ scenario: 'loading' });
    expect(await screen.findByText('Loading library…')).toBeInTheDocument();
    const toggle = await receiverSwitch();
    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(await screen.findByText('Receiver off')).toBeVisible();
  });

  it.each([
    ['unreadable', 'Synthetic: the library folder could not be read.'],
    ['snapshot-rejects', null],
  ] as const)('%s offers Try again and the receiver still works', async (scenario, message) => {
    const { control, user } = start({ scenario });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Can't open the library");
    if (message) expect(alert).toHaveTextContent(message);
    expect(await receiverSwitch()).not.toHaveAttribute('aria-disabled', 'true');
    control.recover();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await library()).toBeVisible();
  });

  it('keeps data visible behind a refresh failure, and clears it on Try again', async () => {
    const { control, user } = start();
    await library();
    control.setScenario('snapshot-rejects');
    const banner = await screen.findByText(/could not refresh the library/);
    expect(screen.getByRole('heading', { level: 1, name: name('Marketing site') })).toBeVisible();
    control.recover();
    await user.click(
      within(banner.closest('[role="status"]') as HTMLElement).getByRole('button', {
        name: 'Try again',
      }),
    );
    await waitFor(() => expect(screen.queryByText(/could not refresh the library/)).toBeNull());
    expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
  });

  it('guides an empty library while the receiver listens', async () => {
    start({ scenario: 'empty' });
    expect(await screen.findByRole('heading', { name: 'No exports yet' })).toBeVisible();
    expect(screen.getByText(/Export from the figma-drop plugin/)).toBeVisible();
  });

  it('offers to turn the receiver on from an empty library', async () => {
    const { user } = start({ scenario: 'empty' });
    await user.click(await receiverSwitch());
    expect(await screen.findByRole('heading', { name: 'The receiver is off' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Turn on receiver' }));
    expect(await screen.findByRole('heading', { name: 'No exports yet' })).toBeVisible();
    expect(await screen.findByText('Listening on port 3579')).toBeVisible();
  });

  it('points an empty library at a receiver problem', async () => {
    const { bridge } = setup({ scenario: 'port-conflict' });
    vi.spyOn(bridge.library, 'getSnapshot').mockResolvedValue(emptyLibrary);
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'The receiver needs attention' }),
    ).toBeVisible();
  });
});

describe('receiver', () => {
  it('shows listening and turns off only when main says so', async () => {
    const { bridge, user } = setup();
    let report: (status: ReceiverStatus) => void = () => {};
    let finish: (status: ReceiverStatus) => void = () => {};
    vi.spyOn(bridge.receiver, 'onStatus').mockImplementation((listener) => {
      report = listener;
      return () => {};
    });
    vi.spyOn(bridge.receiver, 'setEnabled').mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    render(<App />);
    const toggle = await receiverSwitch();
    expect(await screen.findByText('Listening on port 3579')).toBeVisible();
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);
    expect(screen.getByText('Listening on port 3579')).toBeVisible();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAttribute('aria-disabled', 'true');

    act(() => report({ state: 'stopping' }));
    expect(screen.getByText('Stopping…')).toBeVisible();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAttribute('aria-disabled', 'true');

    await act(async () => finish({ state: 'off' }));
    expect(screen.getByText('Receiver off')).toBeVisible();
    expect(toggle).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('shows the saved position on a failed stop, and Try again keeps asking for off', async () => {
    const { bridge, user } = start({ scenario: 'receiver-stop-failed' });
    const setEnabled = vi.spyOn(bridge.receiver, 'setEnabled');
    const toggle = await receiverSwitch();

    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Receiver problem')).toBeVisible();
    expect(screen.queryByText('Listening on port 3579')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(setEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(await screen.findByText('Receiver off')).toBeVisible();
  });

  it('turns on from off', async () => {
    const { user } = start({ scenario: 'receiver-off' });
    const toggle = await receiverSwitch();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(await screen.findByText('Listening on port 3579')).toBeVisible();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('explains a port conflict, names the holder, and only offers Try again', async () => {
    const { bridge, user } = start({ scenario: 'port-conflict' });
    const setEnabled = vi.spyOn(bridge.receiver, 'setEnabled');
    const receiver = await screen.findByRole('region', { name: 'Receiver' });
    expect(await within(receiver).findByText('Port 3579 is in use')).toBeVisible();
    expect(within(receiver).getByText(/Quit that app, then try again/)).toBeVisible();
    expect(within(receiver).getByText('Held by synthetic-other-app (pid 4242)')).toBeVisible();
    expect(within(receiver).queryByRole('button', { name: /kill|quit/i })).toBeNull();
    await user.click(within(receiver).getByRole('button', { name: 'Try again' }));
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("shows main's message when the receiver stopped", async () => {
    const { bridge, user } = start({ scenario: 'receiver-failed' });
    const setEnabled = vi.spyOn(bridge.receiver, 'setEnabled');
    expect(await screen.findByText('Receiver problem')).toBeVisible();
    expect(screen.getByText('Synthetic: the receiver stopped unexpectedly.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("offers Reload when status can't be read", async () => {
    const { control, user } = start({ scenario: 'receiver-unavailable' });
    await user.click(await screen.findByRole('button', { name: 'Reload' }));
    expect(await screen.findByRole('button', { name: 'Reload' })).toBeVisible();
    control.recover();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('Listening on port 3579')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  it('survives a rejected switch and keeps showing what main reported', async () => {
    const { user } = start({ scenario: 'actions-reject' });
    const toggle = await receiverSwitch();
    await user.click(toggle);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Listening on port 3579')).toBeVisible();
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled', 'true'));
  });
});

describe('focus requests', () => {
  it('opens the revision and moves focus to the detail title', async () => {
    const { control } = start();
    await library();
    control.focusExport({ kind: 'revision', revisionId: revision('hero-2') });
    const title = await screen.findByRole('heading', { level: 2, name: name('Hero banner') });
    await waitFor(() => expect(title).toHaveFocus());
    expect(within(details()).getByText(/older revision/)).toBeVisible();
  });

  it('waits for an export that has not reached a snapshot yet', async () => {
    const { control } = start();
    await library();
    control.focusExport({ kind: 'revision', revisionId: revision('pushed-1') });
    control.pushExport();
    const title = await screen.findByRole('heading', { level: 2, name: name('Pushed node') });
    await waitFor(() => expect(title).toHaveFocus());
  });

  it('drops a pending request once the user picks something else', async () => {
    const { control, user } = start();
    await library();
    control.focusExport({ kind: 'revision', revisionId: revision('pushed-1') });
    await openProject(user, new RegExp(name('Brand kit')));
    control.pushExport();
    await screen.findByRole('option', { name: new RegExp(name('Incoming exports')) });
    expect(screen.getByRole('heading', { level: 1, name: name('Brand kit') })).toBeVisible();
  });
});

describe('keyboard', () => {
  it('reaches sidebar, grid, actions, and history without a pointer', async () => {
    const { bridge, user } = start();
    const copyPath = vi.spyOn(bridge.library, 'copyPath');
    const list = await library();
    const rows = within(list).getAllByRole('option');

    await user.tab();
    expect(rows[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(rows[0]).toHaveFocus();
    await user.keyboard('{End}');
    expect(rows.at(-1)).toHaveFocus();
    await user.keyboard('{Home}{Enter}');

    await user.tab();
    expect(await receiverSwitch()).toHaveFocus();
    await user.tab();
    const grid = screen.getByRole('listbox', { name: /^Nodes in/ });
    const cards = within(grid).getAllByRole('option');
    expect(cards[0]).toHaveFocus();
    await user.keyboard('{End}{Enter}');
    expect(cards.at(-1)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 2, name: name('Hero banner') })).toBeVisible();
    await user.keyboard('{ArrowLeft}{ArrowRight}');
    expect(cards.at(-1)).toHaveFocus();

    await user.tab();
    expect(actionButton('Open image viewer')).toHaveFocus();
    await user.tab();
    expect(actionButton('Reveal in Finder')).toHaveFocus();
    await user.tab();
    expect(actionButton('Copy path')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(copyPath).toHaveBeenCalledWith(revision('hero-3'));
    await waitFor(() => expect(actionStatus()).not.toBeEmptyDOMElement());

    await user.tab();
    await user.tab();
    await user.tab();
    const history = within(screen.getByRole('listbox', { name: 'History' })).getAllByRole('option');
    expect(history[0]).toHaveFocus();
    await user.keyboard('{ArrowDown} ');
    expect(history[1]).toHaveAttribute('aria-selected', 'true');
    expect(within(details()).getByText(/older revision/)).toBeVisible();
  });
});

describe('no bridge', () => {
  it('shows the unreachable screen and no synthetic data', () => {
    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent("Can't reach figma-drop");
    expect(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
