// Auto-update wiring (electron-updater, GitHub Releases provider — repo is
// public, no token needed). Every failure path degrades silently: update
// checks must never interrupt normal usage. Status is pushed to the renderer
// via the 'update:status' channel.
const { autoUpdater } = require('electron-updater');

let wired = false;

function send(getWindow, payload) {
  try {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('update:status', payload);
  } catch {}
}

function wireEvents(getWindow) {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = true;
  autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => send(getWindow, { state: 'checking' }));
  autoUpdater.on('update-available', (info) => send(getWindow, { state: 'available', version: info && info.version }));
  autoUpdater.on('update-not-available', () => send(getWindow, { state: 'latest' }));
  autoUpdater.on('download-progress', (p) => send(getWindow, { state: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', (info) => send(getWindow, { state: 'downloaded', version: info && info.version }));
  autoUpdater.on('error', () => send(getWindow, { state: 'idle' })); // 静默降级
}

// Call after app ready. Honors the "updateCheck" setting (default on).
function start(getWindow, store) {
  wireEvents(getWindow);
  if (store.getSetting('updateCheck') === false) return;
  // dev/unpackaged builds cannot check; checkForUpdates rejects — swallowed
  autoUpdater.checkForUpdates().catch(() => {});
}

// Manual re-check from the renderer (works even when the auto toggle is off).
function checkNow(getWindow) {
  wireEvents(getWindow);
  autoUpdater.checkForUpdates().catch(() => {});
}

function installAndRestart() {
  autoUpdater.quitAndInstall();
}

module.exports = { start, checkNow, installAndRestart };
