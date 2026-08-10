const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

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
const aigc = require('./src/main/aigc');
const aux = require('./src/main/aux-models');
const title = require('./src/main/title');
const gems = require('./src/main/gems');
const { TermManager } = require('./src/main/terminal');
const { SessionManager } = require('./src/main/sessions');
const migrations = require('./src/main/migrations');

// 新媒体板块(kind):image/video/audio/model 会话不走 Agent SDK,走 AIGC 任务闭环
const MEDIA_KINDS = ['image', 'video', 'audio', 'model'];
const isMediaKind = (kind) => MEDIA_KINDS.includes(kind);
const AIGC_DIR = () => path.join(app.getPath('userData'), 'aigc');

// aigc:// 自定义协议:把 <userData>/aigc/ 下的产物文件映射给渲染端 <img>/<video>/<audio>
protocol.registerSchemesAsPrivileged([
  { scheme: 'aigc', privileges: { secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow = null;
let tray = null;
let trayHintShown = false; // 首次最小化到托盘时提示一次
const getWindow = () => mainWindow;

// 退出前清理(幂等):停会话/终端/调度
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { sessions.stopAll(); } catch {}
  try { terms.closeAll(); } catch {}
  try { scheduler.stop(); } catch {}
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  mainWindow.show();
  mainWindow.focus();
}

// 系统托盘(v0.9.13):关窗后驻留后台,右键托盘图标退出
function setupTray() {
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
    if (img.isEmpty()) { console.error('[tray] icon.png 加载失败'); return; }
    img = img.resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('DeskTopUI');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 DeskTopUI', click: showMainWindow },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; cleanup(); app.quit(); } },
    ]));
    tray.on('click', showMainWindow); // 左键单击直接唤出
  } catch (e) {
    console.error('[tray] 创建失败:', e.message);
  }
}

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
    // 应用可能在托盘隐藏中:二次启动要 show 出来而不只是 focus
    showMainWindow();
  });
}

app.on('gpu-process-crashed', (_e, killed) => {
  console.error('[main] gpu-process-crashed, killed =', killed);
  logger.logRendererError({ source: 'gpu-process', message: 'GPU 进程崩溃,killed=' + killed });
});

if (store.getSetting('disableGpu')) {
  app.disableHardwareAcceleration();
}

// Env for child processes: inject the API key for the given session keyId
// (falling back to the ACTIVE/default key). Explicitly neutralize the other
// credential/env vars so per-key switching wins over ~/.claude/settings.json
// env and inherited process env.
function buildEnv(extra = {}, keyId = null) {
  const env = { ...process.env, FORCE_COLOR: '0', ...extra };
  const k = (keyId && keys.byId(keyId)) || keys.activeKey();
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
    title: 'DeskTopUI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // preview panel
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  // 关窗转入托盘后台(v0.9.13):仅托盘右键「退出」/自动更新重启才真正退出
  mainWindow.on('close', (e) => {
    if (app.isQuitting || process.platform === 'darwin') return;
    e.preventDefault();
    mainWindow.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      try {
        new Notification({ title: 'DeskTopUI 正在后台运行', body: '窗口已最小化到系统托盘;右键托盘图标可退出。' }).show();
      } catch {}
    }
  });
  // persist renderer errors (level >= 2) to userData/logs/renderer-errors.log
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      logger.logRendererError({ source: 'console', message, url: sourceId, line });
    }
  });
}

