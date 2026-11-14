// Makes `require('electron')` return a stub, so an Electron entry bundle's top level runs in plain
// Node up to the point where it waits on Electron. `app.whenReady()` never resolves.
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');

const STUB_KEY = Symbol.for('figma-drop.electron-stub');

exports.stubElectron = (getPath = (name) => `/nonexistent-figma-drop-loadtime/${name}`) => {
  const never = new Promise(() => {});
  // `then` is absent so that awaiting the stub does not treat it as a promise.
  const fixed = new Map([
    ['then', undefined],
    ['whenReady', () => never],
    ['getPath', getPath],
    ['isPackaged', false],
  ]);
  const stub = new Proxy(function stub() {}, {
    get: (_target, prop) => (fixed.has(prop) ? fixed.get(prop) : stub),
    apply: () => stub,
    construct: () => stub,
  });
  globalThis[STUB_KEY] = stub;
  const stubUrl = pathToFileURL(`${__dirname}/electron-stub-module.cjs`).href;
  registerHooks({
    resolve: (specifier, context, nextResolve) =>
      specifier === 'electron' || specifier.startsWith('electron/')
        ? { url: stubUrl, format: 'commonjs', shortCircuit: true }
        : nextResolve(specifier, context),
    load: (url, context, nextLoad) =>
      url === stubUrl
        ? {
            format: 'commonjs',
            source: `module.exports = globalThis[Symbol.for('figma-drop.electron-stub')];`,
            shortCircuit: true,
          }
        : nextLoad(url, context),
  });
};
