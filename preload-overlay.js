// 桌面悬浮球(v0.13.3)专用最小 preload:只暴露悬浮窗需要的 API,
// 不复用主 preload(主 preload 暴露几十个 invoke,悬浮球是常驻渲染进程,最小化攻击面)。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  sessList: () => ipcRenderer.invoke('sess:list'),
  on: (channel, cb) => {
    const allowed = ['sess:event', 'sess:attention', 'overlay:pending'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  overlayGetState: () => ipcRenderer.invoke('overlay:getState'),
  overlayDragStart: (p) => ipcRenderer.invoke('overlay:dragStart', p),
  overlayDragEnd: () => ipcRenderer.invoke('overlay:dragEnd'),
  overlaySetPos: (p) => ipcRenderer.invoke('overlay:setPos', p),
  overlaySetRegions: (p) => ipcRenderer.invoke('overlay:setRegions', p),
  overlaySetDock: (p) => ipcRenderer.invoke('overlay:setDock', p),
  overlayJump: (p) => ipcRenderer.invoke('overlay:jump', p),
  overlayMenu: (p) => ipcRenderer.invoke('overlay:menu', p),
  overlayShowMain: () => ipcRenderer.invoke('overlay:showMain'),
});
