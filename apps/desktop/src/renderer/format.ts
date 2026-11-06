const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const exactDateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

export function formatDate(iso: string): string {
  return dateTime.format(new Date(iso));
}

// Revisions of one node can land within a minute, as an A/B/A revert does.
export function formatExactDate(iso: string): string {
  return exactDateTime.format(new Date(iso));
}

export function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
