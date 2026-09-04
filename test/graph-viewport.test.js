// graph/viewport.js + geom.js 测试:双向投影、指针锚定无漂移缩放、视口剔除 AABB、LOD、贝塞尔
const { test } = require('node:test');
const assert = require('node:assert');

let vp, geom;
test.beforeEach(async () => {
  vp = await import('../src/renderer/graph/viewport.js?v=' + Date.now());
  geom = await import('../src/renderer/graph/geom.js?v=' + Date.now());
});

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('双向投影互逆:toScreen ∘ toWorld = 恒等', () => {
  const v = vp.createViewport({ tx: 123.5, ty: -67.25, scale: 1.75 });
  const p = { x: 400, y: -250 };
  const s = vp.toScreen(v, p);
  const back = vp.toWorld(v, s);
  assert.ok(close(back.x, p.x) && close(back.y, p.y));
});

test('指针锚定缩放:光标下的世界点缩放前后映射到同一屏幕像素', () => {
  const v = vp.createViewport({ tx: 50, ty: 80, scale: 1 });
  const cursor = { x: 640, y: 360 };
  const anchorWorld = vp.toWorld(v, cursor);
  vp.zoomAt(v, cursor.x, cursor.y, 1.2);
  const after = vp.toScreen(v, anchorWorld);
  assert.ok(close(after.x, cursor.x, 1e-9) && close(after.y, cursor.y, 1e-9), '锚点零漂移');
  // 连续缩放多次仍不漂移
  for (let i = 0; i < 20; i++) vp.zoomAt(v, cursor.x, cursor.y, 0.9);
  const after2 = vp.toScreen(v, anchorWorld);
  assert.ok(close(after2.x, cursor.x, 1e-6) && close(after2.y, cursor.y, 1e-6));
});

test('缩放上下限钳制', () => {
  const v = vp.createViewport();
  for (let i = 0; i < 50; i++) vp.zoomAt(v, 100, 100, 2);
  assert.strictEqual(v.scale, v.maxScale);
  for (let i = 0; i < 100; i++) vp.zoomAt(v, 100, 100, 0.5);
  assert.strictEqual(v.scale, v.minScale);
});

test('viewAABB:视口世界包围盒随平移缩放正确逆解', () => {
  const v = vp.createViewport({ tx: 0, ty: 0, scale: 2 });
  const r = vp.viewAABB(v, 800, 600);
  assert.deepStrictEqual(r, { x: 0, y: 0, w: 400, h: 300 });
  v.tx = -200; v.ty = 100;
  const r2 = vp.viewAABB(v, 800, 600);
  assert.deepStrictEqual(r2, { x: 100, y: -50, w: 400, h: 300 });
});

test('LOD 三级:≥0.6 细节完整,0.25~0.6 性能模式,<0.25 微缩骨架(迭代规范阈值)', () => {
  const v = vp.createViewport();
  v.scale = 1; assert.strictEqual(vp.lod(v), 0);
  v.scale = 0.6; assert.strictEqual(vp.lod(v), 0);
  v.scale = 0.5; assert.strictEqual(vp.lod(v), 1);
  v.scale = 0.25; assert.strictEqual(vp.lod(v), 1);
  v.scale = 0.15; assert.strictEqual(vp.lod(v), 2);
});

test('贝塞尔:控制点水平外推,端点切向水平', () => {
  const c = geom.bezierControls({ x: 0, y: 0 }, { x: 200, y: 100 });
  assert.strictEqual(c[1].y, 0, '起点控制点与起点同高(水平切向)');
  assert.strictEqual(c[2].y, 100, '终点控制点与终点同高');
  assert.ok(c[1].x > 0 && c[2].x < 200);
  // 张力 = max(|dx|*0.5, 40)
  assert.strictEqual(c[1].x, 100);
  const c2 = geom.bezierControls({ x: 0, y: 0 }, { x: 30, y: 50 });
  assert.strictEqual(c2[1].x, 40, '水平位移小时用最小张力 40');
  // 端点采样: B(0)=P0, B(1)=P3
  assert.deepStrictEqual(geom.bezierAt(c, 0), c[0]);
  assert.deepStrictEqual(geom.bezierAt(c, 1), c[3]);
});

test('贝塞尔命中:曲线上点距离≈0,远处点距离大', () => {
  const c = geom.bezierControls({ x: 0, y: 0 }, { x: 200, y: 0 });
  const mid = geom.bezierAt(c, 0.5);
  assert.ok(geom.distToBezier(mid, c) < 2);
  assert.ok(geom.distToBezier({ x: 100, y: 200 }, c) > 100);
});

test('AABB 相交/包含与网格吸附', () => {
  assert.ok(geom.rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }));
  assert.ok(!geom.rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 5, h: 5 }));
  assert.ok(geom.rectContains({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5 }));
  assert.ok(!geom.rectContains({ x: 0, y: 0, w: 10, h: 10 }, { x: 15, y: 5 }));
  assert.strictEqual(geom.snapToGrid(13, 10), 10);
  assert.strictEqual(geom.snapToGrid(17, 10), 20);
  assert.strictEqual(geom.snapToGrid(13, 0), 13, 'step=0 关闭吸附');
});
