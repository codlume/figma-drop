// A window with a static page and nothing else: the idle floor Electron sets on this machine.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.setPath('userData', process.env.FIGMA_DROP_USER_DATA);
app.on('window-all-closed', () => {});
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1040, height: 680 });
  window.loadFile(path.join(__dirname, 'index.html'));
});
