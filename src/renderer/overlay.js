// 桌面悬浮球(v0.13.3)渲染端:任务进度聚合 + 拖拽/果冻吸附 + 交互。
// 纯逻辑(预测进度/聚合状态机/吸附/弹簧)与主窗 chat.js 同源,统一在 overlayMath.js
// (由 overlay.html 以经典脚本引入,挂 window.overlayMath;Chromium ESM 不认 CJS)。
const math = window.overlayMath;

const { predictedPct, snapshotToMap, reduceSessEvent, snapTarget, springStep, clamp } = math;

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
    el.title = t.title || t.id;
    el.querySelector('span').textContent = t.title ? t.title.slice(0, 2) : '…';
    if (t.done) el.style.setProperty('--pct', 100);
    else el.style.setProperty('--pct', predictedPct(t.turnStart));
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

// 进度环 500ms 走字(预测曲线)
setInterval(() => {
  for (const [sid, el] of orbEls) {
    const t = tasks.get(sid);
    if (t && t.busy && !t.done) el.style.setProperty('--pct', predictedPct(t.turnStart));
  }
}, 500);

function onOrbClick(sid) {
  const t = tasks.get(sid);
  if (t && t.done) tasks.delete(sid);
  pending.delete(sid);
  api.overlayJump({ sid }); // 主进程清 pending + 唤主窗定位会话,主窗 show 联动隐藏悬浮球
  render();
}

// --- 可交互区域上报 -----------------------------------------------------------
// 窗口全局穿透,由主进程轮询光标做命中(见 src/main/overlay.js startHoverPoll);
// 这里上报球体所在的窗口相对坐标:主球固定 (16,4,64,64),小球槽位 76+46i。
// 注意坑(Electron 38 实测):ignore=true 时 forward 连 mousemove 都不转发,
// 悬停检测不能放在渲染端。
function reportRegions() {
  const n = visibleTasks().slice(0, 6).length;
  const regions = [{ x: 16, y: 4, w: 64, h: 64 }];
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
  setSquash(dragVel.x, dragVel.y, Math.abs(dragVel.x) > Math.abs(dragVel.y) ? 'x' : 'y');
});

ball.addEventListener('pointerup', endDrag);
ball.addEventListener('pointercancel', endDrag);

async function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  ball.classList.remove('dragging');
  ball.style.transform = '';
  const res = await api.overlayDragEnd(); // {x, y, workArea} 主进程已停轮询并持久化位置
  if (res && res.workArea) springTo(res.x, res.y, res.workArea);
}

// 阻尼弹簧吸附:归一化位移弹簧(欠阻尼过一次冲),逐帧 overlay:setPos 驱窗口,
// 过冲/形变由 CSS transform 表现(窗口始终被主进程 clamp 在 workArea 内)。
let springRAF = null;
function springTo(x, y, wa) {
  if (springRAF) cancelAnimationFrame(springRAF);
  const [w, h] = winSize;
  const target = snapTarget({ x, y, w, h }, wa);
  const dx = target.x - x, dy = target.y - y;
  const dist = Math.hypot(dx, dy);
  if (dist < 4) { dock(target, wa); return; }
  const ux = dx / dist, uy = dy / dist;
  // 初速度继承拖拽末速度(甩出去再拉回来);投影到目标方向上
  const v0 = clamp(dragVel.x * ux + dragVel.y * uy, -1500, 1500);
  const state = { x: dist, v: v0 };
  const dominant = Math.abs(ux) > Math.abs(uy) ? 'x' : 'y';
  let prev = performance.now();
  const step = (now) => {
    const dt = (now - prev) / 1000;
    prev = now;
    const done = springStep(state, dt);
    const px = target.x - ux * state.x;
    const py = target.y - uy * state.x;
    api.overlaySetPos({ x: px, y: py });
    setSquash(ux * state.v, uy * state.v, dominant);
    if (done) {
      ball.style.transform = '';
      dock(target, wa);
      return;
    }
    springRAF = requestAnimationFrame(step);
  };
  springRAF = requestAnimationFrame(step);
}

function dock(target, wa) {
  api.overlaySetPos({ x: target.x, y: target.y });
  api.overlaySetDock({ x: target.x, y: target.y, edge: target.edge, displayId: wa.id });
}

// --- 其他交互 ---------------------------------------------------------------

ball.addEventListener('dblclick', () => api.overlayShowMain()); // 显示主窗 + 清绿球
ball.addEventListener('contextmenu', (e) => { e.preventDefault(); api.overlayMenu({}); });

// --- boot -------------------------------------------------------------------

(async function boot() {
  try {
    const st = await api.overlayGetState();
    if (st && st.size) winSize = st.size;
  } catch {}
  await refreshSnapshot();
  render();
  window.__orbModuleOK = true; // 冒烟探针:模块完整求值(监听器全部挂好)
})();
