// 画布几何纯函数(md「数学完备」支柱):AABB、水平切向三次贝塞尔、点到线段距离。
// 无 DOM/Canvas 依赖,node --test 可直接 import 单测。

export function rectContains(r, p) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function rectsIntersect(a, b) {
  return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
}

// md「三次贝塞尔曲线生成算法」:起点 P0、终点 P3,控制点按水平位移差取张力,
// 两个控制点均沿水平方向外推,保证端口处切向水平(ComfyUI 标志性平滑连线)。
// T = max(|dx| * 0.5, 40);C1 = P0 + (T, 0);C2 = P3 - (T, 0)
export function bezierControls(p0, p3, minTension = 40) {
  const t = Math.max(Math.abs(p3.x - p0.x) * 0.5, minTension);
  return [
    p0,
    { x: p0.x + t, y: p0.y },
    { x: p3.x - t, y: p3.y },
    p3,
  ];
}

// B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
export function bezierAt(c, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return {
    x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x,
    y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y,
  };
}

// 等步长采样成折线段集合(拾取判定用,md「贝塞尔连线拾取判定」)
export function bezierSamples(c, steps = 24) {
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push(bezierAt(c, i / steps));
  return pts;
}

export function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  const x = a.x + t * dx, y = a.y + t * dy;
  return Math.hypot(p.x - x, p.y - y);
}

// 点到贝塞尔曲线的最短距离(折线近似;命中阈值配合线宽,如 8px)
export function distToBezier(p, controls, steps = 24) {
  const pts = bezierSamples(controls, steps);
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i++) min = Math.min(min, distToSegment(p, pts[i], pts[i + 1]));
  return min;
}

// 网格量化:吸附到最近的网格步长倍数(md「网格吸附」)
export function snapToGrid(v, step) {
  return step > 0 ? Math.round(v / step) * step : v;
}
