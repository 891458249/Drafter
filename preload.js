const { contextBridge, ipcRenderer } = require('electron');

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

  // project groups
  projList: () => ipcRenderer.invoke('proj:list'),
  projRename: (id, name) => ipcRenderer.invoke('proj:rename', { id, name }),
  projAddDir: (id, dir) => ipcRenderer.invoke('proj:addDir', { id, dir }),
  projAddFiles: (id, paths, tag) => ipcRenderer.invoke('proj:addFiles', { id, paths, tag }),
  projSetTag: (id, path, tag) => ipcRenderer.invoke('proj:setTag', { id, path, tag }),
  projRemoveFile: (id, path) => ipcRenderer.invoke('proj:removeFile', { id, path }),
  projMemory: (id) => ipcRenderer.invoke('proj:memory', id),

  // api key
  apiKeyGet: () => ipcRenderer.invoke('apikey:get'),
  apiKeySet: (key) => ipcRenderer.invoke('apikey:set', key),

  // sessions
  sdkStatus: () => ipcRenderer.invoke('sess:sdkStatus'),
  sessList: () => ipcRenderer.invoke('sess:list'),
  sessCreate: invoke('sess:create'),
  sessSend: (sid, content) => ipcRenderer.invoke('sess:send', { sid, content }),
  sessInterrupt: (sid) => ipcRenderer.invoke('sess:interrupt', sid),
  sessPermission: invoke('sess:permission'),
  sessSetMode: (sid, mode) => ipcRenderer.invoke('sess:setMode', { sid, mode }),
  sessSetModel: (sid, model) => ipcRenderer.invoke('sess:setModel', { sid, model }),
  sessSetEffort: (sid, effort) => ipcRenderer.invoke('sess:setEffort', { sid, effort }),
  sessHistory: (sid) => ipcRenderer.invoke('sess:history', sid),
  sessRename: (sid, title) => ipcRenderer.invoke('sess:rename', { sid, title }),
  sessArchive: (sid, archived) => ipcRenderer.invoke('sess:archive', { sid, archived }),
  sessRemove: (sid) => ipcRenderer.invoke('sess:remove', sid),
  sessSetActive: (sid) => ipcRenderer.invoke('sess:setActive', sid),

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
      'sess:event', 'sess:attention', 'cron:fired',
      'term:data', 'term:exit',
      'file:changed',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
