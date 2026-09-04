// 桌面悬浮球(v0.13.3):独立透明悬浮窗,显示进行中任务进度/完成绿球,可拖拽并
// 果冻吸附屏幕边缘。主进程侧管理器:懒创建窗口、显隐状态机(仅主窗隐藏时显示)、
// 拖拽光标轮询、pendingDone(完成待查看)集合、首次询问与设置持久化。
// 聚合/吸附/弹簧纯逻辑在 overlayMath.js(单测覆盖);本模块只做 Electron 相关的事。
'use strict';

const { BrowserWindow, screen, dialog, ipcMain, Menu, app } = require('electron');
const path = require('path');
const store = require('./store');
const math = require('./overlayMath');

// 悬浮窗固定尺寸:主球 64px 置顶中,任务小球 40px 竖排其下(最多 6 个,超出折叠 +N)。
// 固定尺寸 + 鼠标穿透:transparent 窗口 resize 在 Windows 上会闪烁,不做动态尺寸。
const WIN_W = 96;
const WIN_H = 340;
const EDGE_MARGIN = 8; // 吸附后距 workArea 边缘的留白

let win = null;
let dragTimer = null;
let dragOffset = null;
let hoverTimer = null;       // 光标轮询:悬停在球体区域时切可交互
let dragActive = false;      // 拖拽中:强制保持可交互(pointer capture 前提)
let regions = [{ x: 16, y: 4, w: 64, h: 64 }]; // 可交互区域(窗口相对坐标,渲染端上报)
let asking = false;
let runtimeEnabled = null;   // 用户未勾「记住」时,仅本次进程生效
let interactive = false;     // 悬停交互态:true=窗口收鼠标事件(仅悬停在球体上时)
let deps = {};               // { sessions, getMainWindow, showMainWindow }
// 完成待查看集合归主进程所有:悬浮窗可能懒创建/重建,绿球语义不能随窗丢
const pendingDone = new Map(); // sid -> { error }

function getSetting() { return store.getSetting('floatBall') || {}; }
function saveSetting(patch) { store.setSetting('floatBall', { ...getSetting(), ...patch }); }
function isEnabled() {
  if (runtimeEnabled != null) return runtimeEnabled;
  return !!getSetting().enabled;
}

// --- 窗口生命周期 -----------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,     // 不抢键盘焦点;鼠标事件不受影响
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 全局鼠标穿透:透明区域点击穿透到下层应用。
  // 注意坑(Electron 38 实测):ignore=true 时 forward 既不转发 mousemove 也不给点击,
  // 悬停检测不能依赖渲染端事件——改由主进程轮询光标 + 渲染端上报的可交互区域
  // (overlay:setRegions)做命中,悬停在球体上时临时关闭穿透(见 startHoverPoll)。
  win.setIgnoreMouseEvents(true, { forward: true });
  interactive = false;
  win.loadFile(path.join(__dirname, '..', 'overlay.html'));
  // 关不掉(quitting 除外),与主窗 close 拦截完全同构 → updater 重启/托盘退出不受影响
  win.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    win.hide();
  });
  // 渲染进程崩溃:置空引用,下次 maybeShow 懒重建
  win.webContents.on('render-process-gone', () => {
    try { win.destroy(); } catch {}
    win = null;
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 加载完成/每次显示时对齐 pendingDone,绿球在窗口重建后不丢
  win.webContents.on('did-finish-load', pushPending);
}

function isUsable() { return win && !win.isDestroyed(); }
function isVisible() { return isUsable() && win.isVisible(); }
function getWindow() { return isUsable() ? win : null; }

// 悬停交互切换(值不变时不重复调用,Windows 上反复切换有开销):
// 轮询光标命中渲染端上报的球体区域 → 悬停时关闭穿透;拖拽中强制保持。
function setInteractive(v) {
  v = !!v;
  if (v === interactive) return interactive;
  interactive = v;
  if (isUsable()) win.setIgnoreMouseEvents(!v, { forward: true });
  return interactive;
}

function startHoverPoll() {
  stopHoverPoll();
  hoverTimer = setInterval(() => {
    if (!isUsable() || !win.isVisible()) return;
    const c = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    const lx = c.x - wx, ly = c.y - wy;
    const hover = dragActive || regions.some((r) => lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h);
    setInteractive(hover);
  }, 50);
}
function stopHoverPoll() {
  if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null; }
}

// 渲染端上报可交互区域(窗口相对坐标):主球 + 可见任务小球
function setRegions(list) {
  regions = (Array.isArray(list) ? list : []).filter((r) =>
    r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h)
  );
}

function pushPending() {
  if (!isUsable()) return;
  win.webContents.send('overlay:pending', { items: [...pendingDone.entries()].map(([sid, v]) => ({ sid, error: !!v.error })) });
}

