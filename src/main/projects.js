// Project groups: sessions are grouped under projects. A project owns
//  - dirs:  directories the project spans (first one is the primary dir)
//  - files: individually loaded files with a live read-only/editable tag
//  - a shared memory file (.claude-ui/memory.md in the primary dir) that all
//    sessions in the group read/write, so context flows across sessions and
//    survives app restarts.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const store = require('./store');

const norm = (p) => path.resolve(p).toLowerCase();

function list() { return store.listProjects(); }

function get(id) { return store.listProjects().find((p) => p.id === id) || null; }

function findByDir(dir) {
  const n = norm(dir);
  return store.listProjects().find((p) => (p.dirs || []).some((d) => norm(d) === n)) || null;
}

// Find the project that contains this path (as a dir, inside a dir, or as a file).
function findContaining(target) {
  const n = norm(target);
  for (const p of store.listProjects()) {
    for (const d of (p.dirs || [])) {
      const dn = norm(d);
      if (n === dn || n.startsWith(dn + path.sep)) return p;
    }
    for (const f of (p.files || [])) {
      if (norm(f.path) === n) return p;
    }
  }
  return null;
}

// Auto-create a project group for a directory that no session has used before.
function ensureForDir(dir) {
  const existing = findContaining(dir);
  if (existing) return existing;
  const p = {
    id: 'p_' + crypto.randomUUID().slice(0, 8),
    name: path.basename(dir) || dir,
    dirs: [dir],
    files: [],
    createdAt: Date.now(),
  };
  store.upsertProject(p);
  return p;
}

function rename(id, name) {
  const p = get(id);
  if (p) store.upsertProject({ id, name: String(name || '').trim() || p.name });
  return get(id);
}

function addDir(id, dir) {
  const p = get(id);
  if (!p) return null;
  const dirs = p.dirs || [];
  if (!dirs.some((d) => norm(d) === norm(dir))) dirs.push(dir);
  store.upsertProject({ id, dirs });
  return get(id);
}

function addFiles(id, paths, tag = 'editable') {
  const p = get(id);
  if (!p) return null;
  const files = p.files || [];
  for (const fp of paths) {
    if (!files.some((f) => norm(f.path) === norm(fp))) files.push({ path: fp, tag });
  }
  store.upsertProject({ id, files });
  return get(id);
}

function setTag(id, filePath, tag) {
  const p = get(id);
  if (!p) return null;
  const files = (p.files || []).map((f) =>
    norm(f.path) === norm(filePath) ? { ...f, tag } : f);
  store.upsertProject({ id, files });
  return get(id);
}

function removeFile(id, filePath) {
  const p = get(id);
  if (!p) return null;
  const files = (p.files || []).filter((f) => norm(f.path) !== norm(filePath));
  store.upsertProject({ id, files });
  return get(id);
}

function remove(id) { store.deleteProject(id); }

// --- read-only enforcement (consulted LIVE on every tool call) ---
function isReadonly(projectId, filePath) {
  const p = get(projectId);
  if (!p || !filePath) return false;
  const n = norm(filePath);
  for (const f of (p.files || [])) {
    if (f.tag !== 'readonly') continue;
    const fn = norm(f.path);
    if (n === fn || n.startsWith(fn + path.sep)) return true; // file or tagged folder
  }
  return false;
}

// --- shared memory -----------------------------------------------------------
function memoryPath(p) {
  return path.join((p.dirs && p.dirs[0]) || '.', '.claude-ui', 'memory.md');
}

function readMemory(p) {
  try { return fs.readFileSync(memoryPath(p), 'utf8'); } catch { return ''; }
}

function ensureMemoryFile(p) {
  const mp = memoryPath(p);
  try {
    fs.mkdirSync(path.dirname(mp), { recursive: true });
    if (!fs.existsSync(mp)) {
      fs.writeFileSync(mp, `# ${p.name} · 项目组共享记忆\n\n(所有会话共用。跨会话需要记住的结论、决定、进展请追加到这里。)\n`, 'utf8');
    }
  } catch {}
  return mp;
}

// System-prompt context injected into every session of the project group.
function contextFor(projectId, cwd) {
  const p = get(projectId);
  if (!p) return null;
  const mp = ensureMemoryFile(p);
  const mem = readMemory(p).slice(0, 8000);
  const extraDirs = (p.dirs || []).filter((d) => norm(d) !== norm(cwd));

  let text = `\n\n<claude-ui-project-group>\n`;
  text += `你运行在 Claude UI 的项目组「${p.name}」中,该组内可能有多个并行会话。\n`;
  text += `共享记忆文件:${mp}\n`;
  text += `规则:\n`;
  text += `1. 得出对项目后续工作有价值的结论、决定或阶段性进展时,主动用编辑工具把要点追加到共享记忆文件(保持精炼,一条一行)。\n`;
  text += `2. 开始复杂任务前,如需了解其他会话的进展,读取共享记忆文件。\n`;
  const files = p.files || [];
  if (files.length) {
    text += `\n项目组已加载的文件(标签实时生效):\n`;
    for (const f of files) {
      text += `- ${f.path} [${f.tag === 'readonly' ? '只读:严禁修改,仅可读取' : '可修改'}]\n`;
    }
    text += `被标记为只读的文件绝对不要用 Edit/Write 等工具修改;若任务需要修改,请先告知用户更改标签。\n`;
  }
  text += `\n当前共享记忆内容:\n${mem || '(空)'}\n</claude-ui-project-group>\n`;

  return { append: text, additionalDirectories: extraDirs, project: p };
}

module.exports = {
  list, get, findByDir, findContaining, ensureForDir,
  rename, addDir, addFiles, setTag, removeFile, remove,
  isReadonly, memoryPath, readMemory, ensureMemoryFile, contextFor,
};
