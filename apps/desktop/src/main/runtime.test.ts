import { describe, expect, it } from 'vite-plus/test';

import { resolveRuntime } from './runtime.ts';

const paths = { home: '/Users/me', appData: '/Users/me/Library/Application Support' };
const packaged = { ...paths, isPackaged: true };
const unpackaged = { ...paths, isPackaged: false };

describe('resolveRuntime', () => {
  it('points a packaged app at the real library and the manifest port', () => {
    expect(resolveRuntime({}, packaged)).toEqual({
      userData: '/Users/me/Library/Application Support/figma-drop',
      library: '/Users/me/figma-drop',
      port: 3579,
      testMode: false,
      devServerUrl: null,
    });
  });

  it('ignores every override in a packaged app', () => {
    const env = {
      FIGMA_DROP_USER_DATA: '/tmp/data',
      FIGMA_DROP_LIBRARY: '/tmp/library',
      FIGMA_DROP_PORT: 'not a port',
      FIGMA_DROP_TEST: '1',
      VITE_DEV_SERVER_URL: 'http://localhost:1/',
    };
    expect(resolveRuntime(env, packaged)).toEqual(resolveRuntime({}, packaged));
  });

  it('keeps a development build away from the real library and port by default', () => {
    expect(resolveRuntime({}, unpackaged)).toEqual({
      userData: '/Users/me/Library/Application Support/figma-drop-dev',
      library: '/Users/me/Library/Application Support/figma-drop-dev/library',
      port: 13579,
      testMode: false,
      devServerUrl: null,
    });
  });

  it('nests the default library under an overridden user data directory', () => {
    const runtime = resolveRuntime({ FIGMA_DROP_USER_DATA: '/tmp/data' }, unpackaged);
    expect(runtime.userData).toBe('/tmp/data');
    expect(runtime.library).toBe('/tmp/data/library');
  });

  it('reaches the real library and port when the environment names them', () => {
    const env = { FIGMA_DROP_LIBRARY: '/Users/me/figma-drop', FIGMA_DROP_PORT: '3579' };
    const runtime = resolveRuntime(env, unpackaged);
    expect(runtime.library).toBe('/Users/me/figma-drop');
    expect(runtime.port).toBe(3579);
  });

  it('treats an empty override as unset', () => {
    const env = { FIGMA_DROP_LIBRARY: '', FIGMA_DROP_PORT: '', VITE_DEV_SERVER_URL: '' };
    expect(resolveRuntime(env, unpackaged)).toEqual(resolveRuntime({}, unpackaged));
  });

  it.each(['abc', '0', '65536', '-1', '35.79'])('refuses the port %s', (port) => {
    expect(() => resolveRuntime({ FIGMA_DROP_PORT: port }, unpackaged)).toThrow(port);
  });

  it('turns test mode on only for the exact flag', () => {
    expect(resolveRuntime({ FIGMA_DROP_TEST: '1' }, unpackaged).testMode).toBe(true);
    expect(resolveRuntime({ FIGMA_DROP_TEST: 'true' }, unpackaged).testMode).toBe(false);
  });
});