app.whenReady().then(() => {
  // 数据迁移与自愈(v0.9.17):版本升级后对全部存量会话统一迭代修复
  // (transcript 迁移/降级、meta 去重等),报告写 userData/logs/migrations.log
  try {
    const report = migrations.run(app.getVersion());
    const fixes = Object.keys(report).filter((k) => !['ts', 'from', 'to', 'migrations'].includes(k));
    if (fixes.length || report.migrations.length) console.log('[migrations] report:', JSON.stringify(report));
  } catch (e) {
    console.error('[migrations] run failed:', e.message);
  }
  // aigc://<trace_id>/<filename> → <userData>/aigc/<trace_id>/<filename>(防路径穿越)
  protocol.handle('aigc', (req) => {
    try {
      const u = new URL(req.url);
      const traceId = u.hostname;
      const name = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (!/^[\w-]+$/.test(traceId) || !name || name.includes('..') || /[\\/]/.test(name)) {
        return new Response('bad request', { status: 400 });
      }
      return net.fetch(pathToFileURL(path.join(AIGC_DIR(), traceId, name)).toString());
    } catch {
      return new Response('bad request', { status: 400 });
    }
  });
  // auto-update: check GitHub Releases in the background (silent on failure)
  updater.start(getWindow, store);
  // migration: attach legacy sessions (created before project groups) to projects
  // (standalone/non-code-kind sessions are intentionally project-less — never migrate them)
  try {
    for (const meta of store.listSessions()) {
      if (meta.projectId || !meta.cwd || meta.standalone || (meta.kind && meta.kind !== 'code')) continue;
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
  setupTray();
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

app.on('before-quit', () => {
  app.isQuitting = true; // 覆盖 Cmd+Q / app.quit() 等所有退出路径
  cleanup();
});

app.on('window-all-closed', () => {
  // Windows 上关窗被拦截转入托盘,不会走到这里;能到这里说明正在退出(或 macOS 关窗)
  cleanup();
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
// 独立会话「设为项目文件夹」(v0.9.1):目录建/复用项目组(名=文件夹名),会话脱离独立区归入该项目
// 同时把会话 cwd 切换为项目目录(v0.9.7 修复):此前只改 projectId,主工作目录滞留主目录,
// 无关路径(含主目录 local settings 的 additionalDirectories)会泄漏进所有被认领的会话
ipcMain.handle('proj:adoptDir', async (_e, { sid, dir }) => {
  const p = projects.ensureForDir(dir);
  const norm = (x) => path.resolve(x).toLowerCase();
  const patch = { id: sid, projectId: p.id, standalone: false, cwd: dir };
  const s = sessions.get(sid);
  // extraDirs 里与新 cwd 相同的登记是冗余(重启后 cwd 即目录本身),一并清掉
  if (s && Array.isArray(s.meta.extraDirs)) {
    const extra = s.meta.extraDirs.filter((d) => norm(d) !== norm(dir));
    if (extra.length !== s.meta.extraDirs.length) patch.extraDirs = extra;
  }
  if (s) {
    const cwdChanged = norm(s.meta.cwd || '') !== norm(dir);
    // cwd 切换前登记旧目录(v0.9.10):sessions.start() 据此把会话记录迁移到新
    // cwd 的 projects 目录再 resume,否则报 "No conversation found" 会话作废
    if (cwdChanged) patch.prevCwd = s.meta.cwd;
    Object.assign(s.meta, patch);
    store.upsertSession(patch);
    if (cwdChanged && s.running) {
      if (s.busy) s.needRestart = true;   // 回合进行中不打断,回合结束后自动重启
      else { s.stop(); await s.start({ resume: !!s.meta.sdkSessionId }); }
    }
  } else {
    store.upsertSession(patch);
  }
  return p;
});
// 侧栏项目右键「打开文件夹」(v0.9.1):打开项目主目录
ipcMain.handle('proj:openFolder', (_e, id) => {
  const p = projects.get(id);
  const dir = p && p.dirs && p.dirs[0];
  if (!dir || !fs.existsSync(dir)) return false;
  shell.openPath(dir);
  return true;
});
ipcMain.handle('proj:memory', (_e, id) => {
  const p = projects.get(id);
  return p ? { path: projects.memoryPath(p), content: projects.readMemory(p) } : null;
});

// --- API keys(多 key 管理,v0.7.0) ---
ipcMain.handle('apikey:get', () => {
  const k = keys.activeKey();
  return k ? { configured: true, hint: '…' + k.key.slice(-4), name: k.name } : { configured: false };
});
ipcMain.handle('apikey:set', (_e, key) => keys.save({ name: 'Kuro', key: (key || '').trim() }));
ipcMain.handle('keys:list', () => ({ list: keys.list(), activeId: store.getSetting('activeKeyId') }));
ipcMain.handle('keys:save', (_e, entry) => keys.save(entry));
ipcMain.handle('keys:delete', (_e, id) => keys.remove(id));
ipcMain.handle('keys:setActive', (_e, id) => keys.setActive(id));
ipcMain.handle('keys:refreshModels', (_e, id) => keys.refreshModels(id));
ipcMain.handle('keys:activeModels', () => keys.activeModels());
ipcMain.handle('keys:setModelsEnabled', (_e, { id, enabled }) => keys.setModelsEnabled(id, enabled));
ipcMain.handle('keys:queryBalance', (_e, id) => keys.queryBalance(id)); // v0.8.1 自动余额查询
ipcMain.handle('keys:setEnabled', (_e, { id, enabled }) => keys.setEnabled(id, enabled)); // v0.8.2 多选激活
ipcMain.handle('keys:enabledModels', () => keys.enabledModels()); // v0.8.2 启用 Key 的模型聚合

// 辅助模型配置(v0.9.1):settings.auxModels = { image, audio, video, model },值 'keyId|modelId' 或空
ipcMain.handle('settings:getAuxModels', () => store.getSetting('auxModels', {}) || {});
ipcMain.handle('settings:setAuxModels', (_e, m) => {
  const clean = {};
  for (const k of ['image', 'audio', 'video', 'model']) {
    if (m && typeof m[k] === 'string' && m[k]) clean[k] = m[k];
  }
  store.setSetting('auxModels', clean);
  return { ok: true };
});

// Gem 自定义助手(v0.9.11):settings.gems 数组;预置项不可改删(gems.js 内校验)
gems.seedPresets();
ipcMain.handle('gems:list', () => gems.list());
ipcMain.handle('gems:save', (_e, gem) => gems.save(gem));
ipcMain.handle('gems:delete', (_e, id) => gems.remove(id));
// 「✨ AI 优化指令」(对齐 Gemini「使用 Gemini 重新撰写指令」):一句话描述 →
// 按官方四要素(角色/任务/情境/形式)扩写;复用会话 Key+模型走 chat completions,失败返回 null
ipcMain.handle('gems:rewrite', async (_e, { hint, instructions, keyId, model }) => {
  const keyEntry = keys.byId(keyId) || keys.activeKey();
  const mdl = model
    || (((keys.enabledModels() || []).find((e) => keyEntry && e.keyId === keyEntry.id) || {}).model);
  if (!keyEntry || !keyEntry.key || !mdl) return { ok: false, error: '无可用 chat 模型' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${aux.apiRoot(keyEntry.baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...aux.authHeaders(keyEntry) },
      body: JSON.stringify({
        model: mdl,
        messages: [{
          role: 'user',
          content: '为一个自定义 AI 助手撰写指令。按「角色 / 任务 / 情境 / 形式」四个要素组织,'
            + '每个要素以「角色:」「任务:」「情境:」「形式:」开头各占一段,每段一到两句话。'
            + '只输出指令本身,不要解释。\n\n助手的目标描述:' + String(hint || '').slice(0, 500)
            + (instructions ? '\n\n现有指令(在其基础上改写完善):\n' + String(instructions).slice(0, 4000) : ''),
        }],
        max_tokens: 800,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: '模型请求失败:' + res.status };
    const json = await res.json();
    const text = json && json.choices && json.choices[0] && json.choices[0].message
      && String(json.choices[0].message.content || '').trim();
    return text ? { ok: true, instructions: text } : { ok: false, error: '模型未返回内容' };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
});

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
  if (isMediaKind(opts.kind)) {
    // 新媒体板块会话(image/video/audio/model):不进 Agent SDK,只落 store 元数据;
    // 消息走 AIGC 任务闭环(aigc:send),历史沿用每会话 JSONL(sess:history 可读)
    const id = 's_' + crypto.randomUUID().slice(0, 12);
    return store.upsertSession({
      id,
      kind: opts.kind,
      model: opts.model || null,
      keyId: opts.keyId || (keys.activeKey() || {}).id || null,
      cwd: os.homedir(),
      projectId: null,
      standalone: true,
      archived: false,
      title: opts.title || null,
      parentId: opts.parentId || null,
      sdkSessionId: null,
      gemId: opts.gemId || null, // 绑定的 Gem(v0.9.11),aigc:send 时注入 prompt 前缀
    });
  }
  if (opts.standalone || (opts.kind && opts.kind !== 'code')) {
    // 独立会话 / 非 code 板块会话(chat/新媒体):不指定目录时用主目录,绝不自动建项目组
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
  // 记录创建时活跃的 key,用于按 key 归账额度(v0.8.0)
  if (!opts.keyId) opts = { ...opts, keyId: (keys.activeKey() || {}).id || null };
  return sessions.create(opts);
});
// 会话自动命名(v0.9.1):首条消息发送后异步概括标题;autoTitle 占位防重入,
// 写回前若用户已手动命名则不覆盖(title.js 内再查一次)
function maybeAutoTitle(sid, text) {
  const meta = store.listSessions().find((x) => x.id === sid);
  if (!meta || (meta.title && meta.title.trim()) || meta.autoTitle) return;
  store.upsertSession({ id: sid, autoTitle: true });
  const keyEntry = keys.byId(meta.keyId) || keys.activeKey();
  const model = meta.model
    || (((keys.enabledModels() || []).find((e) => keyEntry && e.keyId === keyEntry.id) || {}).model);
  title.autoTitle(text, {
    keyEntry, model,
    getCurrentTitle: () => (store.listSessions().find((x) => x.id === sid) || {}).title,
    applyTitle: (t) => {
      sessions.rename(sid, t);
      sessions.send('sess:event', { sid, ev: { type: 'ui_title', title: t } });
    },
  }).catch(() => {});
}

// 从消息内容里提取首段文本(字符串或 content blocks)
function firstText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  }
  return '';
}

ipcMain.handle('sess:send', async (_e, { sid, content }) => {
  const s = sessions.get(sid);
  if (!s) return false;
  // /add-dir(v0.9.2):SDK 流式输入不会执行该命令,客户端拦截——登记 extraDirs 并重启 query 生效
  const addDirMatch = typeof content === 'string' && content.match(/^\/add-dir\s+(\S(?:.*\S)?)\s*$/);
  if (addDirMatch) {
    const dir = addDirMatch[1].replace(/^["']|["']$/g, '');
    if (!fs.existsSync(dir)) {
      sessions.send('sess:event', { sid, ev: { type: 'ui_aux', message: '目录不存在,未添加:' + dir } });
      return false;
    }
    s._persistUserEcho(content); // 历史回放保留命令回显
    await s.addDir(dir);
    if (s.meta.projectId) projects.addDir(s.meta.projectId, dir); // 项目会话同步登记(幂等)
    const note = s.needRestart ? '已登记目录(当前回合结束后生效):' : '已添加目录:';
    sessions.send('sess:event', { sid, ev: { type: 'ui_aux', message: note + dir } });
    return true;
  }
  let sent;
  // Code/Chat 辅助模型(v0.9.1):媒体附件块先经辅助模型分析/元信息兜底,再发给主模型
  if (Array.isArray(content)) {
    const injected = await aux.injectMedia(content, {
      auxModels: store.getSetting('auxModels', {}) || {},
      keysById: (id) => keys.byId(id),
      onStatus: (msg) => sessions.send('sess:event', { sid, ev: { type: 'ui_aux', message: msg } }),
    });
    sent = await s.send(injected, content); // 历史回显保留原始附件卡片,SDK 收注入后的内容
  } else {
    sent = await s.send(content);
  }
  if (sent) maybeAutoTitle(sid, firstText(content));
  return sent;
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
ipcMain.handle('sess:setModel', (_e, { sid, model, keyId }) => {
  const s = sessions.get(sid);
  if (!s) return false;
  // 防御(v0.9.5):新媒体类模型不能绑到 code/chat(SDK)会话——否则走 /v1/messages 必 403「模型未配置」
  const isMedia = !!(s.meta.kind && s.meta.kind !== 'code' && s.meta.kind !== 'chat');
  if (!isMedia && model && keyId && keys.modelType(keyId, model) !== 'chat') return false;
  return s.setModel(model, keyId);
});
ipcMain.handle('sess:setEffort', (_e, { sid, effort }) => {
  const s = sessions.get(sid);
  return s ? s.setEffort(effort) : false;
});
// 绑定/切换/清除 Gem(v0.9.11):重启 query 注入 gem 指令(回合中则回合结束后生效)
ipcMain.handle('sess:setGem', async (_e, { sid, gemId }) => {
  const s = sessions.get(sid);
  if (!s) return false;
  await s.setGem(gemId || null);
  return true;
});
ipcMain.handle('sess:history', (_e, sid) => sessions.history(sid));
// 修改并重新生成(v0.9.9):截断 UI 日志,fork SDK 上下文后发送编辑后的消息
ipcMain.handle('sess:editRegenerate', async (_e, { sid, echoUuid, content, echoContent }) => {
  const s = sessions.get(sid);
  return s ? s.editRegenerate(echoUuid, content, echoContent) : { ok: false, error: '会话不存在' };
});
// 从此消息分支(v0.9.9):复制该消息回合结束前的历史为新会话,SDK 上下文 fork 到该回合末尾
ipcMain.handle('sess:branch', (_e, { sid, echoUuid }) => sessions.branch(sid, echoUuid));
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
// IPC: AIGC 生成任务闭环(新媒体板块,v0.9.0)
// ---------------------------------------------------------------------------
const aigcTasks = new Map(); // traceId -> { cancel }

// 推送任务状态:持久化进会话 JSONL(历史回显用) + 实时事件给渲染端
function aigcPush(sessionId, traceId, model, prompt, payload) {
  const ev = { type: 'aigc_task', traceId, model, prompt, ts: Date.now(), ...payload };
  store.appendSessionEvent(sessionId, ev);
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('aigc:status', { sessionId, traceId, model, prompt, ...payload });
  }
}

// 后台跑完整个任务:轮询 → done 后下载产物 → 推送终态
function aigcRun(sessionId, keyEntry, traceId, model, prompt) {
  const handle = aigc.pollTask(keyEntry, traceId, (st) => {
    if (st.status === 'done') return; // done 等下载完成后连同 files 一起推
    aigcPush(sessionId, traceId, model, prompt, {
      status: st.status,
      failReason: st.fail_reason || st.last_retry_reason || null,
    });
  });
  aigcTasks.set(traceId, handle);
  handle.promise.then(async (final) => {
    aigcTasks.delete(traceId);
    if (!final || final.status !== 'done') return; // 取消 / fail / timeout 已在回调里推过
    try {
      aigcPush(sessionId, traceId, model, prompt, { status: 'downloading' });
      const files = await aigc.downloadResults(keyEntry, traceId, path.join(AIGC_DIR(), traceId));
      aigcPush(sessionId, traceId, model, prompt, { status: 'done', files });
    } catch (e) {
      aigcPush(sessionId, traceId, model, prompt, { status: 'fail', failReason: '产物下载失败:' + e.message });
    }
  }).catch((e) => {
    aigcTasks.delete(traceId);
    aigcPush(sessionId, traceId, model, prompt, { status: 'fail', failReason: e.message });
  });
}

ipcMain.handle('aigc:send', async (_e, { sessionId, keyId, model, prompt, refImages }) => {
  const meta = store.listSessions().find((x) => x.id === sessionId);
  if (!meta || !isMediaKind(meta.kind)) return { ok: false, error: '会话不存在或非新媒体会话' };
  const keyEntry = keys.byId(keyId || meta.keyId);
  if (!keyEntry) return { ok: false, error: '未找到可用的 API Key' };
  const useModel = model || meta.model;
  if (!useModel) return { ok: false, error: '未选择模型' };
  // Gem 前缀(v0.9.11):媒体会话绑定的 Gem 指令拼在用户 prompt 前;回显/标题仍用原始 prompt
  const gem = meta.gemId ? gems.byId(meta.gemId) : null;
  const fullPrompt = (gem ? gems.composeMediaPrefix(gem) : '') + prompt;
  try {
    const { traceId } = await aigc.createTask(keyEntry, meta.kind, {
      modelKey: useModel, prompt: fullPrompt, refImages: refImages || [],
    });
    // 用户消息与任务占位消息持久化(参考图保留 base64,历史回放可显示缩略图)
    store.appendSessionEvent(sessionId, { type: 'aigc_user', prompt, refImages: refImages || [], ts: Date.now() });
    store.appendSessionEvent(sessionId, { type: 'aigc_task', traceId, model: useModel, status: 'pending', ts: Date.now() });
    // 新媒体会话自动命名(v0.9.1):媒体模型不是 chat 模型,直接截取 prompt 前 20 字
    const m2 = store.listSessions().find((x) => x.id === sessionId);
    if (m2 && !(m2.title && m2.title.trim()) && !m2.autoTitle) {
      const t = title.fallbackTitle(prompt);
      store.upsertSession({ id: sessionId, autoTitle: true, title: t });
      sessions.send('sess:event', { sid: sessionId, ev: { type: 'ui_title', title: t } });
    }
    aigcRun(sessionId, keyEntry, traceId, useModel, prompt);
    return { ok: true, traceId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('aigc:cancel', (_e, { traceId }) => {
  const h = aigcTasks.get(traceId);
  if (h) h.cancel();
  return true;
});

// 3D 产物卡片「打开所在文件夹」(限制在 aigc 产物目录内)
ipcMain.handle('shell:showItemInFolder', (_e, p) => {
  if (typeof p !== 'string') return false;
  const abs = path.resolve(p);
  if (!abs.startsWith(path.resolve(AIGC_DIR()) + path.sep)) return false;
  shell.showItemInFolder(abs);
  return true;
});

// 生成文件「点击打开」(v0.9.6):系统默认程序打开,同样限制在 aigc 产物目录内
ipcMain.handle('shell:openPath', (_e, p) => {
  if (typeof p !== 'string') return false;
  const abs = path.resolve(p);
  if (!abs.startsWith(path.resolve(AIGC_DIR()) + path.sep)) return false;
  shell.openPath(abs);
  return true;
});

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
ipcMain.handle('files:stat', (_e, absPath) => files.statFile(absPath)); // 媒体附件卡片显示大小用
ipcMain.handle('files:sample', (_e, absPath) => files.sampleFile(absPath)); // 文本附件二进制检测采样(v0.9.27)
// 粘贴的文本附件无磁盘路径:落盘 userData/attachments/ 后按路径引用(v0.9.27)
ipcMain.handle('files:savePasted', (_e, { name, content }) =>
  files.savePastedAttachment(app.getPath('userData'), name, content));

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
