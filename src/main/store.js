// Persistence: settings, recent projects, session metadata, per-session event logs.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const STORE_PATH = () => path.join(app.getPath('userData'), 'claude-ui-store.json');
const SESSIONS_DIR = () => path.join(app.getPath('userData'), 'sessions');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH(), 'utf8'));
  } catch {
    return { recentProjects: [], settings: {}, sessions: [], cronJobs: [] };
  }
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

module.exports = {
  loadStore, saveStore, update,
  addRecentProject,
  getSetting, setSetting,
  listSessions, upsertSession, deleteSession,
  appendSessionEvent, readSessionEvents, sessionLogPath,
  addModelUsage,
  listCronJobs, saveCronJobs,
  listProjects, upsertProject, deleteProject,
};
