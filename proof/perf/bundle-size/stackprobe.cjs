// Prints where a stack trace places an error thrown inside main.cjs's top level, to show what a
// trace from that bundle looks like with and without --enable-source-maps.
// usage: node [--enable-source-maps] stackprobe.cjs <appDir>/dist-electron/main.cjs
const path = require('node:path');

const { stubElectron } = require('./electron-stub.cjs');

stubElectron(() => {
  throw new Error('probe');
});
const file = path.resolve(process.argv[2]);
const appDir = path.dirname(path.dirname(file));
try {
  require(file);
} catch (error) {
  const frame = error.stack.split('\n').find((line) => line.includes(appDir));
  console.log(frame.trim().replace(appDir, '<app>'));
}
