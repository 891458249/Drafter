// 桌面悬浮球(v0.13.3)渲染端:任务进度聚合 + 拖拽/果冻吸附 + 交互。
// 纯逻辑(预测进度/聚合状态机/吸附/弹簧)与主窗 chat.js 同源,统一在 overlayMath.js
// (由 overlay.html 以经典脚本引入,挂 window.overlayMath;Chromium ESM 不认 CJS)。
const math = window.overlayMath;

const { predictedPct, snapshotToMap, reduceSessEvent, snapWindow, springStep, clamp, SNAP_THRESHOLD } = math;

// 球在窗口内的 rect(与 overlay.html #ball 布局一致;reportRegions/snapWindow 共用)
const BALL = { ox: 16, oy: 4, w: 64, h: 64 };

const ball = document.getElementById('ball');
const orbsEl = document.getElementById('orbs');

let winSize = [96, 340];
const tasks = new Map();      // sid -> {id,title,busy,running,turnStart,done,error}(overlayMath 聚合态)
const pending = new Map();    // sid -> {error} 主进程持久待查看集合(窗口重建后不丢)
const titleCache = new Map(); // sid -> title(轮询 sessList 更新)

// --- 数据 -------------------------------------------------------------------

async function refreshSnapshot() {
  try {
    const list = await api.sessList();
    const snap = snapshotToMap(list);
    for (const s of list) if (s.title) titleCache.set(s.id, s.title);
    // 合入快照:新出现的 busy 会话加进来;已不在快照且非 done/pending 的清理掉
    for (const [sid, t] of snap) tasks.set(sid, t);
    for (const [sid, t] of [...tasks]) {
      if (!snap.has(sid) && !t.done && !pending.has(sid)) tasks.delete(sid);
    }
    render();
  } catch {}
}

api.on('sess:event', (payload) => {
  if (!payload || !payload.sid) return;
  const had = tasks.get(payload.sid);
  reduceSessEvent(tasks, payload);
  const now = tasks.get(payload.sid);
  if (now && had !== now && titleCache.has(payload.sid)) now.title = titleCache.get(payload.sid);
  render();
});

api.on('overlay:pending', ({ items }) => {
  pending.clear();
  for (const it of items || []) pending.set(it.sid, { error: !!it.error });
  render();
});

setInterval(refreshSnapshot, 15000); // 对账:纠正竞态丢失,补标题

// --- 渲染 -------------------------------------------------------------------

function visibleTasks() {
  const out = [];
  for (const t of tasks.values()) {
    if (t.busy || t.done) out.push(t);
  }
  // 主进程 pending 里有但本地聚合已丢的(窗口重建等),兜底显示
  for (const [sid, p] of pending) {
    if (!out.some((t) => t.id === sid)) {
      out.push({ id: sid, title: titleCache.get(sid) || '会话', busy: false, done: true, error: p.error, turnStart: null });
    }
  }
  return out;
}

let orbEls = new Map(); // sid -> el

function render() {
  const list = visibleTasks();
  const MAX = 6;
  const shown = list.slice(0, MAX);
  for (const [sid, el] of orbEls) {
    if (!shown.some((t) => t.id === sid)) { el.remove(); orbEls.delete(sid); }
  }
  for (const t of shown) {
    let el = orbEls.get(t.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'orb';
      el.innerHTML = '<div class="dot"><span></span></div>';
      el.addEventListener('click', () => onOrbClick(t.id));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); api.overlayMenu({ sid: t.id }); });
      orbsEl.appendChild(el);
      orbEls.set(t.id, el);
    }
    el.classList.toggle('done', !!t.done && !t.error);
    el.classList.toggle('error', !!t.error);
    el.classList.toggle('busy', !!t.busy && !t.done);
    el.title = t.title || t.id;
    el.querySelector('span').textContent = t.title ? t.title.slice(0, 2) : '…';
  }
  let more = document.getElementById('more');
  if (list.length > MAX) {
    if (!more) {
      more = document.createElement('div');
      more.id = 'more';
      orbsEl.appendChild(more);
    }
    more.textContent = `+${list.length - MAX}`;
  } else if (more) {
    more.remove();
  }
  reportRegions();
}

function onOrbClick(sid) {
  const t = tasks.get(sid);
  if (t && t.done) tasks.delete(sid);
  pending.delete(sid);
  api.overlayJump({ sid }); // 主进程清 pending + 唤主窗定位会话,主窗 show 联动隐藏悬浮球
  render();
}

// --- 贴边停靠形态(变形由弹簧进度逐帧驱动,平滑过渡) ---------------------------
// dockedEdge: null=整圆球;'left'/'right'/'top'/'bottom'=半圆页签(平边贴屏幕边缘)
// morphP: 0=整圆 → 1=完全贴边;由吸附弹簧进度驱动,贴边/拖起都连续变形
// squash: 果冻挤压(拖拽速度驱动),与 morph 合成在一个 transform 里
let dockedEdge = null;
let morphP = 0;
let squash = { sx: 1, sy: 1 };

