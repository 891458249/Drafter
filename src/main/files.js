// File helpers: project file listing (for @ autocomplete), read/save with
// external-change detection, and lightweight watching for the editor panel.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next',
  '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.claude-ui-worktrees']);

// List project files. Prefer `git ls-files` (fast, respects .gitignore);
// fall back to a bounded recursive walk.
function listFiles(cwd, limit = 5000) {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd, timeout: 10000, maxBuffer: 30 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (!err && stdout.trim()) {
          resolve(stdout.split('\n').filter(Boolean).slice(0, limit));
        } else {
          resolve(walk(cwd, limit));
        }
      });
  });
}

function walk(root, limit) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= limit) break;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(r);
      } else {
        out.push(r);
      }
    }
  }
  return out;
}

function readFile(cwd, rel) {
  try {
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    const st = fs.statSync(abs);
    if (st.size > 2 * 1024 * 1024) return { ok: false, error: '文件超过 2MB,不在编辑器中打开' };
    return { ok: true, content: fs.readFileSync(abs, 'utf8'), mtimeMs: st.mtimeMs, path: abs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Save with optimistic concurrency: refuse if file changed since expectedMtimeMs
// (unless force). Returns new mtime on success.
function saveFile(cwd, rel, content, expectedMtimeMs, force) {
  try {
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    if (!force && expectedMtimeMs && fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      if (Math.abs(st.mtimeMs - expectedMtimeMs) > 1) {
        return { ok: false, conflict: true, error: '文件已被外部修改' };
      }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return { ok: true, mtimeMs: fs.statSync(abs).mtimeMs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Watch a single file; cb() on change. Returns unwatch fn.
const watchers = new Map(); // key -> fs.FSWatcher
function watchFile(key, absPath, cb) {
  unwatchFile(key);
  try {
    const w = fs.watch(absPath, { persistent: false }, () => cb());
    watchers.set(key, w);
  } catch {}
}
function unwatchFile(key) {
  const w = watchers.get(key);
  if (w) { try { w.close(); } catch {} watchers.delete(key); }
}

// Read an image file as base64 for chat attachments.
function readImageBase64(absPath) {
  try {
    const ext = path.extname(absPath).toLowerCase();
    const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const mediaType = map[ext];
    if (!mediaType) return { ok: false, error: '不支持的图片格式:' + ext };
    const buf = fs.readFileSync(absPath);
    if (buf.length > 5 * 1024 * 1024) return { ok: false, error: '图片超过 5MB' };
    return { ok: true, mediaType, data: buf.toString('base64'), name: path.basename(absPath) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 取文件大小/名称(媒体附件卡片用;媒体本体在辅助分析时才读取)
function statFile(absPath) {
  try {
    const st = fs.statSync(absPath);
    return { ok: true, size: st.size, name: path.basename(absPath) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 文本附件按路径引用(v0.9.27):只采样前几 KB 供二进制检测,不读全文
function sampleFile(absPath, bytes = 4096) {
  try {
    const fd = fs.openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      const st = fs.statSync(absPath);
      return { ok: true, sample: buf.toString('utf8', 0, n), size: st.size };
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 粘贴的文本没有磁盘路径:落盘到 userData/attachments/ 供 AI 按路径自行读取
function savePastedAttachment(userDataDir, name, content) {
  try {
    const dir = path.join(userDataDir, 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || 'pasted.txt').replace(/[<>:"|?*\\/]/g, '_').slice(-80);
    const p = path.join(dir, Date.now() + '-' + safe);
    fs.writeFileSync(p, content, 'utf8');
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { listFiles, readFile, saveFile, watchFile, unwatchFile, readImageBase64, statFile, sampleFile, savePastedAttachment };
