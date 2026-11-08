// Installed into the renderer as `window.proof`. Elements are found by role and accessible name, as
// the viewer contract names them, so the proof does not depend on class names or markup shape.
export const PAGE_HELPERS = `window.proof = (() => {
  const IMPLICIT = { BUTTON: 'button', DIALOG: 'dialog', OUTPUT: 'status', FIELDSET: 'group', IMG: 'img' };

  function roleOf(element) {
    return element.getAttribute('role')?.split(/\\s+/)[0] ?? IMPLICIT[element.tagName] ?? null;
  }

  function accName(element) {
    if (!element) return '';
    const label = element.getAttribute('aria-label');
    if (label) return label.trim();
    const by = element.getAttribute('aria-labelledby');
    if (by) {
      return by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
        .replace(/\\s+/g, ' ').trim();
    }
    if (element.tagName === 'IMG') return element.alt;
    return (element.textContent ?? '').replace(/\\s+/g, ' ').trim() || element.title || '';
  }

  function rendered(element) {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  }

  function find(role, name, root = document) {
    return [...root.querySelectorAll('*')].find(
      (element) => roleOf(element) === role && accName(element) === name && rendered(element),
    ) ?? null;
  }

  function openDialogs() {
    const found = new Set([
      ...document.querySelectorAll('dialog[open]'),
      ...[...document.querySelectorAll('[role=dialog], [role=alertdialog], [aria-modal=true]')].filter(rendered),
    ]);
    return [...found];
  }

  const round = (value) => Math.round(value * 10) / 10;
  const box = ({ x, y, width, height }) => ({
    left: round(x), top: round(y), right: round(x + width), bottom: round(y + height),
    width: round(width), height: round(height),
  });

  // The scrollport: the visible content area, without borders or scrollbars.
  function clientBox(element) {
    const rect = element.getBoundingClientRect();
    return box({
      x: rect.x + element.clientLeft,
      y: rect.y + element.clientTop,
      width: element.clientWidth,
      height: element.clientHeight,
    });
  }

  function contentWidth(element) {
    const style = getComputedStyle(element);
    return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  }

  function offset(token, free) {
    if (token.endsWith('%')) return (free * parseFloat(token)) / 100;
    return parseFloat(token) || 0;
  }

  // Where the pixels land, honouring object-fit and object-position, since the img box and the
  // painted image differ under contain or cover.
  function painted(image) {
    const rect = image.getBoundingClientRect();
    const style = getComputedStyle(image);
    const natural = { width: image.naturalWidth, height: image.naturalHeight };
    if (!natural.width || !natural.height) return box(rect);
    const contain = Math.min(rect.width / natural.width, rect.height / natural.height);
    const cover = Math.max(rect.width / natural.width, rect.height / natural.height);
    const scale = {
      contain,
      cover,
      none: 1,
      'scale-down': Math.min(1, contain),
    }[style.objectFit];
    if (scale === undefined) return box(rect);
    const width = natural.width * scale;
    const height = natural.height * scale;
    const [px = '50%', py = '50%'] = style.objectPosition.split(/\\s+/);
    return box({
      x: rect.x + offset(px, rect.width - width),
      y: rect.y + offset(py, rect.height - height),
      width,
      height,
    });
  }

  function intersect(a, b) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    return box({ x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) });
  }

  // The part of the painted image no clipping ancestor hides.
  function visible(image) {
    let rect = intersect(painted(image), box(image.getBoundingClientRect()));
    for (let element = image.parentElement; element; element = element.parentElement) {
      if (getComputedStyle(element).overflow !== 'visible') rect = intersect(rect, clientBox(element));
    }
    return rect;
  }

  function measureImage(image) {
    const frame = image.parentElement;
    const drawn = painted(image);
    return {
      natural: { width: image.naturalWidth, height: image.naturalHeight },
      element: box(image.getBoundingClientRect()),
      painted: drawn,
      visible: visible(image),
      frameWidth: round(contentWidth(frame)),
      frameHeight: round(frame.clientHeight),
      objectFit: getComputedStyle(image).objectFit,
      loaded: image.complete && image.naturalWidth > 0,
    };
  }

  function measureGrid() {
    const grid = document.querySelector('main [role=listbox]');
    const cards = [...grid.querySelectorAll('[role=option]')];
    const style = getComputedStyle(grid);
    const tracks = style.display.includes('grid')
      ? style.gridTemplateColumns.split(/\\s+/).filter((track) => parseFloat(track) > 0).length
      : null;
    const lefts = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left)));
    const detailImage = document.querySelector('aside img');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      gridWidth: round(grid.clientWidth),
      columns: tracks ?? lefts.size,
      tracks,
      occupiedColumns: lefts.size,
      cards: cards.map((card) => {
        const image = card.querySelector('img');
        return {
          name: card.querySelector('[title]')?.title ?? accName(card),
          cardWidth: round(card.getBoundingClientRect().width),
          cardHeight: round(card.getBoundingClientRect().height),
          image: image ? measureImage(image) : null,
        };
      }),
      detail: detailImage ? measureImage(detailImage) : null,
    };
  }

  function viewer() {
    const dialog = openDialogs().find((candidate) => accName(candidate).startsWith('Preview of ')) ?? null;
    if (!dialog) return null;
    const button = (name) => find('button', name, dialog);
    const stage = find('group', 'Image, scroll to pan', dialog);
    return {
      dialog,
      zoomOut: button('Zoom out'),
      zoomIn: button('Zoom in'),
      fit: button('Fit'),
      actual: button('100%'),
      close: button('Close'),
      stage,
      image: stage?.querySelector('img') ?? dialog.querySelector('img'),
      readout: dialog.querySelector('output'),
    };
  }

  function viewerState() {
    const parts = viewer();
    const active = document.activeElement;
    const focus = { name: accName(active), role: roleOf(active), tag: active?.tagName };
    const openCount = openDialogs().length;
    const viewport = { width: innerWidth, height: innerHeight };
    if (!parts) return { open: false, openCount, focus, viewport };
    const { dialog, stage, image, readout } = parts;
    const missing = Object.entries(parts).filter(([, element]) => !element).map(([key]) => key);
    const text = readout?.textContent.trim() ?? null;
    const percent = text?.match(/(\\d+(?:\\.\\d+)?)\\s*%/);
    return {
      open: true,
      openCount,
      focus,
      viewport,
      name: accName(dialog),
      missing,
      fitPressed: parts.fit?.getAttribute('aria-pressed') ?? null,
      actualPressed: parts.actual?.getAttribute('aria-pressed') ?? null,
      readout: text,
      percent: percent ? parseFloat(percent[1]) : null,
      stageFocused: Boolean(stage) && active === stage,
      image: image ? { ...measureImage(image), cssWidth: round(image.getBoundingClientRect().width) } : null,
      stage: stage ? {
        box: clientBox(stage),
        scrollTop: stage.scrollTop,
        scrollLeft: stage.scrollLeft,
        maxTop: stage.scrollHeight - stage.clientHeight,
        maxLeft: stage.scrollWidth - stage.clientWidth,
      } : null,
    };
  }

  // A point that lands on the dialog element itself, outside its panel, which is how a click on
  // the backdrop reaches it.
  function backdropPoint() {
    const dialog = viewer()?.dialog;
    if (!dialog) return null;
    const insets = [6, 24, 0.1];
    for (const inset of insets) {
      const dx = inset < 1 ? innerWidth * inset : inset;
      const dy = inset < 1 ? innerHeight * inset : inset;
      for (const [x, y] of [
        [dx, dy], [innerWidth - dx, dy], [dx, innerHeight - dy], [innerWidth - dx, innerHeight - dy],
        [innerWidth / 2, dy], [innerWidth / 2, innerHeight - dy], [dx, innerHeight / 2], [innerWidth - dx, innerHeight / 2],
      ]) {
        if (document.elementFromPoint(x, y) === dialog) return { x, y };
      }
    }
    return null;
  }

  return { accName, find, openDialogs, measureGrid, viewer, viewerState, backdropPoint };
})(); true`;
