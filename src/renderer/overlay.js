// 桌面悬浮球(v0.13.3)渲染端:任务进度聚合 + 拖拽/果冻吸附 + 交互。
// 纯逻辑(预测进度/聚合状态机/吸附/弹簧)与主窗 chat.js 同源,统一在 overlayMath.js
// (由 overlay.html 以经典脚本引入,挂 window.overlayMath;Chromium ESM 不认 CJS)。
const math = window.overlayMath;

const { predictedPct, snapshotToMap, reduceSessEvent, snapWindow, springStep, clamp, SNAP_THRESHOLD, BALL_RECT } = math;

// 主进程拖拽边界与渲染端吸附共享同一主球几何。
const BALL = BALL_RECT;

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
let dragVisualOffset = null; // 拖拽期间保持球体平移不变,圆角动画不改变抓取点
let undockRAF = null;

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
// 任务小球的贴边跟随:底边停靠时主球已下压 272px,任务球要堆叠到主球上方,
// 否则悬在原槽位半空(实测底边吸附时小球距主球 200+px);拖拽中整体跟随主球
// 偏移,松手时随 dragVisualOffset 一起归一,与主球的窗口补偿同帧完成。
function orbsOffset(m) {
  if (dragVisualOffset) return m;
  if (dockedEdge === 'bottom' && m.y > 0) {
    const n = orbsEl.childElementCount;
    const stack = n ? n * 46 - 6 : 0; // .orb 40px + 6px 间距
    return { x: 0, y: Math.max(192 - stack, -72) * (m.y / 272) };
  }
  return m;
}
function applyBallVisual() {
  const m = dragVisualOffset || morphOffset(morphP);
  ball.style.transform = `translate(${m.x}px, ${m.y}px) scale(${squash.sx}, ${squash.sy})`;
  ball.style.borderRadius = morphRadius(morphP);
  const o = orbsOffset(m);
  orbsEl.style.transform = (o.x || o.y) ? `translate(${o.x}px, ${o.y}px)` : '';
}
function applyDockClass() {
  // .dock-* 仅作状态标记(冒烟断言/样式兜底),视觉由 applyBallVisual 逐帧驱动
  ball.classList.remove('dock-left', 'dock-right', 'dock-top', 'dock-bottom');
  if (dockedEdge) ball.classList.add('dock-' + dockedEdge);
}
// 从贴边态拖起:220ms 圆回整圆球
function animateUndock() {
  if (undockRAF) { cancelAnimationFrame(undockRAF); undockRAF = null; }
  if (morphP <= 0) { dockedEdge = null; applyDockClass(); reportRegions(); return; }
  const from = morphP;
  const t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / 220);
    morphP = from * (1 - k);
    applyBallVisual();
    if (k < 1) undockRAF = requestAnimationFrame(tick);
    else { undockRAF = null; dockedEdge = null; applyDockClass(); reportRegions(); }
  };
  undockRAF = requestAnimationFrame(tick);
}

// --- 可交互区域上报 -----------------------------------------------------------
// 窗口全局穿透,由主进程轮询光标做命中(见 src/main/overlay.js startHoverPoll);
// 这里上报球体所在的窗口相对坐标:主球固定 (16,4,64,64),小球槽位 76+46i。
// 注意坑(Electron 38 实测):ignore=true 时 forward 连 mousemove 都不转发,
// 悬停检测不能放在渲染端。
function reportRegions() {
  const n = visibleTasks().slice(0, 6).length;
  // 贴边时球在窗口内向边缘平移(见 morphOffset),区域随之调整
  const m = dragVisualOffset || morphOffset(morphP);
  const ballRect = { x: BALL.ox + m.x, y: BALL.oy + m.y, w: BALL.w, h: BALL.h };
  const o = orbsOffset(m); // 与 orbsEl 的实际 transform 一致,命中区域才点得中
  const regions = [ballRect];
  for (let i = 0; i < n; i++) regions.push({ x: 28 + o.x, y: 76 + i * 46 + o.y, w: 40, h: 40 });
  api.overlaySetRegions({ regions });
}

