const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');

// 允许通过环境变量覆盖 userData(便携模式/并行实例/隔离测试)
if (process.env.CLAUDE_UI_USERDATA) {
  app.setPath('userData', process.env.CLAUDE_UI_USERDATA);
}

const store = require('./src/main/store');
const git = require('./src/main/git');
const files = require('./src/main/files');
const commands = require('./src/main/commands');
const mcp = require('./src/main/mcp');
const scheduler = require('./src/main/scheduler');
const projects = require('./src/main/projects');
const logger = require('./src/main/logger');
const perms = require('./src/main/perms');
const updater = require('./src/main/updater');
const keys = require('./src/main/keys');
const { TermManager } = require('./src/main/terminal');
const { SessionManager } = require('./src/main/sessions');

let mainWindow = null;
const getWindow = () => mainWindow;

// --- GPU / disk cache hardening ---------------------------------------------
// Startup logs showed cache_util_win.cc "Unable to move the cache: 拒绝访问
// (0x5)" and disk_cache / gpu_disk_cache creation failures. Root cause: the
// default Chromium cache dirs under userData (Cache / GPUCache / Code Cache)
// can end up locked by a second instance or a killed process, or owned by a
// different user after runs with different identities, so the cache move at
// startup fails with access denied. Mitigations:
//  a. pin the disk cache to a dedicated subdir (userData/cache), sidestepping
//     whatever state the default dirs are in
//  b. log GPU process crashes; allow disabling hardware acceleration via the
//     "disableGpu" setting (default: acceleration stays enabled)
//  c. single-instance lock so two app instances can never fight over the cache
app.commandLine.appendSwitch('disk-cache-dir', path.join(app.getPath('userData'), 'cache'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.on('gpu-process-crashed', (_e, killed) => {
  console.error('[main] gpu-process-crashed, killed =', killed);
  logger.logRendererError({ source: 'gpu-process', message: 'GPU 进程崩溃,killed=' + killed });
});

if (store.getSetting('disableGpu')) {
  app.disableHardwareAcceleration();
}

// Env for child processes: inject the ACTIVE API key if present.
// Explicitly neutralize the other credential/env vars so per-key switching
// wins over ~/.claude/settings.json env and inherited process env.
function buildEnv(extra = {}) {
  const env = { ...process.env, FORCE_COLOR: '0', ...extra };
  const k = keys.activeKey();
  if (k) {
    if (k.kind === 'authToken') {
      env.ANTHROPIC_AUTH_TOKEN = k.key;
      env.ANTHROPIC_API_KEY = '';
    } else {
      env.ANTHROPIC_API_KEY = k.key;
      env.ANTHROPIC_AUTH_TOKEN = '';
    }
    env.ANTHROPIC_BASE_URL = k.baseUrl || 'https://api.anthropic.com';
  }
  return env;
}

const sessions = new SessionManager(getWindow, buildEnv);
const terms = new TermManager(getWindow, buildEnv);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#1a1815',
    title: 'Claude UI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // preview panel
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  // persist renderer errors (level >= 2) to userData/logs/renderer-errors.log
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      logger.logRendererError({ source: 'console', message, url: sourceId, line });
    }
  });
}

app.whenReady().then(() => {
  // auto-update: check GitHub Releases in the background (silent on failure)
  updater.start(getWindow, store);
  // migration: attach legacy sessions (created before project groups) to projects
  // (standalone/chat sessions are intentionally project-less — never migrate them)
  try {
    for (const meta of store.listSessions()) {
      if (meta.projectId || !meta.cwd || meta.standalone || meta.kind === 'chat') continue;
      const baseDir = meta.worktreePath
        ? path.dirname(path.dirname(meta.worktreePath))
        : meta.cwd;
      const p = projects.ensureForDir(baseDir);
      store.upsertSession({ id: meta.id, projectId: p.id });
    }
  } catch (e) {
    console.error('[main] project migration failed:', e.message);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // scheduler: on fire, create a fresh session in the job's cwd and send the prompt
  scheduler.start((job) => {
    try {
      const meta = sessions.create({ cwd: job.cwd, title: '⏰ ' + (job.label || '定时任务') });
      const s = sessions.get(meta.id);
      if (s) s.send(job.prompt);
      sessions.send('cron:fired', { jobId: job.id, sessionId: meta.id });
    } catch (e) {
      console.error('[cron] fire failed:', e.message);
    }
  });
});

app.on('window-all-closed', () => {
  sessions.stopAll();
  terms.closeAll();
  scheduler.stop();
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC: store / dialog / api key
// ---------------------------------------------------------------------------
ipcMain.handle('store:get', () => {
  const s = store.loadStore();
  const { settings = {}, ...rest } = s;
  const { apiKey, apiKeys, ...safe } = settings; // 完整 key 不出主进程(多 key 见 keys:list)
  return { ...rest, settings: safe };
});

ipcMain.handle('store:setSetting', (_e, { key, value }) => {
  if (key === 'apiKey') return false; // use apikey:set
  store.setSetting(key, value);
  return true;
});

ipcMain.handle('dialog:pickDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  const dir = res.filePaths[0];
  const recent = store.addRecentProject(dir);
  return { dir, recent };
});

ipcMain.handle('store:addRecent', (_e, dir) => store.addRecentProject(dir));

ipcMain.handle('usage:get', () => store.loadStore().modelUsage || {});

ipcMain.handle('dialog:pickFiles', async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: opts.imagesOnly
      ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
      : [{ name: '所有文件', extensions: ['*'] }],
  });
  return res.canceled ? [] : res.filePaths;
});

