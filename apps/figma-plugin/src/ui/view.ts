import type { PanelView, RowView } from './panel.ts';

export type ViewActions = {
  export: () => void;
  retry: () => void;
  dismiss: () => void;
  checkReceiver: () => void;
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`ui.html has no #${id}`);
  return found as T;
}

function setText(node: HTMLElement, text: string | null) {
  node.textContent = text ?? '';
  node.hidden = text === null;
}

function renderRow(row: RowView): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'row';
  item.dataset['state'] = row.state;

  const marker = document.createElement('span');
  marker.className = 'row-marker';
  marker.setAttribute('aria-hidden', 'true');

  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = row.name;
  name.title = row.name;

  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = row.label;

  item.append(marker, name, label);
  if (row.detail !== null) {
    const detail = document.createElement('p');
    detail.className = 'row-detail';
    detail.textContent = row.detail;
    detail.title = row.detail;
    item.append(detail);
  }
  return item;
}

// All received text, layer names included, goes through textContent. Nothing here
// builds markup from a string.
export function createView(actions: ViewActions) {
  const receiver = element('receiver');
  const receiverText = element('receiver-text');
  const receiverHint = element('receiver-hint');
  const checkAgain = element<HTMLButtonElement>('check-again');
  const selectionTitle = element('selection-title');
  const selectionDetail = element('selection-detail');
  const unidentified = element('unidentified');
  const intro = element('intro');
  const rows = element('rows');
  const notice = element('notice');
  const primary = element<HTMLButtonElement>('primary');
  const dismiss = element<HTMLButtonElement>('dismiss');

  let primaryAction: PanelView['primary']['action'] = null;

  primary.addEventListener('click', () => {
    if (primaryAction !== null) actions[primaryAction]();
  });
  dismiss.addEventListener('click', actions.dismiss);
  checkAgain.addEventListener('click', actions.checkReceiver);

  return function render(view: PanelView) {
    receiver.dataset['status'] = view.receiver.status;
    setText(receiverText, view.receiver.text);
    setText(receiverHint, view.receiver.hint);
    checkAgain.hidden = view.receiver.status !== 'offline';

    setText(selectionTitle, view.selection.title);
    selectionTitle.title = view.selection.title;
    setText(selectionDetail, view.selection.detail);
    selectionDetail.title = view.selection.detail ?? '';
    setText(unidentified, view.unidentifiedNote);

    intro.hidden = view.rows.length > 0;
    rows.hidden = view.rows.length === 0;
    rows.replaceChildren(...view.rows.map(renderRow));
    rows.querySelector('[data-state="reading"], [data-state="sending"]')?.scrollIntoView({
      block: 'nearest',
    });

    setText(notice, view.notice?.text ?? null);
    notice.dataset['tone'] = view.notice?.tone ?? '';

    primaryAction = view.primary.action;
    primary.textContent = view.primary.label;
    primary.disabled = view.primary.action === null;
    dismiss.hidden = !view.canDismiss;
  };
}
