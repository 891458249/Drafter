// Renderer error logging: append-only JSONL at userData/logs/renderer-errors.log.
// Rotates to renderer-errors.log.1 when over 2MB (one generation kept).
// Records error metadata ONLY — never write API keys, user message bodies,
// or any other sensitive content here.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;
const FILE_NAME = 'renderer-errors.log';

function logsDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function logPath() {
  return path.join(logsDir(), FILE_NAME);
}

function rotateIfNeeded(p) {
  try {
    if (fs.existsSync(p) && fs.statSync(p).size > MAX_BYTES) {
      const bak = p + '.1';
      try { fs.unlinkSync(bak); } catch {}
      fs.renameSync(p, bak);
    }
  } catch {}
}

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

// entry: { source, message, stack, url, line, col } — metadata only
function logRendererError(entry = {}) {
  try {
    const p = logPath();
    rotateIfNeeded(p);
    const rec = {
      ts: new Date().toISOString(),
      source: clip(entry.source || 'renderer', 100),
      message: clip(entry.message, 2000),
      stack: clip(entry.stack, 4000),
      url: clip(entry.url, 500),
      line: Number.isFinite(entry.line) ? entry.line : null,
      col: Number.isFinite(entry.col) ? entry.col : null,
    };
    fs.appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    console.error('[logger] write failed:', e.message);
  }
}

module.exports = { logRendererError, logsDir, logPath };
