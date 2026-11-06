const MAX_SLUG_LENGTH = 80;

export function slug(text: string, fallback: string): string {
  const cleaned = text
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
  return cleaned || fallback;
}