// 球心(x,y)所在屏的 workArea;不在任何屏内则取最近屏
function workAreaFor(x, y) {
  const cx = x + WIN_W / 2, cy = y + WIN_H / 2;
  let best = null, bestD = Infinity;
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea;
    if (cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height) return { display: d, wa };
    const dx = Math.max(wa.x - cx, 0, cx - (wa.x + wa.width));
    const dy = Math.max(wa.y - cy, 0, cy - (wa.y + wa.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestD) { bestD = dist; best = d; }
  }
  return { display: best, wa: best.workArea };
}

function defaultPosition() {
  // 默认落在主窗所在屏(主窗隐藏中,用其 bounds)右侧边缘纵向居中
  const mw = deps.getMainWindow && deps.getMainWindow();
  const center = mw && !mw.isDestroyed() ? { x: mw.getBounds().x + mw.getBounds().width / 2, y: mw.getBounds().y + mw.getBounds().height / 2 } : screen.getCursorScreenPoint();
  let target = screen.getAllDisplays()[0];
  for (const d of screen.getAllDisplays()) {
    const b = d.bounds;
    if (center.x >= b.x && center.x <= b.x + b.width && center.y >= b.y && center.y <= b.y + b.height) { target = d; break; }
  }
  const wa = target.workArea;
  return {
    x: wa.x + wa.width - WIN_W - 12,
    y: wa.y + Math.round((wa.height - WIN_H) / 2),
    displayId: target.id,
  };
}

function restorePosition() {
  const fb = getSetting();
  const displays = screen.getAllDisplays();
  const d = displays.find((x) => x.id === fb.displayId);
  const ok = fb.x != null && d;
  if (ok && fb.edge) {
    // 贴边停靠:坐标按 workArea 重算(flush),不盲信持久化值(任务栏布局可能变)
    const wa = d.workArea;
    let { x, y } = fb;
    if (fb.edge === 'left') x = wa.x;
    else if (fb.edge === 'right') x = wa.x + wa.width - WIN_W;
    if (fb.edge === 'top') y = wa.y;
    else if (fb.edge === 'bottom') y = wa.y + wa.height - WIN_H;
    win.setPosition(Math.round(x), Math.round(y));
  } else if (ok) {
    win.setPosition(Math.round(fb.x), Math.round(fb.y));
  } else {
    const p = defaultPosition();
    win.setPosition(p.x, p.y);
    saveSetting({ x: p.x, y: p.y, displayId: p.displayId });
  }
}

// --- 显隐状态机 -------------------------------------------------------------

function show() {
  if (!isUsable()) createWindow();
  restorePosition();
  win.showInactive(); // 不抢焦点
  startHoverPoll();
  pushPending();
}

function hide() {
  stopDrag();
  stopHoverPoll();
  setInteractive(false);
  if (isUsable() && win.isVisible()) win.hide();
}

// 主窗 minimize/close 时调用;幂等。首次且未询问过时先弹询问框。
async function maybeShow(reason) {
  if (app.isQuitting) return;
  const mw = deps.getMainWindow && deps.getMainWindow();
  if (mw && !mw.isDestroyed() && mw.isVisible()) return; // 主窗可见时不显示
  const fb = getSetting();
  if (!fb.asked && runtimeEnabled == null && !asking) await askOnce();
  if (!isEnabled()) return;
  if (isVisible()) return;
  show();
}

async function askOnce() {
  asking = true;
  try {
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: 'question',
      title: '桌面悬浮球',
      message: '窗口隐藏后继续显示桌面悬浮球?',
      detail: '悬浮球实时显示进行中的任务进度,完成的任务会以绿色小球提醒,点击即可回到对应会话。',
      buttons: ['显示悬浮球', '不用了'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      checkboxLabel: '记住我的选择(可在设置中更改)',
      checkboxChecked: true,
    });
    const enabled = response === 0;
    if (checkboxChecked) {
      runtimeEnabled = null;
      saveSetting({ asked: true, enabled });
    } else {
      runtimeEnabled = enabled; // 仅本次进程生效
    }
  } finally {
    asking = false;
  }
}

// --- 拖拽(主进程轮询光标,setPosition 只能主进程做) --------------------------

function startDrag({ dx, dy }) {
  if (!isUsable()) return;
  stopDrag();
  console.log('[overlay] dragStart', dx, dy); // 排障探针
  dragOffset = { dx: dx || 0, dy: dy || 0 };
  dragActive = true; // 拖拽中强制可交互,松手后由轮询接管
  dragTimer = setInterval(() => {
    if (!isUsable() || !dragOffset) return;
    const c = screen.getCursorScreenPoint();
    // 夹到所有屏幕的联合包围盒内,球不被拖丢
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of screen.getAllDisplays()) {
      const b = d.bounds;
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
    }
    const x = Math.round(math.clamp(c.x - dragOffset.dx, minX - WIN_W + 24, maxX - 24));
    const y = Math.round(math.clamp(c.y - dragOffset.dy, minY, maxY - 40));
    win.setPosition(x, y);
  }, 12);
}