// --- 拖拽 + 果冻吸附 --------------------------------------------------------

let dragging = false;
let lastMove = null;      // {x, y, t} 指针速度估算
let dragVel = { x: 0, y: 0 };
let dragStarted = false;  // 移动超死区后才真正开始(此前不通知主进程,纯点击不重吸附)
let grabStart = null;     // 按下时的窗口相对坐标
let prevDock = null;      // 按下时的吸附形态;纯点击松手时恢复,保证 dblclick 目标静止

function setSquash(vx, vy, dominantAxis) {
  const sp = Math.hypot(vx, vy);
  if (sp < 40) { ball.style.transform = ''; return; }
  const s = clamp(1 + sp * 0.0018, 0.78, 1.28);
  const p = clamp(1 - (s - 1) * 0.55, 0.78, 1.28);
  // 运动方向轴拉伸、垂直轴压缩(果冻体积守恒感)
  ball.style.transform = dominantAxis === 'y' ? `scale(${p}, ${s})` : `scale(${s}, ${p})`;
}

ball.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || dragging || dragVisualOffset) return;
  e.preventDefault();
  dragging = true;
  dragStarted = false;
  grabStart = { x: e.clientX, y: e.clientY };
  prevDock = { edge: dockedEdge, morphP };
  if (springRAF) { cancelAnimationFrame(springRAF); springRAF = null; }
  dragVisualOffset = morphOffset(morphP);
  animateUndock();          // 只圆回形状,保持球体在窗口内的偏移
  ball.classList.add('dragging');
  try { ball.setPointerCapture(e.pointerId); } catch (err) { window.__orbErr = String(err); }
  window.__orbDragStart = true; // 冒烟/排障探针
  lastMove = { x: e.clientX, y: e.clientY, t: performance.now() };
  dragVel = { x: 0, y: 0 };
});

ball.addEventListener('pointermove', (e) => {
  if (!dragging || !lastMove) return;
  // 6px 死区:纯点击(含 dblclick)不启动主进程拖拽轮询,吸附形态原地保持,
  // 目标不移动才能凑齐双击;此前按下即启动,松开必触发一轮解除+重吸附动画。
  if (!dragStarted) {
    if (Math.hypot(e.clientX - grabStart.x, e.clientY - grabStart.y) <= 6) return;
    dragStarted = true;
    api.overlayDragStart({ dx: grabStart.x, dy: grabStart.y, offset: dragVisualOffset });
  }
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
  if (undockRAF) { cancelAnimationFrame(undockRAF); undockRAF = null; }
  if (!dragStarted) {
    // 纯点击:未通知主进程,无需归一;恢复按下时的吸附形态(undock 只动了圆角),
    // 球体全程静止,click/dblclick 才能落在同一目标上
    dragVisualOffset = null;
    if (prevDock && prevDock.edge) { dockedEdge = prevDock.edge; morphP = prevDock.morphP; }
    prevDock = null;
    squash = { sx: 1, sy: 1 };
    applyBallVisual();
    applyDockClass();
    reportRegions();
    return;
  }
  squash = { sx: 1, sy: 1 };
  applyBallVisual();
  // 主进程把窗口平移补偿回普通球坐标;随后去掉同一视觉偏移,屏幕落点不变。
  const res = await api.overlayDragEnd();
  dragVisualOffset = null;
  morphP = 0;
  dockedEdge = null;
  prevDock = null;
  applyBallVisual();
  applyDockClass();
  reportRegions();
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
    // 形变偏移必须实时折算进窗口坐标:球体视觉位置 = 窗口 + 槽位 + 形变,
    // 不扣除的话「窗口沿弹簧路径移动 + 球体在窗口内下压」会叠加成瞬移/出屏
    //(底部形变 272px,实测首帧上跳 264px 再吸回);edge 只在 dock 时给主进程,
    // 弹簧期间走自由夹取,主进程不得提前把窗口钉到边缘。
    const m = morphOffset(morphP);
    api.overlaySetPos({ x: px - m.x, y: py - m.y });
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
