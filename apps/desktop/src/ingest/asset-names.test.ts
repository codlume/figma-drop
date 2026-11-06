import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { placeAssets } from './asset-names';

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;

function asset(name: string, content = 'bytes') {
  return { name, bytes: Buffer.from(content) };
}

function names(...assets: { name: string; bytes: Buffer }[]): string[] {
  return placeAssets(assets).map(({ name }) => name);
}

function digest8(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

describe('placeAssets', () => {
  it.each([
    'img-1.png',
    'Icon_Close.abc123.svg',
    '0123456789abcdef.webp',
    '-leading-dash',
    'constructor',
    '__proto__',
    'a'.repeat(120),
  ])('keeps %s verbatim', (name) => {
    expect(names(asset(name))).toEqual([name]);
  });

  it.each([
    ['dot dot', '..'],
    ['dot', '.'],
    ['empty', ''],
    ['leading dot', '.bashrc'],
    ['traversal', '../../etc/passwd'],
    ['absolute path', '/etc/passwd'],
    ['backslash traversal', '..\\..\\windows'],
    ['separator', 'a/b.png'],
    ['NUL', 'a\u0000b.png'],
    ['newline suffix', 'img.png\n'],
    ['non-ASCII', 'zdjęcie.png'],
    ['only non-ASCII', '日本語'],
    ['lone surrogate', '\ud800.png'],
    ['too long', `${'a'.repeat(5000)}.png`],
    ['one over the limit', 'a'.repeat(121)],
    ['long extension', `a.${'b'.repeat(200)}`],
    ['separators throughout', '/'.repeat(5000)],
  ])('lands a %s name in one safe segment', (_label, name) => {
    const [placed] = names(asset(name));
    expect(placed).toMatch(SEGMENT);
    expect(placed).not.toBe(name);
  });

  it('suffixes an unsafe name with the hash of the original, before the extension', () => {
    expect(names(asset('my icon.png'))).toEqual([`my-icon-${digest8('my icon.png')}.png`]);
  });

  it('uses `asset` when no slug survives', () => {
    expect(names(asset('...'))).toEqual([`asset-${digest8('...')}`]);
  });

  it('keeps a safe extension through a 120 character cap', () => {
    const [placed] = names(asset(`${'a'.repeat(300)}.png`));
    expect(placed).toHaveLength(120);
    expect(placed?.endsWith('.png')).toBe(true);
  });

  it('keeps distinct hostile names apart', () => {
    const placed = names(asset('a b'), asset('a/b'), asset('a\\b'));
    expect(new Set(placed).size).toBe(3);
  });

  it('writes one file for the same name and bytes', () => {
    expect(names(asset('a.png'), asset('a.png'))).toEqual(['a.png']);
  });

  it('writes one file for a case-only pair with the same bytes', () => {
    expect(names(asset('a.png'), asset('A.PNG'))).toEqual(['a.png']);
  });

  it('keeps both of a case-only pair with different bytes', () => {
    const placed = placeAssets([asset('Logo.png', 'one'), asset('logo.png', 'two')]);
    expect(placed.map(({ name }) => name)).toEqual(['Logo.png', `logo-${digest8('two')}.png`]);
    expect(placed.map(({ bytes }) => bytes.toString())).toEqual(['one', 'two']);
  });

  it('keeps every variant of one name with different bytes', () => {
    const placed = placeAssets(['one', 'two', 'three'].map((text) => asset('a.png', text)));
    expect(placed.map(({ bytes }) => bytes.toString())).toEqual(['one', 'two', 'three']);
    expect(new Set(placed.map(({ name }) => name.toLowerCase())).size).toBe(3);
  });

  it('survives a name that pre-empts the clash suffix', () => {
    const preempting = `a-${digest8('two')}.png`;
    const placed = placeAssets([
      asset(preempting, 'zero'),
      asset('a.png', 'one'),
      asset('a.png', 'two'),
    ]);
    expect(placed.map(({ bytes }) => bytes.toString())).toEqual(['zero', 'one', 'two']);
    expect(new Set(placed.map(({ name }) => name)).size).toBe(3);
  });

  it('holds a clash on a 120 character name to the cap', () => {
    const name = `${'a'.repeat(116)}.png`;
    const placed = placeAssets([asset(name, 'one'), asset(name, 'two')]);
    expect(placed).toHaveLength(2);
    for (const { name: placedName } of placed) expect(placedName).toMatch(SEGMENT);
  });

  it('handles a huge separator-heavy name in linear time', () => {
    const name = '-.'.repeat(5_000_000);
    const [placed] = names(asset(name));
    expect(placed).toMatch(SEGMENT);
  });
});
