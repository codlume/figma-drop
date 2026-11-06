import { useRef, useState, type KeyboardEvent } from 'react';

function arrowColumns(items: readonly HTMLElement[]): number {
  const firstTop = items[0]?.offsetTop;
  const columns = items.filter((item) => item.offsetTop === firstTop).length;
  return columns >= items.length ? 1 : columns;
}

function targetIndex(key: string, index: number, count: number, columns: number): number | null {
  const last = count - 1;
  const clamp = (value: number) => Math.min(Math.max(value, 0), last);
  const rowChange = (value: number) => {
    const target = clamp(value);
    return Math.floor(target / columns) === Math.floor(index / columns) ? index : target;
  };
  switch (key) {
    case 'ArrowLeft':
      return clamp(index - 1);
    case 'ArrowRight':
      return clamp(index + 1);
    case 'ArrowUp':
      return rowChange(index - columns);
    case 'ArrowDown':
      return rowChange(index + columns);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

export function useListNavigation<Id>(
  ids: readonly Id[],
  selectedId: Id | null,
  onSelect: (id: Id) => void,
) {
  const elements = useRef(new Map<Id, HTMLElement>());
  const [focusedId, setFocusedId] = useState<Id | null>(null);
  const tabStop =
    focusedId !== null && ids.includes(focusedId) ? focusedId : (selectedId ?? ids[0] ?? null);

  function handleKeyDown(event: KeyboardEvent, id: Id) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(id);
      return;
    }
    const items = ids.flatMap((item) => elements.current.get(item) ?? []);
    const target = targetIndex(event.key, ids.indexOf(id), items.length, arrowColumns(items));
    if (target === null) return;
    event.preventDefault();
    items[target]?.focus();
  }

  return function optionProps(id: Id) {
    return {
      role: 'option',
      'aria-selected': id === selectedId,
      tabIndex: id === tabStop ? 0 : -1,
      ref: (element: HTMLElement | null) => {
        if (element) elements.current.set(id, element);
        else elements.current.delete(id);
      },
      onClick: () => onSelect(id),
      onFocus: () => setFocusedId(id),
      onKeyDown: (event: KeyboardEvent) => handleKeyDown(event, id),
    } as const;
  };
}
