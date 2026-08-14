// File helpers: project file listing (for @ autocomplete), read/save with
// external-change detection, and lightweight watching for the editor panel.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next',
  '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.drafter-worktrees', '.desktopui-worktrees', '.claude-ui-worktrees']);

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

// 文本解码(v0.9.29,修乱码/误判):先认 BOM(UTF-8/16LE/16BE),无 BOM 严格校验
// UTF-8,失败则按 GBK 解码(中文 Windows 的代码文件常是 ANSI/GBK,按 UTF-8 硬解
// 会产生 � → 二进制误判拒收 + 编辑器乱码);GBK 不支持时兜底回 UTF-8。
function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.toString('utf8', 3);
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return buf.toString('utf8');
  } catch {
    try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
  }
}

function readFile(cwd, rel) {
  try {
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    const st = fs.statSync(abs);
    // v0.9.29:不再设大小上限(用户明确要求:不管多长都禁止截断)
    return { ok: true, content: decodeBuffer(fs.readFileSync(abs)), mtimeMs: st.mtimeMs, path: abs };
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
// v0.9.28:附件不限大小(去掉 5MB 上限)
function readImageBase64(absPath) {
  try {
    const ext = path.extname(absPath).toLowerCase();
    const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const mediaType = map[ext];
    if (!mediaType) return { ok: false, error: '不支持的图片格式:' + ext };
    const buf = fs.readFileSync(absPath);
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

// 文本附件按路径引用(v0.9.27):只采样前几 KB 供二进制检测,不读全文;
// v0.9.29:采样经 decodeBuffer 解码(GBK 文件不再被误判为二进制拒收)
function sampleFile(absPath, bytes = 4096) {
  try {
    const fd = fs.openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      const st = fs.statSync(absPath);
      return { ok: true, sample: decodeBuffer(buf.subarray(0, n)), size: st.size };
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 粘贴的文本没有磁盘路径:落盘到 userData/attachments/ 供 AI 按路径自行读取;
// v0.9.29:落盘前做二进制校验(含 �/NUL 或控制字符超 2% 判定为二进制,拒收)
function savePastedAttachment(userDataDir, name, content) {
  try {
    const sample = String(content || '').slice(0, 2000);
    if (sample.includes('�') || sample.includes('\0')
        || ((sample.match(/[\x00-\x08\x0e-\x1f]/g) || []).length >= sample.length * 0.02)) {
      return { ok: false, error: `不支持的二进制文件:${name}(附件支持图片、文本、音频/视频/3D 文件)` };
    }
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

module.exports = { listFiles, readFile, saveFile, watchFile, unwatchFile, readImageBase64, statFile, sampleFile, savePastedAttachment, decodeBuffer };