function morphOffset(p) {
  switch (dockedEdge) {
    case 'left':   return { x: -16 * p, y: 0 };
    case 'right':  return { x: 16 * p, y: 0 };
    case 'top':    return { x: 0, y: -4 * p };
    case 'bottom': return { x: 0, y: 272 * p };
    default:       return { x: 0, y: 0 };
  }
}
function morphRadius(p) {
  if (!dockedEdge || p <= 0) return '50%';
  const q = 32 * (1 - p);
  switch (dockedEdge) {
    case 'left':   return `${q}px 32px 32px ${q}px`;
    case 'right':  return `32px ${q}px ${q}px 32px`;
    case 'top':    return `${q}px ${q}px 32px 32px`;
    default:       return `32px 32px ${q}px ${q}px`;
  }
}
function applyBallVisual() {
  const m = morphOffset(morphP);
  ball.style.transform = `translate(${m.x}px, ${m.y}px) scale(${squash.sx}, ${squash.sy})`;
  ball.style.borderRadius = morphRadius(morphP);
}
function applyDockClass() {
  // .dock-* 仅作状态标记(冒烟断言/样式兜底),视觉由 applyBallVisual 逐帧驱动
  ball.classList.remove('dock-left', 'dock-right', 'dock-top', 'dock-bottom');
  if (dockedEdge) ball.classList.add('dock-' + dockedEdge);
}
// 从贴边态拖起:220ms 圆回整圆球
function animateUndock() {
  if (morphP <= 0) { dockedEdge = null; applyDockClass(); reportRegions(); return; }
  const from = morphP;
  const t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / 220);
    morphP = from * (1 - k);
    applyBallVisual();
    if (k < 1) requestAnimationFrame(tick);
    else { dockedEdge = null; applyDockClass(); reportRegions(); }
  };
  requestAnimationFrame(tick);
}

// --- 可交互区域上报 -----------------------------------------------------------
// 窗口全局穿透,由主进程轮询光标做命中(见 src/main/overlay.js startHoverPoll);
// 这里上报球体所在的窗口相对坐标:主球固定 (16,4,64,64),小球槽位 76+46i。
// 注意坑(Electron 38 实测):ignore=true 时 forward 连 mousemove 都不转发,
// 悬停检测不能放在渲染端。
function reportRegions() {
  const n = visibleTasks().slice(0, 6).length;
  // 贴边时球在窗口内向边缘平移(见 morphOffset),区域随之调整
  const m = morphOffset(morphP >= 0.5 ? 1 : 0);
  const ballRect = { x: BALL.ox + m.x, y: BALL.oy + m.y, w: BALL.w, h: BALL.h };
  const regions = [ballRect];
  for (let i = 0; i < n; i++) regions.push({ x: 28, y: 76 + i * 46, w: 40, h: 40 });
  api.overlaySetRegions({ regions });
}

// --- 拖拽 + 果冻吸附 --------------------------------------------------------

let dragging = false;
let lastMove = null;      // {x, y, t} 指针速度估算
let dragVel = { x: 0, y: 0 };

function setSquash(vx, vy, dominantAxis) {
  const sp = Math.hypot(vx, vy);
  if (sp < 40) { ball.style.transform = ''; return; }
  const s = clamp(1 + sp * 0.0018, 0.78, 1.28);
  const p = clamp(1 - (s - 1) * 0.55, 0.78, 1.28);
  // 运动方向轴拉伸、垂直轴压缩(果冻体积守恒感)
  ball.style.transform = dominantAxis === 'y' ? `scale(${p}, ${s})` : `scale(${s}, ${p})`;
}

ball.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  dragging = true;
  if (springRAF) { cancelAnimationFrame(springRAF); springRAF = null; }
  animateUndock();          // 从贴边态拖起:圆平滑变回整圆球
  ball.classList.add('dragging');
  try { ball.setPointerCapture(e.pointerId); } catch (err) { window.__orbErr = String(err); }
  window.__orbDragStart = true; // 冒烟/排障探针
  lastMove = { x: e.clientX, y: e.clientY, t: performance.now() };
  dragVel = { x: 0, y: 0 };
  api.overlayDragStart({ dx: e.clientX, dy: e.clientY }); // 主进程轮询光标 setPosition
});