// --- project groups ---
ipcMain.handle('proj:list', () => projects.list());
ipcMain.handle('proj:rename', (_e, { id, name }) => projects.rename(id, name));
ipcMain.handle('proj:addDir', (_e, { id, dir }) => projects.addDir(id, dir));
ipcMain.handle('proj:addFiles', (_e, { id, paths, tag }) => projects.addFiles(id, paths, tag));
ipcMain.handle('proj:setTag', (_e, { id, path: fp, tag }) => projects.setTag(id, fp, tag));
ipcMain.handle('proj:removeFile', (_e, { id, path: fp }) => projects.removeFile(id, fp));
ipcMain.handle('proj:prune', () => projects.pruneMissing());
ipcMain.handle('proj:memory', (_e, id) => {
  const p = projects.get(id);
  return p ? { path: projects.memoryPath(p), content: projects.readMemory(p) } : null;
});

// --- API keys(多 key 管理,v0.7.0) ---
ipcMain.handle('apikey:get', () => {
  const k = keys.activeKey();
  return k ? { configured: true, hint: '…' + k.key.slice(-4), name: k.name } : { configured: false };
});
ipcMain.handle('apikey:set', (_e, key) => keys.save({ name: '默认 Key', key: (key || '').trim() }));
ipcMain.handle('keys:list', () => ({ list: keys.list(), activeId: store.getSetting('activeKeyId') }));
ipcMain.handle('keys:save', (_e, entry) => keys.save(entry));
ipcMain.handle('keys:delete', (_e, id) => keys.remove(id));
ipcMain.handle('keys:setActive', (_e, id) => keys.setActive(id));
ipcMain.handle('keys:refreshModels', (_e, id) => keys.refreshModels(id));
ipcMain.handle('keys:activeModels', () => keys.activeModels());

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// renderer error reporting (fire-and-forget; metadata only) + logs folder
ipcMain.on('renderer:error', (_e, info) => {
  if (!info || typeof info !== 'object') return;
  logger.logRendererError({
    source: info.source,
    message: info.message,
    stack: info.stack,
    url: info.url,
    line: info.line,
    col: info.col,
  });
});

ipcMain.handle('logs:open', () => shell.openPath(logger.logsDir()));

// permission rules (<cwd>/.claude/settings.local.json)
ipcMain.handle('perms:list', (_e, cwd) => perms.listRules(cwd));
ipcMain.handle('perms:remove', (_e, { cwd, kind, rule }) => perms.removeRule(cwd, kind, rule));

// auto-update
ipcMain.handle('update:check', () => { updater.checkNow(getWindow); return true; });
ipcMain.handle('update:install', () => { updater.installAndRestart(); return true; });