function stopDrag() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  dragOffset = null;
  dragActive = false;
}

// 拖拽结束:停轮询,持久化位置,返回球心所在屏 workArea 供渲染端跑吸附弹簧
function endDrag() {
  stopDrag();
  if (!isUsable()) return null;
  const [x, y] = win.getPosition();
  const { display, wa } = workAreaFor(x, y);
  saveSetting({ x, y, displayId: display ? display.id : undefined });
  return { x, y, workArea: { id: display ? display.id : undefined, ...wa } };
}

// 弹簧逐帧设位:夹取到当前所在屏 workArea。edge 非空=贴边停靠(该轴 flush 到边缘、
// 留白 0,配合渲染端半圆变形);否则自由摆放(常规留白 clamp)
function setPos({ x, y, edge }) {
  if (!isUsable()) return;
  const { wa } = workAreaFor(x, y);
  let cx = Math.round(x), cy = Math.round(y);
  if (edge === 'left') cx = wa.x;
  else if (edge === 'right') cx = wa.x + wa.width - WIN_W;
  else cx = math.clamp(cx, wa.x + EDGE_MARGIN, wa.x + wa.width - WIN_W - EDGE_MARGIN);
  if (edge === 'top') cy = wa.y;
  else if (edge === 'bottom') cy = wa.y + wa.height - WIN_H;
  else cy = math.clamp(cy, wa.y + EDGE_MARGIN, wa.y + wa.height - WIN_H - EDGE_MARGIN);
  win.setPosition(cx, cy);
}

function setDock({ x, y, edge, displayId }) {
  saveSetting({ x: Math.round(x), y: Math.round(y), edge, displayId });
}

// --- pendingDone / 交互 -----------------------------------------------------

// 回合结束(主进程 onTurnDone 包装调用):绿球/红球进待查看集合
function onTurnDone(session, ev) {
  try {
    if (session && session.meta && math.isTrackableKind(session.meta.kind)) {
      pendingDone.set(session.id, { error: !!(ev && ev.is_error) });
      pushPending();
    }
  } catch {}
}

function clearDone() {
  pendingDone.clear();
  pushPending();
}

function jump({ sid }) {
  if (sid) pendingDone.delete(sid);
  pushPending();
  if (deps.sessions) deps.sessions.jumpToSession(sid);
  // jumpToSession show 主窗 → 'show' 事件 → hide(),联动隐藏自动发生
}

function showMain() {
  clearDone();
  if (deps.showMainWindow) deps.showMainWindow();
}

function setEnabled(enabled) {
  runtimeEnabled = null;
  saveSetting({ asked: true, enabled: !!enabled });
  if (!enabled) hide();
}

function openMenu({ sid } = {}) {
  if (!isUsable()) return;
  const items = [{ label: '显示 Drafter', click: showMain }];
  if (sid && pendingDone.has(sid)) {
    items.push({ label: '标记已查看', click: () => { pendingDone.delete(sid); pushPending(); } });
  }
  items.push(
    { label: '清除全部完成提醒', click: clearDone },
    { type: 'separator' },
    { label: '关闭悬浮球', click: () => setEnabled(false) },
  );
  Menu.buildFromTemplate(items).popup({ window: win });
}

// --- 初始化 -----------------------------------------------------------------

function init(d) {
  deps = d || {};
}

function registerIpc() {
  ipcMain.handle('overlay:getState', () => {
    if (!isUsable()) return null;
    const [x, y] = win.getPosition();
    return {
      x, y,
      interactive,
      dragging: dragActive,
      edge: getSetting().edge || null,
      size: [WIN_W, WIN_H],
      workAreas: screen.getAllDisplays().map((d) => ({ id: d.id, x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height })),
    };
  });
  ipcMain.handle('overlay:dragStart', (_e, p) => { startDrag(p || {}); return true; });
  ipcMain.handle('overlay:dragEnd', () => endDrag());
  ipcMain.handle('overlay:setPos', (_e, p) => { setPos(p || {}); return true; });
  ipcMain.handle('overlay:setRegions', (_e, p) => { setRegions(p && p.regions); return true; });
  ipcMain.handle('overlay:setDock', (_e, p) => { setDock(p || {}); return true; });
  ipcMain.handle('overlay:jump', (_e, p) => { jump(p || {}); return true; });
  ipcMain.handle('overlay:menu', (_e, p) => { openMenu(p || {}); return true; });
  ipcMain.handle('overlay:showMain', () => { showMain(); return true; });
}

module.exports = { init, registerIpc, maybeShow, hide, show, isVisible, getWindow, onTurnDone, setEnabled, isEnabled, clearDone };
