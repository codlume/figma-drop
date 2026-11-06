import { readFileSync } from 'node:fs';
import { RECEIVER_ORIGIN } from '@figma-drop/export-contract';
import { describe, expect, it } from 'vite-plus/test';

const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

describe('manifest', () => {
  it('allows exactly the origin the transport posts to', () => {
    expect(manifest.networkAccess.allowedDomains).toEqual([RECEIVER_ORIGIN]);
  });

  it('points at the built artifacts', () => {
    expect(manifest.main).toBe('dist/code.js');
    expect(manifest.ui).toBe('dist/ui.html');
  });

  it('asks for the file key', () => {
    expect(manifest.enablePrivatePluginApi).toBe(true);
  });
});