// ---------------------------------------------------------------------------
// IPC: sessions
// ---------------------------------------------------------------------------
ipcMain.handle('sess:sdkStatus', () => sessions.sdkAvailable());
ipcMain.handle('sess:list', () => sessions.list());
ipcMain.handle('sess:create', async (_e, opts) => {
  if (opts.standalone || opts.kind === 'chat') {
    // 独立会话 / chat 板块会话:不指定目录时用主目录,绝不自动建项目组
    opts = { ...opts, cwd: opts.cwd || os.homedir(), projectId: null };
  } else if (!opts.projectId && opts.cwd) {
    // resolve the project group: explicit id, or auto-create for a new path
    opts = { ...opts, projectId: projects.ensureForDir(opts.cwd).id };
  }
  // optional per-session worktree isolation
  if (opts.useWorktree) {
    const wt = await git.createWorktree(opts.cwd, 'wt-' + Date.now().toString(36));
    if (wt.ok) { opts = { ...opts, worktreePath: wt.dir, cwd: wt.dir, title: opts.title }; }
    else sessions.send('sess:event', { sid: null, ev: { type: 'ui_error', message: 'worktree 创建失败:' + wt.error } });
  }
  return sessions.create(opts);
});
ipcMain.handle('sess:send', (_e, { sid, content }) => {
  const s = sessions.get(sid);
  return s ? s.send(content) : false;
});
ipcMain.handle('sess:interrupt', async (_e, sid) => {
  const s = sessions.get(sid);
  if (s) await s.interrupt();
  return true;
});
ipcMain.handle('sess:permission', (_e, { sid, reqId, decision, denyMessage }) => {
  const s = sessions.get(sid);
  return s ? s.respondPermission(reqId, decision, denyMessage) : false;
});
ipcMain.handle('sess:setMode', (_e, { sid, mode }) => {
  const s = sessions.get(sid);
  return s ? s.setPermissionMode(mode) : false;
});
ipcMain.handle('sess:setModel', (_e, { sid, model }) => {
  const s = sessions.get(sid);
  return s ? s.setModel(model) : false;
});
ipcMain.handle('sess:setEffort', (_e, { sid, effort }) => {
  const s = sessions.get(sid);
  return s ? s.setEffort(effort) : false;
});
ipcMain.handle('sess:history', (_e, sid) => sessions.history(sid));
ipcMain.handle('sess:rename', (_e, { sid, title }) => { sessions.rename(sid, title); return true; });
ipcMain.handle('sess:archive', async (_e, { sid, archived }) => {
  // clean up the session worktree when archiving
  const meta = store.listSessions().find((x) => x.id === sid);
  sessions.archive(sid, archived !== false);
  if (archived !== false && meta && meta.worktreePath) {
    const repo = path.dirname(path.dirname(meta.worktreePath));
    await git.removeWorktree(repo, meta.worktreePath);
  }
  return true;
});
ipcMain.handle('sess:remove', (_e, sid) => { sessions.remove(sid); return true; });
ipcMain.handle('sess:setActive', (_e, sid) => { sessions.setActive(sid); return true; });

// ---------------------------------------------------------------------------
// IPC: git / diff / PR
// ---------------------------------------------------------------------------
ipcMain.handle('git:isRepo', (_e, cwd) => git.isRepo(cwd));
ipcMain.handle('git:branch', (_e, cwd) => git.branchInfo(cwd));
ipcMain.handle('git:diffStat', (_e, cwd) => git.diffStat(cwd));
ipcMain.handle('git:diffFile', (_e, { cwd, file, untracked }) => git.diffFile(cwd, file, untracked));
ipcMain.handle('git:prStatus', (_e, cwd) => git.prStatus(cwd));

// ---------------------------------------------------------------------------
// IPC: files
// ---------------------------------------------------------------------------
ipcMain.handle('files:list', (_e, cwd) => files.listFiles(cwd));
ipcMain.handle('files:read', (_e, { cwd, path: rel }) => files.readFile(cwd, rel));
ipcMain.handle('files:save', (_e, { cwd, path: rel, content, mtimeMs, force }) =>
  files.saveFile(cwd, rel, content, mtimeMs, force));
ipcMain.handle('files:watch', (_e, { key, path: abs }) => {
  files.watchFile(key, abs, () => sessions.send('file:changed', { key, path: abs }));
  return true;
});
ipcMain.handle('files:unwatch', (_e, key) => { files.unwatchFile(key); return true; });
ipcMain.handle('files:readImage', (_e, absPath) => files.readImageBase64(absPath));

// ---------------------------------------------------------------------------
// IPC: slash commands / mcp / cron
// ---------------------------------------------------------------------------
ipcMain.handle('cmds:list', (_e, cwd) => commands.listCommands(cwd));

ipcMain.handle('mcp:list', (_e, cwd) => mcp.listServers(cwd));
ipcMain.handle('mcp:save', (_e, { cwd, scope, name, config }) => mcp.saveServer(cwd, scope, name, config));
ipcMain.handle('mcp:delete', (_e, { cwd, scope, name }) => mcp.deleteServer(cwd, scope, name));

ipcMain.handle('cron:list', () => scheduler.listJobs());
ipcMain.handle('cron:save', (_e, job) => scheduler.saveJob(job));
ipcMain.handle('cron:delete', (_e, id) => { scheduler.deleteJob(id); return true; });

// ---------------------------------------------------------------------------
// IPC: terminals (multi-tab)
// ---------------------------------------------------------------------------
ipcMain.handle('term:open', (_e, opts) => terms.open(opts || {}));
ipcMain.on('term:input', (_e, { id, data }) => terms.write(id, data));
ipcMain.on('term:resize', (_e, { id, cols, rows }) => terms.resize(id, cols, rows));
ipcMain.handle('term:close', (_e, id) => { terms.close(id); return true; });
