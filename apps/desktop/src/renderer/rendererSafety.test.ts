import { describe, expect, it } from 'vite-plus/test';

type Rule = { readonly name: string; readonly pattern: RegExp };

const rules: readonly Rule[] = [
  {
    name: 'raw HTML injection',
    pattern: /dangerouslySetInnerHTML|\.(inner|outer)HTML\b|insertAdjacentHTML|document\.write/,
  },
  {
    name: 'embedded document',
    pattern:
      /<(iframe|webview|object|embed|frame|portal)\b|\bsrcDoc\b|createElement\(\s*["'`](iframe|webview|object|embed|script)/i,
  },
  { name: 'href in the renderer', pattern: /\bhref\s*=|\.href\b|\bxlinkHref\b|window\.open\(/ },
  { name: 'script or stylesheet element', pattern: /<(script|link|base)\b/ },
  { name: 'code from a string', pattern: /\beval\(|new Function\(/ },
  {
    name: 'Node or Electron access',
    pattern:
      /ipcRenderer|\brequire\(|from\s+["'](node:|electron|fs\b|path\b|child_process)|\bprocess\.(env|versions)\b/,
  },
  { name: 'synthetic data in production', pattern: /from\s+["'][^"']*synthetic\// },
];

const imgTag = /<img\b[\s\S]*?\/>/g;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function findViolations(file: string, source: string): readonly string[] {
  const code = withoutComments(source);
  const broken = rules.filter((rule) => rule.pattern.test(code)).map((rule) => rule.name);
  for (const tag of code.match(imgTag) ?? []) {
    if (!/referrerPolicy="no-referrer"/.test(tag)) broken.push('<img> without no-referrer');
    if (!/draggable=\{false\}/.test(tag)) broken.push('<img> that can be dragged');
  }
  if (/<img\b/.test(code) && !file.endsWith('/PreviewImage.tsx')) {
    broken.push('<img> outside PreviewImage');
  }
  return broken.map((name) => `${file}: ${name}`);
}

const sources = import.meta.glob<string>(
  ['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}', '!./synthetic/**'],
  { query: '?raw', import: 'default', eager: true },
);

describe('renderer safety', () => {
  it('scans the real renderer sources', () => {
    expect(Object.keys(sources)).toEqual(
      expect.arrayContaining(['./App.tsx', './PreviewImage.tsx', './ReceiverControl.tsx']),
    );
  });

  it('finds no banned construct in any renderer source', () => {
    const violations = Object.entries(sources).flatMap(([file, source]) =>
      findViolations(file, source),
    );
    expect(violations).toEqual([]);
  });

  it.each([
    ['<div dangerouslySetInnerHTML={{ __html: name }} />', 'raw HTML injection'],
    ['element.innerHTML = name;', 'raw HTML injection'],
    ['<iframe src={url} />', 'embedded document'],
    ['<webview src={url} />', 'embedded document'],
    ['<object data={url} />', 'embedded document'],
    ['<embed src={url} />', 'embedded document'],
    ['<div srcDoc={html} />', 'embedded document'],
    ['<a href={url}>open</a>', 'href in the renderer'],
    ['<script src="x" />', 'script or stylesheet element'],
    ['eval(text);', 'code from a string'],
    ['import { ipcRenderer } from "electron";', 'Node or Electron access'],
    ['import fs from "node:fs";', 'Node or Electron access'],
    ['import { fixtures } from "./synthetic/fixtures.ts";', 'synthetic data in production'],
    ['<img src={url} alt="" />', '<img> without no-referrer'],
    ['<img src={url} referrerPolicy="no-referrer" alt="" />', '<img> that can be dragged'],
    [
      '<img src={url} referrerPolicy="no-referrer" draggable={false} />',
      '<img> outside PreviewImage',
    ],
  ])('catches %s', (snippet, rule) => {
    expect(findViolations('./Planted.tsx', snippet)).toContain(`./Planted.tsx: ${rule}`);
  });
});
