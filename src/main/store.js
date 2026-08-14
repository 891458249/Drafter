// Persistence: settings, recent projects, session metadata, per-session event logs.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const STORE_PATH = () => path.join(app.getPath('userData'), 'drafter-store.json');
// v0.9.35 更名 Drafter:旧文件名按新到旧只读兜底(不删不改),写入一律走新文件名
const STORE_PATH_LEGACY = () => [
  path.join(app.getPath('userData'), 'desktopui-store.json'),
  path.join(app.getPath('userData'), 'claude-ui-store.json'),
];
const SESSIONS_DIR = () => path.join(app.getPath('userData'), 'sessions');

function loadStore() {
  for (const f of [STORE_PATH(), ...STORE_PATH_LEGACY()]) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {}
  }
  return { recentProjects: [], settings: {}, sessions: [], cronJobs: [] };
}

function saveStore(store) {
  try {
    fs.writeFileSync(STORE_PATH(), JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.error('[store] save failed:', e.message);
  }
}

function update(fn) {
  const store = loadStore();
  const result = fn(store);
  saveStore(store);
  return result;
}

// --- recent projects ---
function addRecentProject(dir) {
  return update((s) => {
    s.recentProjects = (s.recentProjects || []).filter((p) => p !== dir);
    s.recentProjects.unshift(dir);
    s.recentProjects = s.recentProjects.slice(0, 12);
    return s.recentProjects;
  });
}

// --- settings ---
function getSetting(key, def = null) {
  const s = loadStore();
  return (s.settings && s.settings[key] !== undefined) ? s.settings[key] : def;
}

function setSetting(key, value) {
  update((s) => {
    s.settings = s.settings || {};
    if (value === null || value === undefined) delete s.settings[key];
    else s.settings[key] = value;
  });
}

// --- session metadata ---
// { id, sdkSessionId, cwd, title, model, permissionMode, createdAt, updatedAt,
//   archived, parentId (side chat), worktreePath }
function listSessions() {
  return loadStore().sessions || [];
}

function upsertSession(meta) {
  return update((s) => {
    s.sessions = s.sessions || [];
    const i = s.sessions.findIndex((x) => x.id === meta.id);
    if (i >= 0) s.sessions[i] = { ...s.sessions[i], ...meta, updatedAt: Date.now() };
    else s.sessions.push({ ...meta, createdAt: Date.now(), updatedAt: Date.now() });
    return s.sessions.find((x) => x.id === meta.id);
  });
}

function deleteSession(id) {
  update((s) => {
    s.sessions = (s.sessions || []).filter((x) => x.id !== id);
  });
  try { fs.unlinkSync(sessionLogPath(id)); } catch {}
}

// --- per-session event log (JSONL) for replay after restart/switch ---
function sessionLogPath(id) {
  return path.join(SESSIONS_DIR(), id + '.jsonl');
}

function appendSessionEvent(id, event) {
  try {
    fs.mkdirSync(SESSIONS_DIR(), { recursive: true });
    fs.appendFileSync(sessionLogPath(id), JSON.stringify(event) + '\n', 'utf8');
  } catch (e) {
    console.error('[store] appendSessionEvent failed:', e.message);
  }
}

function readSessionEvents(id, maxEvents = 2000) {
  try {
    const raw = fs.readFileSync(sessionLogPath(id), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const tail = lines.slice(-maxEvents);
    return tail.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// 整文件重写(编辑重生成截断 / 分支复制前缀用,v0.9.9)
function writeSessionEvents(id, events) {
  try {
    fs.mkdirSync(SESSIONS_DIR(), { recursive: true });
    fs.writeFileSync(sessionLogPath(id), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    return true;
  } catch (e) {
    console.error('[store] writeSessionEvents failed:', e.message);
    return false;
  }
}

// --- v0.9.9:编辑重生成 / 分支的历史锚点定位 ----------------------------------
// 在事件日志中定位用户消息 echo(type=ui_user_input,带发送时打戳的 uuid)。
// 返回 { ok, events, index, prevUuid, isFirst };prevUuid 是 echo 之前最后一条带
// uuid 的 assistant(优先)/user 事件,用作 resumeSessionAt 的上下文锚点。
function locateEcho(id, echoUuid) {
  const events = readSessionEvents(id, Number.MAX_SAFE_INTEGER);
  const i = events.findIndex((e) => e.type === 'ui_user_input' && e.uuid === echoUuid);
  if (i < 0) return { ok: false, error: '找不到目标消息(旧版本消息没有锚点)' };
  return { ok: true, events, index: i, prevUuid: lastAnchor(events, i), isFirst: i === 0 };
}

function lastAnchor(events, end) {
  let fallback = null;
  for (let k = end - 1; k >= 0; k--) {
    const e = events[k];
    if (!e || !e.uuid) continue;
    if (e.type === 'assistant') return e.uuid;
    if (e.type === 'user' && !fallback) fallback = e.uuid;
  }
  return fallback;
}

// 分支切片:从开头到目标 echo 所在回合结束(下一条 echo 之前或日志末尾)。
// 锚点 = 切片内最后一条带 uuid 的 assistant/user 事件(含该 echo 的回复)。
function branchSlice(events, index) {
  let end = events.length;
  for (let k = index + 1; k < events.length; k++) {
    if (events[k].type === 'ui_user_input') { end = k; break; }
  }
  const prefix = events.slice(0, end);
  return { prefix, anchorUuid: lastAnchor(prefix, prefix.length) };
}

// --- cumulative token usage per model (for the usage popover) ---
function addModelUsage(model, usage = {}, costUsd = 0) {
  update((s) => {
    s.modelUsage = s.modelUsage || {};
    const m = s.modelUsage[model] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    m.input += usage.input_tokens || 0;
    m.output += usage.output_tokens || 0;
    m.cacheRead += usage.cache_read_input_tokens || 0;
    m.cacheWrite += usage.cache_creation_input_tokens || 0;
    m.cost += costUsd || 0;
    s.modelUsage[model] = m;
  });
}

// --- cron jobs ---
// { id, label, prompt, cwd, hour, minute, everyMinutes, enabled, lastRunAt }
function listCronJobs() {
  return loadStore().cronJobs || [];
}

function saveCronJobs(jobs) {
  update((s) => { s.cronJobs = jobs; });
}

// --- projects ---
// { id, name, dirs: [primaryDir, ...], files: [{ path, tag: 'readonly'|'editable' }], createdAt }
function listProjects() {
  return loadStore().projects || [];
}

function upsertProject(p) {
  return update((s) => {
    s.projects = s.projects || [];
    const i = s.projects.findIndex((x) => x.id === p.id);
    if (i >= 0) s.projects[i] = { ...s.projects[i], ...p };
    else s.projects.push(p);
    return s.projects.find((x) => x.id === p.id);
  });
}

function deleteProject(id) {
  update((s) => {
    s.projects = (s.projects || []).filter((x) => x.id !== id);
  });
}

// --- per-key weekly/monthly quota buckets (v0.8.0) ---------------------------
// 滚动重置:周桶周一 00:00 起算,月桶每月 1 号 00:00 起算(本地时间)
function weekStartOf(t) {
  const d = new Date(t);
  const day = (d.getDay() + 6) % 7; // 周一 = 0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}
function monthStartOf(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

function addKeyUsage(keyId, costUsd = 0, usage = {}) {
  if (!keyId) keyId = 'unknown';
  const now = Date.now();
  const ws = weekStartOf(now), ms = monthStartOf(now);
  update((s) => {
    s.keyUsage = s.keyUsage || {};
    const u = s.keyUsage[keyId] || {};
    if (u.weekStart !== ws) { u.weekStart = ws; u.weekCost = 0; u.weekInput = 0; u.weekOutput = 0; }
    if (u.monthStart !== ms) { u.monthStart = ms; u.monthCost = 0; u.monthInput = 0; u.monthOutput = 0; }
    const it = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    const ot = usage.output_tokens || 0;
    u.weekCost += costUsd; u.monthCost += costUsd;
    u.weekInput += it; u.weekOutput += ot;
    u.monthInput += it; u.monthOutput += ot;
    s.keyUsage[keyId] = u;
  });
}

// 读取时也滚动(跨边界未写入的桶按新周期归零)
function getKeyUsage(keyId) {
  const u = (loadStore().keyUsage || {})[keyId];
  if (!u) return null;
  const now = Date.now();
  if (u.weekStart !== weekStartOf(now)) { u.weekStart = weekStartOf(now); u.weekCost = 0; u.weekInput = 0; u.weekOutput = 0; }
  if (u.monthStart !== monthStartOf(now)) { u.monthStart = monthStartOf(now); u.monthCost = 0; u.monthInput = 0; u.monthOutput = 0; }
  return u;
}

module.exports = {
  loadStore, saveStore, update,
  addRecentProject,
  getSetting, setSetting,
  listSessions, upsertSession, deleteSession,
  appendSessionEvent, readSessionEvents, writeSessionEvents, sessionLogPath,
  locateEcho, branchSlice,
  addModelUsage,
  listCronJobs, saveCronJobs,
  listProjects, upsertProject, deleteProject,
  addKeyUsage, getKeyUsage, weekStartOf, monthStartOf,
};