ball.addEventListener('pointermove', (e) => {
  if (!dragging || !lastMove) return;
  const now = performance.now();
  const dt = Math.max(1, now - lastMove.t) / 1000;
  // 指数平滑限速,避免指针跳变
  dragVel.x = dragVel.x * 0.7 + ((e.clientX - lastMove.x) / dt) * 0.3;
  dragVel.y = dragVel.y * 0.7 + ((e.clientY - lastMove.y) / dt) * 0.3;
  lastMove = { x: e.clientX, y: e.clientY, t: now };
  // 运动方向轴拉伸、垂直轴压缩(果冻体积守恒感)
  const sp = Math.hypot(dragVel.x, dragVel.y);
  if (sp < 40) squash = { sx: 1, sy: 1 };
  else {
    const dominantX = Math.abs(dragVel.x) > Math.abs(dragVel.y);
    const s = clamp(1 + sp * 0.0018, 0.78, 1.28);
    const p = clamp(1 - (s - 1) * 0.55, 0.78, 1.28);
    squash = dominantX ? { sx: s, sy: p } : { sx: p, sy: s };
  }
  applyBallVisual();
});

ball.addEventListener('pointerup', endDrag);
ball.addEventListener('pointercancel', endDrag);

async function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  ball.classList.remove('dragging');
  squash = { sx: 1, sy: 1 };
  applyBallVisual();
  const res = await api.overlayDragEnd(); // {x, y, workArea} 主进程已停轮询并持久化位置
  if (res && res.workArea) springTo(res.x, res.y, res.workArea);
}

// 阻尼弹簧吸附:归一化位移弹簧(欠阻尼过一次冲),逐帧 overlay:setPos 驱窗口;
// 贴边变形 morphP 与果冻挤压由弹簧进度逐帧合成(transform/borderRadius),
// 整圆→半圆页签全程平滑。仅当球心距边缘 ≤ SNAP_THRESHOLD 才吸附(用球 rect
// 而非窗口中心算距离——上下边缘的识别关键,见 overlayMath.snapWindow)。
let springRAF = null;
function springTo(x, y, wa) {
  if (springRAF) cancelAnimationFrame(springRAF);
  const target = snapWindow({ x, y }, BALL, wa);
  if (target.dist > SNAP_THRESHOLD) {
    animateUndock();
    dock({ x, y, edge: null }, wa); // 自由摆放:原地持久化,无吸附动画
    return;
  }
  // 吸附:贴边形态随弹簧进度连续变形(半圆页签滑向边缘)
  dockedEdge = target.edge;
  applyDockClass();
  reportRegions();
  const dx = target.x - x, dy = target.y - y;
  const dist = Math.hypot(dx, dy);
  if (dist < 4) { morphP = 1; applyBallVisual(); dock(target, wa); return; }
  const ux = dx / dist, uy = dy / dist;
  // 初速度继承拖拽末速度(甩出去再拉回来);投影到目标方向上
  const v0 = clamp(dragVel.x * ux + dragVel.y * uy, -1500, 1500);
  const state = { x: dist, v: v0 };
  let prev = performance.now();
  const step = (now) => {
    const dt = (now - prev) / 1000;
    prev = now;
    const done = springStep(state, dt);
    const px = target.x - ux * state.x;
    const py = target.y - uy * state.x;
    morphP = clamp(1 - state.x / dist, 0, 1);
    // 弹簧末段挤压形变(同拖拽果冻一致的缩放系数)
    const sp = Math.abs(state.v);
    if (sp < 40) squash = { sx: 1, sy: 1 };
    else {
      const dominantX = Math.abs(ux) > Math.abs(uy);
      const s = clamp(1 + sp * 0.0018, 0.78, 1.28);
      const p = clamp(1 - (s - 1) * 0.55, 0.78, 1.28);
      squash = dominantX ? { sx: s, sy: p } : { sx: p, sy: s };
    }
    applyBallVisual();
    api.overlaySetPos({ x: px, y: py, edge: target.edge });
    if (done) {
      squash = { sx: 1, sy: 1 };
      morphP = 1;
      applyBallVisual();
      dock(target, wa);
      return;
    }
    springRAF = requestAnimationFrame(step);
  };
  springRAF = requestAnimationFrame(step);
}

function dock(target, wa) {
  dockedEdge = target.edge;
  applyDockClass();
  api.overlaySetPos({ x: target.x, y: target.y, edge: target.edge });
  api.overlaySetDock({ x: target.x, y: target.y, edge: target.edge, displayId: wa.id });
  reportRegions();
}

// --- 其他交互 ---------------------------------------------------------------

ball.addEventListener('dblclick', () => api.overlayShowMain()); // 显示主窗 + 清绿球
ball.addEventListener('contextmenu', (e) => { e.preventDefault(); api.overlayMenu({}); });

// --- boot -------------------------------------------------------------------

(async function boot() {
  try {
    const st = await api.overlayGetState();
    if (st && st.size) winSize = st.size;
    if (st && st.edge) { // 恢复贴边形态(直接到终态)
      dockedEdge = st.edge;
      morphP = 1;
      applyDockClass();
      applyBallVisual();
    }
  } catch {}
  await refreshSnapshot();
  render();
  window.__orbModuleOK = true; // 冒烟探针:模块完整求值(监听器全部挂好)
})();
