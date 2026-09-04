// 视口控制器(md「视口控制与无限画布空间投影算法」):
// 世界坐标(无限平面)与屏幕坐标(物理像素)的双向仿射投影。
// 约定:screen = world * scale + offset,即齐次矩阵 [s 0 tx; 0 s ty; 0 0 1]。
// 纯逻辑无 DOM 依赖;DPI 由渲染层在根变换后级联(此模块一律用 CSS 逻辑像素)。

export function createViewport(overrides = {}) {
  return {
    tx: 0,          // 世界原点的屏幕平移量(CSS px)
    ty: 0,
    scale: 1,       // 等比缩放因子
    minScale: 0.1,
    maxScale: 2,
    ...overrides,
  };
}

// 正向投影:世界 → 屏幕
export function toScreen(vp, p) {
  return { x: p.x * vp.scale + vp.tx, y: p.y * vp.scale + vp.ty };
}

// 逆向投影:屏幕 → 世界
export function toWorld(vp, p) {
  return { x: (p.x - vp.tx) / vp.scale, y: (p.y - vp.ty) / vp.scale };
}

// 指针锚定无漂移缩放(md 推导):缩放前后,光标下的世界点 W 固定在屏幕点 P 上。
// W = (P - T) / S0 ⇒ T1 = P - W * S1
export function zoomAt(vp, sx, sy, factor) {
  const s1 = clamp(vp.scale * factor, vp.minScale, vp.maxScale);
  if (s1 === vp.scale) return vp;
  const w = toWorld(vp, { x: sx, y: sy });
  vp.scale = s1;
  vp.tx = sx - w.x * s1;
  vp.ty = sy - w.y * s1;
  return vp;
}

export function panBy(vp, dx, dy) {
  vp.tx += dx;
  vp.ty += dy;
  return vp;
}

// 当前视口在世界空间的 AABB(md「视口剔除」):cssW/cssH 为画布 CSS 逻辑尺寸
export function viewAABB(vp, cssW, cssH) {
  const tl = toWorld(vp, { x: 0, y: 0 });
  return { x: tl.x, y: tl.y, w: cssW / vp.scale, h: cssH / vp.scale };
}

// LOD 三级决策(md「视口分级渲染策略」+ 迭代规范 LOD 阈值表):
// 0=细节完整(S≥0.6);1=性能模式(0.25≤S<0.6:关阴影/藏次级把手,骨架全保留);
// 2=微缩骨架(S<0.25:跳 fillText 降级 Greeking 细线,底板/标题界/插槽点/凹槽强制绘制)
export function lod(vp) {
  if (vp.scale >= 0.6) return 0;
  if (vp.scale >= 0.25) return 1;
  return 2;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
