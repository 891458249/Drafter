// E2E harness (manual run, not part of `npm test`):
//   node_modules/.bin/electron test/e2e-renderer-error.js
// Verifies the real console-message → logger.js path in actual Electron:
// a hidden window emits console.error, the same handler wiring as main.js
// (level >= 2) persists it to <isolated userData>/logs/renderer-errors.log.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../src/main/logger');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ui-e2e-'));
app.setPath('userData', tmp); // 隔离,不碰真实 userData

app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  // 与 main.js 中相同的处理逻辑
  w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) logger.logRendererError({ source: 'console', message, url: sourceId, line });
  });
  w.loadURL('data:text/html,<script>console.error("e2e-smoke-renderer-error")</script>');
  setTimeout(() => {
    const p = logger.logPath();
    const ok = fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('e2e-smoke-renderer-error');
    console.log('E2E log file:', p);
    console.log(ok ? 'E2E PASS: console.error persisted to renderer-errors.log' : 'E2E FAIL');
    app.exit(ok ? 0 : 1);
  }, 2500);
});
