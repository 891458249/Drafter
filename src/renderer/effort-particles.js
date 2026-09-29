// 推理深度彗尾粒子场(v0.15.26 源码):运动方式回到 v0.15.24 的平铺方格,同时保留 v0.15.25 的「经过处留痕」。
//
// 两层内容都对齐在同一套方格上(2px 方块、3.5px 间距、6 行,纵向居中),每个方块只做小幅漂移后淡出:
//   · 彗尾本体:手柄后方 40 列 × 6 行的锥形方阵,规则与 v0.15.24 的 cometPixelsHtml 一致
//     (头部最亮、越往尾端越稀疏、外侧行尾巴更短;每格亮度/周期/相位/漂移由哈希乱序),随头部移动;
//   · 拖动留痕:手柄扫过的每一列在 6 行上各落一个方块,留在原地向左漂 3–12px、上下 ±1.25px 后消散。
// 同一套实现同时用于面板滑轨与入口按键背景,两者由 effort-ui.js 的 render() 每次同步 frac。
// 特效右缘 = 头部:落在头部右侧的留痕直接丢弃,绘制也裁到头部,往回拖不外溢。

const COLS = 40, ROWS = 6, SIZE = 2, PITCH = 3.5;
const GRID_W = (COLS - 1) * PITCH + SIZE;  // 138.5,与 v0.15.24 的 grid 宽度一致
const GRID_H = (ROWS - 1) * PITCH + SIZE;  // 19.5
const MAX_PARTICLES = 1500;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function hash01(n) {
  let x = (n | 0) * 0x9e3779b1;
  x ^= x >>> 15; x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

// 彗尾方阵每格的参数(与 v0.15.24 相同的分布);a=0 的格子不画
function cometCells(seed) {
  const cells = [];
  for (let n = 0; n < COLS * ROWS; n++) {
    const col = n % COLS, row = Math.floor(n / COLS);
    const r = (k) => hash01(n * 7 + k + seed * 7919);
    const spread = Math.abs(row - (ROWS - 1) / 2) / ((ROWS - 1) / 2); // 0 中心 … 1 边缘
    const reach = 1 - spread * 0.5 + (r(1) - 0.5) * 0.3;
    const t = (COLS - 1 - col) / (COLS - 1);                           // 0 头部 … 1 尾端
    const base = t > reach ? 0 : Math.pow(1 - t / reach, 1.5) * (1 - spread * 0.3);
    const a = r(2) < t * 0.55 ? 0 : Math.min(1, base * (0.35 + r(3) * 1.2));
    if (a <= 0) continue;
    const dur = 0.7 + r(4) * 1.2;
    cells.push({ col, row, a, dur, phase: r(5), dx: -3 - r(6) * 9, dy: (r(7) - 0.5) * 2.5 });
  }
  return cells;
}

export function createParticleField(canvas, opts = {}) {
  const headOffset = opts.headOffset ?? 2; // 方阵右缘相对头部左移(v0.15.24 为 right:2px)
  const cells = cometCells(opts.seed || 0);
  const ctx = canvas.getContext('2d');
  const ps = [];
  let frac = 0, prevHead = null, emitting = false, raf = 0, last = 0, clock = 0;
  let w = 0, h = 0, dpr = 1;

  function resize() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const d = window.devicePixelRatio || 1;
    if (cw !== w || ch !== h || d !== dpr) {
      w = cw; h = ch; dpr = d;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      prevHead = null;
    }
    return w > 0 && h > 0;
  }

  const top = () => (h - GRID_H) / 2;
  const snap = (v) => Math.round(v * dpr) / dpr;

  // 在世界方格第 k 列的 6 行上落下留痕方块;亮度取 v0.15.24 头部附近的分布,外侧行稍淡
  function deposit(k) {
    for (let row = 0; row < ROWS; row++) {
      if (Math.random() < 0.2) continue;
      const spread = Math.abs(row - (ROWS - 1) / 2) / ((ROWS - 1) / 2);
      const base = Math.pow(1 - Math.random() * 0.4, 1.5) * (1 - spread * 0.3);
      if (ps.length >= MAX_PARTICLES) ps.shift();
      ps.push({ x: k * PITCH, row, a: Math.min(1, base * (0.35 + Math.random() * 1.2)),
        life: 0.7 + Math.random() * 1.2, dx: -3 - Math.random() * 9, dy: (Math.random() - 0.5) * 2.5, age: 0 });
    }
  }

  // time 为 null 时按各格相位画静态帧
  function drawComet(head, time) {
    const left = head - headOffset - GRID_W, y0 = top();
    for (const c of cells) {
      const x = left + c.col * PITCH;
      if (x + SIZE < 0) continue;
      const p = time == null ? c.phase : (time / c.dur + c.phase) % 1;
      ctx.globalAlpha = c.a * (1 - p);
      ctx.fillRect(snap(x + c.dx * p), snap(y0 + c.row * PITCH + c.dy * p), SIZE, SIZE);
    }
  }

  function step(now) {
    raf = 0;
    if (!resize()) { ps.length = 0; return; } // 宿主隐藏:丢弃粒子并停帧,下次 update() 再唤醒
    const dt = last ? Math.min((now - last) / 1000, 0.25) : 0.016; // 按真实时间衰减,掉帧时寿命也不被拉长
    last = now; clock += dt;
    const head = frac * w;
    if (emitting) {
      if (prevHead != null && Math.abs(head - prevHead) > 0.5) {
        // 扫过的每一列方格都落下方块,留在原地慢慢消散
        const lo = Math.min(head, prevHead), hi = Math.max(head, prevHead);
        for (let k = Math.ceil(lo / PITCH); k * PITCH + SIZE <= hi; k++) deposit(k);
      }
      prevHead = head;
    } else prevHead = null;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, head, h); ctx.clip();
    ctx.fillStyle = '#fff';
    const y0 = top();
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.age >= p.life || p.x > head) { ps.splice(i, 1); continue; }
      const k = p.age / p.life;
      ctx.globalAlpha = p.a * (1 - k);
      ctx.fillRect(snap(p.x + p.dx * k), snap(y0 + p.row * PITCH + p.dy * k), SIZE, SIZE);
    }
    if (emitting) drawComet(head, clock);
    ctx.restore();
    ctx.globalAlpha = 1;
    if (emitting || ps.length) raf = requestAnimationFrame(step);
    else last = 0;
  }

  // 减少动态效果:不做动画,只画一帧静态彗尾
  function drawStatic() {
    if (!resize()) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!emitting) return;
    const head = frac * w;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, head, h); ctx.clip();
    ctx.fillStyle = '#fff';
    drawComet(head, null);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  return {
    update(nextFrac, on) {
      frac = Math.min(Math.max(Number(nextFrac) || 0, 0), 1);
      emitting = !!on;
      if (reducedMotion()) {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        ps.length = 0; last = 0; drawStatic(); return;
      }
      if (!raf && (emitting || ps.length)) { last = 0; raf = requestAnimationFrame(step); }
    },
    // count/minX/maxX 只统计拖动留痕;cells 为彗尾方阵格数;rows/maxDrift/onGrid 供探针核对平铺与小幅漂移
    stats() {
      return { count: ps.length, cells: cells.length, running: !!raf, emitting, frac, width: w, height: h,
        minX: ps.reduce((m, p) => Math.min(m, p.x), Infinity), maxX: ps.reduce((m, p) => Math.max(m, p.x), -Infinity),
        rows: [...new Set(ps.map((p) => p.row))].sort(), gridTop: top(), gridH: GRID_H,
        maxDrift: Math.max(ps.reduce((m, p) => Math.max(m, Math.hypot(p.dx, p.dy)), 0),
          cells.reduce((m, c) => Math.max(m, Math.hypot(c.dx, c.dy)), 0)),
        onGrid: ps.every((p) => Math.abs(p.x / PITCH - Math.round(p.x / PITCH)) < 1e-6) };
    },
  };
}
