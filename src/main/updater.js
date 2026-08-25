// Auto-update wiring (electron-updater, GitHub Releases provider — repo is
// public, no token needed). Every failure path degrades silently: update
// checks must never interrupt normal usage. Status is pushed to the renderer
// via the 'update:status' channel.
// electron-updater 惰性加载:顶层 require 在非 Electron 环境(单测)会崩。
let _autoUpdater = null;
function getAutoUpdater() {
  if (!_autoUpdater) _autoUpdater = require('electron-updater').autoUpdater;
  return _autoUpdater;
}
const https = require('https');

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
  const autoUpdater = getAutoUpdater();
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
  getAutoUpdater().checkForUpdates().catch(() => {});
}

// Manual re-check from the renderer (works even when the auto toggle is off).
function checkNow(getWindow) {
  wireEvents(getWindow);
  getAutoUpdater().checkForUpdates().catch(() => {});
}

function installAndRestart() {
  try { require('electron').app.isQuitting = true; } catch {}
  getAutoUpdater().quitAndInstall();
}

// ---------------------------------------------------------------------------
// GitHub 仓库版本检查(v0.10.3):直接读 GitHub API 的 latest release tag,
// 与当前 app.getVersion() 比较。不依赖 electron-updater 的 dev 限制,
// 开发环境也能用;网络失败一律静默降级。
// ---------------------------------------------------------------------------
function compareSemver(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// 走 github.com/releases/latest 的 302 重定向取 tag,不消耗 API 配额
// (api.github.com 未鉴权 60 次/小时/IP,共享出口 IP 极易撞限)。
function fetchLatestRelease() {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'github.com',
      path: '/891458249/Drafter/releases/latest',
      headers: { 'User-Agent': 'Drafter-App' },
      timeout: 10000,
    }, (res) => {
      res.resume(); // 只要 header,丢弃 body
      const loc = res.headers.location || '';
      const m = loc.match(/\/releases\/tag\/([^/?#]+)/);
      if ((res.statusCode === 301 || res.statusCode === 302) && m) {
        const tag = decodeURIComponent(m[1]);
        resolve({ ok: true, tag, url: loc });
      } else {
        resolve({ ok: false });
      }
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
  });
}

// 返回 { current, latest, hasUpdate, url } 或 { error }
async function checkRepoVersion() {
  try {
    const { app } = require('electron');
    const current = app.getVersion();
    const rel = await fetchLatestRelease();
    if (!rel.ok || !rel.tag) return { current, error: '无法获取仓库版本(网络或 API 限制)' };
    const latest = rel.tag.replace(/^v/, '');
    return { current, latest, hasUpdate: compareSemver(latest, current) > 0, url: rel.url };
  } catch (e) {
    return { error: e.message || '检查失败' };
  }
}

module.exports = { start, checkNow, installAndRestart, checkRepoVersion, compareSemver };
