// 桌面悬浮球(v0.13.3)纯逻辑:预测进度/任务聚合/边缘吸附/弹簧步进。
// 全部为无 DOM、无 Electron 依赖的纯函数,node --test 直接测;
// 主进程 overlayMgr 与悬浮球渲染端共用同一份逻辑。
'use strict';

// 预测进度:与 chat.js 的预测式进度条同参数(时间双曲线渐近 92%)
const PREDICT_ASYMPTOTE = 92;
const PREDICT_HALF_MS = 25000;

// now 可注入以便测试
function predictedPct(turnStart, now = Date.now()) {
  const t = Math.max(0, now - (turnStart || now));
  return Math.min(PREDICT_ASYMPTOTE, Math.round(PREDICT_ASYMPTOTE * t / (t + PREDICT_HALF_MS)));
}

// 一期只做 code/chat 会话(kind 为 null/'code'/'chat'),排除媒体/画布任务
function isTrackableKind(kind) {
  return kind == null || kind === 'code' || kind === 'chat';
}

// 会话列表快照 → 聚合 Map(悬浮球晚于会话启动加载时的初始态)
// list: sessions.list() 的输出 [{...meta, running, busy}]
function snapshotToMap(list, now = Date.now()) {
  const map = new Map();
  for (const s of list || []) {
    if (!isTrackableKind(s.kind)) continue;
    map.set(s.id, {
      id: s.id,
      title: s.title || s.cwd || '会话',
      busy: !!s.busy,
      running: !!s.running,
      // 快照里没有回合起点,从加载时刻起 ramp;事件流会逐步纠正
      turnStart: s.busy ? now : null,
      done: false,
      error: false,
    });
  }
  return map;
}

// sess:event 增量聚合(逻辑精简自 chat.js renderEvent 的回合状态机)
// ev.type: 'ui_status' {busy,running} / 'result' {is_error} / 其余忽略
function reduceSessEvent(map, { sid, ev }, now = Date.now()) {
  if (!sid || !ev) return map;
  const cur = map.get(sid);
  if (ev.type === 'ui_status') {
    const busy = !!ev.busy;
    const running = ev.running !== undefined ? !!ev.running : (cur ? cur.running : false);
    if (busy) {
      // busy 由 false→true:新回合开始
      if (!cur || !cur.busy) {
        map.set(sid, {
          id: sid,
          title: cur ? cur.title : '会话',
          busy: true, running: true,
          turnStart: now, done: false, error: false,
        });
      } else {
        cur.running = true;
      }
    } else if (!running) {
      // busy 与 running 都 false:进程已停;但刚结束(done)的球要留到用户点击查看
      if (cur && cur.done) cur.busy = false;
      else map.delete(sid);
    } else if (cur) {
      cur.busy = false;
    }
  } else if (ev.type === 'result') {
    // 回合结束:变绿(出错变红),等待用户点击查看
    map.set(sid, {
      id: sid,
      title: cur ? cur.title : '会话',
      busy: false,
      running: cur ? cur.running : false,
      turnStart: cur ? cur.turnStart : null,
      done: true,
      error: !!ev.is_error,
    });
  }
  return map;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// 边缘吸附:取球心到 workArea 四边的最小距离(必须用 workArea 而非 display.bounds,
// 排除任务栏);返回 {edge, x, y, dist},坐标已沿边 clamp 保证整球不出 workArea。
// dist = 球心到该边缘的距离,调用方据此决定是否吸附(仅靠近边缘时才吸)。
// ball: {x, y, w, h}(窗口坐标);wa: {x, y, width, height}
const SNAP_THRESHOLD = 80; // 松手点距边缘 ≤ 此值(球心距离)才吸附,否则自由摆放

function snapTarget(ball, wa, margin = 8) {
  const cx = ball.x + ball.w / 2;
  const cy = ball.y + ball.h / 2;
  const cands = [
    { edge: 'left',   dist: cx - wa.x,                x: wa.x + margin,                    y: cy },
    { edge: 'right',  dist: wa.x + wa.width - cx,     x: wa.x + wa.width - ball.w - margin, y: cy },
    { edge: 'top',    dist: cy - wa.y,                y: wa.y + margin,                    x: cx },
    { edge: 'bottom', dist: wa.y + wa.height - cy,    y: wa.y + wa.height - ball.h - margin, x: cx },
  ];
  cands.sort((a, b) => a.dist - b.dist);
  const t = cands[0];
  t.dist = Math.max(0, t.dist); // 球心已越界时取 0(视为紧贴)
  if (t.edge === 'left' || t.edge === 'right') {
    // y 存的是球心,clamp 后换回左上角坐标
    t.y = clamp(t.y, wa.y + margin + ball.h / 2, wa.y + wa.height - ball.h / 2 - margin) - ball.h / 2;
  } else {
    t.x = clamp(t.x, wa.x + margin + ball.w / 2, wa.x + wa.width - ball.w / 2 - margin) - ball.w / 2;
  }
  return t;
}

// 以「窗口 + 窗口内球的 rect」求吸附:悬浮窗里球不在窗口几何中心(96×340 窗口、
// 球 rect 偏移 16,4 尺寸 64×64),若直接用窗口中心算距离,上下边缘永远到不了
// 阈值(中心偏 170px)——必须换算成球 rect 再 snap,结果再换算回窗口坐标。
// win: {x, y}(窗口左上);ball: {ox, oy, w, h}(球在窗口内的 rect)
function snapWindow(win, ball, wa, margin = 8) {
  const t = snapTarget({ x: win.x + ball.ox, y: win.y + ball.oy, w: ball.w, h: ball.h }, wa, margin);
  return { edge: t.edge, dist: t.dist, x: t.x - ball.ox, y: t.y - ball.oy };
}

// 阻尼弹簧(半隐式欧拉,归一化位移):k 刚度、c 阻尼;欠阻尼(c < 2√k)允许一次
// 过冲——果冻感的来源。state: {x, v}(x = 到目标的归一化位移);dt 秒。
// 返回 true 表示已收敛(|x|<0.5px 且 |v|<5px/s,调用方钉死到目标坐标)。
function springStep(state, dt, k = 380, c = 30) {
  dt = Math.min(Math.max(dt, 0), 1 / 30); // 掉帧保护
  const a = -k * state.x - c * state.v;
  state.v += a * dt;
  state.x += state.v * dt;
  return Math.abs(state.x) < 0.5 && Math.abs(state.v) < 5;
}

// 双环境导出:Node(CJS,主进程/单测)走 module.exports;渲染端(浏览器 ESM 加载器
// 不认 CJS interop)由 <script> 经典脚本引入挂 window.overlayMath。
// 坑:Chromium 对 .js 一律按 ESM 解析,「import x from CJS」报
//「does not provide an export named 'default'」且整个模块静默不执行。
const M = {
  PREDICT_ASYMPTOTE,
  PREDICT_HALF_MS,
  SNAP_THRESHOLD,
  predictedPct,
  isTrackableKind,
  snapshotToMap,
  reduceSessEvent,
  snapTarget,
  snapWindow,
  springStep,
  clamp,
};
if (typeof module !== 'undefined' && module.exports) module.exports = M;
else window.overlayMath = M;
