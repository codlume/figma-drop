import { createHash } from 'node:crypto';

export type NamedAsset = { name: string; bytes: Buffer };

const MAX_NAME_LENGTH = 120;
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;
const SAFE_EXTENSION = /\.[A-Za-z0-9]{1,16}$/;
const LONGEST_EXTENSION = 17;

function shortDigest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

// Slices before any pattern runs, so a hostile name of any length costs the same.
function suffixedName(name: string, suffix: string): string {
  const extension = SAFE_EXTENSION.exec(name.slice(-LONGEST_EXTENSION))?.[0] ?? '';
  const room = MAX_NAME_LENGTH - extension.length - suffix.length - 1;
  const slug = name
    .slice(0, name.length - extension.length)
    .slice(0, room)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
  return `${slug || 'asset'}-${suffix}${extension}`;
}

function safeAssetName(name: string): string {
  return SAFE_NAME.test(name) ? name : suffixedName(name, shortDigest(name));
}

// Gives each asset one safe path segment. Names compare lowercased because the
// default APFS volume is case-insensitive. Different bytes never share a name,
// so a clash gets a suffix from its bytes, and a hostile name that already
// equals that suffixed form gets a counter on top.
export function placeAssets(assets: readonly NamedAsset[]): NamedAsset[] {
  const placed = new Map<string, NamedAsset>();
  for (const { name, bytes } of assets) {
    let candidate = safeAssetName(name);
    for (let clash = 0; ; clash += 1) {
      const holder = placed.get(candidate.toLowerCase());
      if (!holder) {
        placed.set(candidate.toLowerCase(), { name: candidate, bytes });
        break;
      }
      if (holder.bytes.equals(bytes)) break;
      const digest = shortDigest(bytes);
      candidate = suffixedName(name, clash === 0 ? digest : `${digest}-${clash}`);
    }
  }
  return [...placed.values()];
}
