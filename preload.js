const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (payload) => ipcRenderer.invoke(ch, payload);

contextBridge.exposeInMainWorld('api', {
  // store / dialog
  getStore: () => ipcRenderer.invoke('store:get'),
  setSetting: (key, value) => ipcRenderer.invoke('store:setSetting', { key, value }),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  pickFiles: (opts) => ipcRenderer.invoke('dialog:pickFiles', opts),
  addRecent: (dir) => ipcRenderer.invoke('store:addRecent', dir),
  usageGet: () => ipcRenderer.invoke('usage:get'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // error reporting / logs (send = fire-and-forget, never blocks the renderer)
  reportError: (info) => ipcRenderer.send('renderer:error', info),
  openLogs: () => ipcRenderer.invoke('logs:open'),

  // permission rules
  permsList: (cwd) => ipcRenderer.invoke('perms:list', cwd),
  permsRemove: (cwd, kind, rule) => ipcRenderer.invoke('perms:remove', { cwd, kind, rule }),

  // auto-update
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateRepoVersion: () => ipcRenderer.invoke('update:repoVersion'),

  // harness 板块(v0.11.0):启动 harness 引擎并返回 index.electron.html 路径
  harnessBoot: () => ipcRenderer.invoke('harness:boot'),
  harnessPreloadPath: () => ipcRenderer.invoke('harness:preloadPath'),

  // project groups
  projList: () => ipcRenderer.invoke('proj:list'),
  projRename: (id, name) => ipcRenderer.invoke('proj:rename', { id, name }),
  projAddDir: (id, dir) => ipcRenderer.invoke('proj:addDir', { id, dir }),
  projAddFiles: (id, paths, tag) => ipcRenderer.invoke('proj:addFiles', { id, paths, tag }),
  projSetTag: (id, path, tag) => ipcRenderer.invoke('proj:setTag', { id, path, tag }),
  projRemoveFile: (id, path) => ipcRenderer.invoke('proj:removeFile', { id, path }),
  projPrune: () => ipcRenderer.invoke('proj:prune'),
  projAdoptDir: (sid, dir) => ipcRenderer.invoke('proj:adoptDir', { sid, dir }),
  projOpenFolder: (id) => ipcRenderer.invoke('proj:openFolder', id),
  projMemory: (id) => ipcRenderer.invoke('proj:memory', id),

  // api key(单 key 兼容入口;多 key 管理用 keys:*)
  apiKeyGet: () => ipcRenderer.invoke('apikey:get'),
  apiKeySet: (key) => ipcRenderer.invoke('apikey:set', key),

  // multi api keys
  keysList: () => ipcRenderer.invoke('keys:list'),
  keysSave: (entry) => ipcRenderer.invoke('keys:save', entry),
  keysDelete: (id) => ipcRenderer.invoke('keys:delete', id),
  keysSetActive: (id) => ipcRenderer.invoke('keys:setActive', id),
  keysRefreshModels: (id) => ipcRenderer.invoke('keys:refreshModels', id),
  keysActiveModels: () => ipcRenderer.invoke('keys:activeModels'),
  keysSetModelsEnabled: (id, enabled) => ipcRenderer.invoke('keys:setModelsEnabled', { id, enabled }),
  keysQueryBalance: (id) => ipcRenderer.invoke('keys:queryBalance', id),
  keysSetEnabled: (id, enabled) => ipcRenderer.invoke('keys:setEnabled', { id, enabled }),
  keysEnabledModels: () => ipcRenderer.invoke('keys:enabledModels'),

  // ComfyUI 连接(凭据始终留在主进程;列表为脱敏数据)
  comfyListConnections: () => ipcRenderer.invoke('comfy:listConnections'),
  comfyLocalCatalog: () => ipcRenderer.invoke('comfy:localCatalog'),
  comfySaveConnection: (entry) => ipcRenderer.invoke('comfy:saveConnection', entry),
  comfyDeleteConnection: (id) => ipcRenderer.invoke('comfy:deleteConnection', id),
  comfyTestConnection: (id) => ipcRenderer.invoke('comfy:testConnection', id),
  comfyCatalog: (id, opts) => ipcRenderer.invoke('comfy:catalog', id, opts),
  comfyComboOptions: (id, route) => ipcRenderer.invoke('comfy:comboOptions', { id, route }),
  comfyImportGraph: (graph, schema) => ipcRenderer.invoke('comfy:importGraph', graph, schema),
  comfyExportPrompt: (graph) => ipcRenderer.invoke('comfy:exportPrompt', graph),
  comfyExportWorkflow: (payload) => ipcRenderer.invoke('comfy:exportWorkflow', payload),
  comfySubmit: (payload) => ipcRenderer.invoke('comfy:submit', payload),
  comfyJobs: (canvasId) => ipcRenderer.invoke('comfy:jobs', { canvasId }),
  comfyCancel: (jobId) => ipcRenderer.invoke('comfy:cancel', jobId),
  comfyImportFile: (connectionId) => ipcRenderer.invoke('comfy:importFile', { connectionId }),
  comfyTemplates: () => ipcRenderer.invoke('comfy:templates'),
  comfyLoadTemplate: (name) => ipcRenderer.invoke('comfy:loadTemplate', { name }),

  // 辅助模型配置(Code/Chat 分析媒体附件,v0.9.1)
  auxModelsGet: () => ipcRenderer.invoke('settings:getAuxModels'),
  auxModelsSet: (m) => ipcRenderer.invoke('settings:setAuxModels', m),

  // Gem 自定义助手(v0.9.11)
  gemsList: () => ipcRenderer.invoke('gems:list'),
  gemsSave: (gem) => ipcRenderer.invoke('gems:save', gem),
  gemsDelete: (id) => ipcRenderer.invoke('gems:delete', id),
  gemsRewrite: (payload) => ipcRenderer.invoke('gems:rewrite', payload),

  // sessions
  sdkStatus: () => ipcRenderer.invoke('sess:sdkStatus'),
  sessList: () => ipcRenderer.invoke('sess:list'),
  sessCreate: invoke('sess:create'),
  sessSend: (sid, content) => ipcRenderer.invoke('sess:send', { sid, content }),
  sessInterrupt: (sid) => ipcRenderer.invoke('sess:interrupt', sid),
  sessPermission: invoke('sess:permission'),
  sessSetMode: (sid, mode) => ipcRenderer.invoke('sess:setMode', { sid, mode }),
  sessSetModel: (sid, model, keyId) => ipcRenderer.invoke('sess:setModel', { sid, model, keyId }),
  sessSetEffort: (sid, effort) => ipcRenderer.invoke('sess:setEffort', { sid, effort }),
  sessHistory: (sid) => ipcRenderer.invoke('sess:history', sid),
  sessEditRegenerate: invoke('sess:editRegenerate'),
  sessBranch: invoke('sess:branch'),
  sessRename: (sid, title) => ipcRenderer.invoke('sess:rename', { sid, title }),
  sessArchive: (sid, archived) => ipcRenderer.invoke('sess:archive', { sid, archived }),
  sessRemove: (sid) => ipcRenderer.invoke('sess:remove', sid),
  sessSetActive: (sid) => ipcRenderer.invoke('sess:setActive', sid),
  sessSetGem: (sid, gemId) => ipcRenderer.invoke('sess:setGem', { sid, gemId }),
  // 极速问答 ⇄ Agent 模式切换(v0.10.2,仅 chat 会话)
  sessSetChatMode: (sid, mode) => ipcRenderer.invoke('sess:setChatMode', { sid, mode }),

  // AIGC 生成任务(新媒体板块)
  aigcSend: invoke('aigc:send'),
  aigcCancel: (sessionId, traceId) => ipcRenderer.invoke('aigc:cancel', { sessionId, traceId }),
  aigcExec: invoke('aigc:exec'), // 画布节点非会话执行(v0.10.0)
  shellShowItemInFolder: (p) => ipcRenderer.invoke('shell:showItemInFolder', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),

  // 无限画布 + 素材库(v0.10.0)
  canvasList: () => ipcRenderer.invoke('canvas:list'),
  canvasCreate: (name) => ipcRenderer.invoke('canvas:create', { name }),
  canvasLoad: (id) => ipcRenderer.invoke('canvas:load', { id }),
  canvasSave: (id, payload) => ipcRenderer.invoke('canvas:save', { id, ...payload }),
  canvasDelete: (id) => ipcRenderer.invoke('canvas:delete', { id }),
  canvasToDrawflow: (graph) => ipcRenderer.invoke('canvas:toDrawflow', { graph }),
  canvasValidate: (graph) => ipcRenderer.invoke('canvas:validate', { graph }),
  canvasSaveUpload: (id, name, data) => ipcRenderer.invoke('canvas:saveUpload', { id, name, data }),
  canvasListTemplates: () => ipcRenderer.invoke('canvas:templates:list'),
  canvasSaveTemplate: (name, graph) => ipcRenderer.invoke('canvas:templates:save', { name, graph }),
  canvasLoadTemplate: (id) => ipcRenderer.invoke('canvas:templates:load', { id }),
  canvasRemoveTemplate: (id) => ipcRenderer.invoke('canvas:templates:remove', { id }),
  canvasExportFile: (id) => ipcRenderer.invoke('canvas:exportFile', { id }),
  canvasImportFile: () => ipcRenderer.invoke('canvas:importFile'),
  canvasRun: (canvasId) => ipcRenderer.invoke('canvas:run', { canvasId }), // 整图运行(v0.12.0)
  canvasJobList: (canvasId) => ipcRenderer.invoke('canvas:job:list', { canvasId }),
  canvasJobCancel: (jobId) => ipcRenderer.invoke('canvas:job:cancel', { jobId }),
  llmComplete: (p) => ipcRenderer.invoke('llm:complete', p), // 画布文本生成节点(v0.10.1)
  assetsList: () => ipcRenderer.invoke('assets:list'),

  // git / diff / PR
  gitIsRepo: (cwd) => ipcRenderer.invoke('git:isRepo', cwd),
  gitBranch: (cwd) => ipcRenderer.invoke('git:branch', cwd),
  gitDiffStat: (cwd) => ipcRenderer.invoke('git:diffStat', cwd),
  gitDiffFile: invoke('git:diffFile'),
  gitPrStatus: (cwd) => ipcRenderer.invoke('git:prStatus', cwd),

  // files
  filesList: (cwd) => ipcRenderer.invoke('files:list', cwd),
  fileRead: invoke('files:read'),
  fileSave: invoke('files:save'),
  fileWatch: invoke('files:watch'),
  fileUnwatch: (key) => ipcRenderer.invoke('files:unwatch', key),
  fileReadImage: (absPath) => ipcRenderer.invoke('files:readImage', absPath),
  fileStat: (absPath) => ipcRenderer.invoke('files:stat', absPath),
  fileSample: (absPath) => ipcRenderer.invoke('files:sample', absPath),
  fileSavePasted: invoke('files:savePasted'),
  // 拖拽/粘贴的 File 对象取本地路径(Electron 32+ 移除了 File.path,需走 webUtils)
  pathForFile: (f) => webUtils.getPathForFile(f),

  // slash commands / mcp / cron
  cmdsList: (cwd) => ipcRenderer.invoke('cmds:list', cwd),
  mcpList: (cwd) => ipcRenderer.invoke('mcp:list', cwd),
  mcpSave: invoke('mcp:save'),
  mcpDelete: invoke('mcp:delete'),
  cronList: () => ipcRenderer.invoke('cron:list'),
  cronSave: invoke('cron:save'),
  cronDelete: (id) => ipcRenderer.invoke('cron:delete', id),

  // terminals
  termOpen: invoke('term:open'),
  termInput: (id, data) => ipcRenderer.send('term:input', { id, data }),
  termResize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
  termClose: (id) => ipcRenderer.invoke('term:close', id),

  // events
  on: (channel, cb) => {
    const allowed = [
      'sess:event', 'sess:attention', 'sess:activate', 'cron:fired',
      'term:data', 'term:exit',
      'file:changed', 'update:status', 'aigc:status', 'aigc:exec-status', 'canvas:job-status',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
