// 推理深度彗尾粒子场(v0.15.25):取代 v0.15.22–24 的「整块贴图跟随手柄」。
//
// 粒子一经发射就停在「世界坐标」(宿主元素内的像素位置)里自行漂移、衰减,不再随手柄平移:
//   · 静止时:在头部(手柄处)持续少量发射,粒子向左缓漂淡出 → 自然的彗尾;
//   · 拖动时:沿手柄上一帧到这一帧扫过的整段路径按距离补发粒子 → 经过处留下方块逐渐消散。
// 同一套实现同时用于面板滑轨与入口按键背景,两者由 effort-ui.js 的 render() 每次同步 frac。
// 裁剪交给宿主(overflow:hidden + 圆角),这里只在 canvas 上画 2px 白色方块。

const MAX_PARTICLES = 700;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createParticleField(canvas, opts = {}) {
  const idleRate = opts.idleRate || 70;   // 静止时头部每秒发射数
  const trailDensity = opts.density || 1.1; // 拖动时每像素补发数
  const headOffset = opts.headOffset || 0;  // 头部发射点相对手柄中心左移(滑块手柄会遮住中心)
  const ctx = canvas.getContext('2d');
  const ps = [];
  let frac = 0, prevHead = null, emitting = false, raf = 0, last = 0, carry = 0;
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

  // 纵向分布偏向中线,越靠头部越集中,营造锥形彗核
  function spawn(x, fresh) {
    if (ps.length >= MAX_PARTICLES) ps.shift();
    const band = (Math.random() + Math.random() + Math.random()) / 3 - 0.5; // 近似正态
    const life = (fresh ? 0.6 : 0.7) + Math.random() * (fresh ? 1.0 : 1.1);
    ps.push({
      x: x - Math.random() * 3,
      y: h / 2 + band * h * 0.9,
      vx: fresh ? -(14 + Math.random() * 40) : -(4 + Math.random() * 18),
      vy: (Math.random() - 0.5) * 6,
      s: Math.random() < 0.25 ? 1.5 : 2,
      a: 0.35 + Math.random() * 0.65,
      age: 0, life,
    });
  }

  function step(now) {
    raf = 0;
    if (!resize()) { ps.length = 0; return; } // 宿主隐藏:丢弃粒子并停帧,下次 update() 再唤醒
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
    last = now;
    const head = frac * w;
    if (emitting) {
      if (prevHead != null && Math.abs(head - prevHead) > 0.5) {
        // 扫过的路径上按距离补发,留在原地慢慢消散
        const dist = Math.abs(head - prevHead);
        const n = Math.min(160, Math.round(dist * trailDensity));
        for (let i = 0; i < n; i++) spawn(prevHead + (head - prevHead) * Math.random(), false);
      }
      carry += idleRate * dt;
      while (carry >= 1) { spawn(Math.max(0, head - headOffset), true); carry -= 1; }
      prevHead = head;
    } else prevHead = null;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // 特效右缘 = 头部:往回拖时落在头部右侧的粒子直接丢弃,绘制也裁到头部,不外溢
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, head, h); ctx.clip();
    ctx.fillStyle = '#fff';
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.age >= p.life || p.x > head) { ps.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.985;
      const k = 1 - p.age / p.life;
      ctx.globalAlpha = p.a * k * k;
      ctx.fillRect(Math.round(p.x * dpr) / dpr, Math.round(p.y * dpr) / dpr, p.s, p.s);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    if (emitting || ps.length) raf = requestAnimationFrame(step);
    else last = 0;
  }

  // 减少动态效果:不做动画,只画一帧静态的头部方块簇
  function drawStatic() {
    if (!resize()) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!emitting) return;
    ctx.fillStyle = '#fff';
    const head = frac * w;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, head, h); ctx.clip();
    for (let i = 0; i < 60; i++) {
      const t = ((i * 0.6180339887) % 1);
      const x = head - 4 - t * 60, y = h / 2 + (((i * 0.7548776662) % 1) - 0.5) * h * 0.8 * (0.4 + 0.6 * t);
      ctx.globalAlpha = 0.8 * (1 - t) * (1 - t);
      ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
    }
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
    stats() {
      return { count: ps.length, running: !!raf, emitting, frac, width: w,
        minX: ps.reduce((m, p) => Math.min(m, p.x), Infinity), maxX: ps.reduce((m, p) => Math.max(m, p.x), -Infinity) };
    },
  };
}
