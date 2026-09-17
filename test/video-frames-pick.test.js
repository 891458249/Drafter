// video-frames.js 纯函数单测:时长分档 framesForDuration、场景判定 isSceneCut、
// 选点 pickFrameTimes。模块顶层不 require electron(仅在 extractVideoFrames 函数体内),可安全直接 require。
const { test } = require('node:test');
const assert = require('node:assert');

const vf = require('../src/main/video-frames');

// --- framesForDuration:时长分档 ---------------------------------------------
test('framesForDuration:<30s→4, 30~180s→6, 180~600s→8, ≥600s→10', () => {
  assert.strictEqual(vf.framesForDuration(5), 4);
  assert.strictEqual(vf.framesForDuration(25), 4);
  assert.strictEqual(vf.framesForDuration(30), 6);
  assert.strictEqual(vf.framesForDuration(120), 6);
  assert.strictEqual(vf.framesForDuration(179.9), 6);
  assert.strictEqual(vf.framesForDuration(180), 8);
  assert.strictEqual(vf.framesForDuration(400), 8);
  assert.strictEqual(vf.framesForDuration(600), 10);
  assert.strictEqual(vf.framesForDuration(700), 10);
});

test('framesForDuration:非法输入回退 4', () => {
  assert.strictEqual(vf.framesForDuration(0), 4);
  assert.strictEqual(vf.framesForDuration(-3), 4);
  assert.strictEqual(vf.framesForDuration(NaN), 4);
  assert.strictEqual(vf.framesForDuration(undefined), 4);
});

// --- isSceneCut --------------------------------------------------------------
// 构造 2x2 RGBA 像素数组(4 像素)便于手算
const px = (r, g, b) => new Uint8ClampedArray([r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255]);

test('isSceneCut:相同帧不切(diff≈0)', () => {
  const r = vf.isSceneCut(px(120, 80, 40), px(120, 80, 40));
  assert.strictEqual(r.cut, false);
  assert.ok(r.diff < 0.01);
});

test('isSceneCut:小幅渐变(亮度+10)不计切换', () => {
  const r = vf.isSceneCut(px(100, 100, 100), px(110, 110, 110));
  assert.strictEqual(r.cut, false);
  assert.ok(r.diff > 5 && r.diff < 20, '渐变 diff 应在 8~20 区间,实际 ' + r.diff);
});

test('isSceneCut:硬切(颜色完全不同)计入切换', () => {
  const r = vf.isSceneCut(px(10, 10, 200), px(240, 200, 10));
  assert.strictEqual(r.cut, true);
  assert.ok(r.diff > 35, '硬切 diff 应 >35,实际 ' + r.diff);
});

test('isSceneCut:全黑帧不计切换(黑场是剪辑点不是新场景)', () => {
  const black = px(2, 2, 2);
  const r = vf.isSceneCut(px(200, 180, 160), black);
  assert.strictEqual(r.cut, false);
  assert.ok(r.luma < 8);
  // 黑帧之后的正常帧恢复判定
  const r2 = vf.isSceneCut(black, px(200, 180, 160));
  assert.strictEqual(r2.cut, true);
});

test('isSceneCut:空/长度不一的输入安全返回不切', () => {
  assert.strictEqual(vf.isSceneCut(null, px(1, 2, 3)).cut, false);
  assert.strictEqual(vf.isSceneCut(px(1, 2, 3), new Uint8ClampedArray(8)).cut, false);
});

// --- pickFrameTimes ----------------------------------------------------------
// v0.15.15:禁用均匀抽帧——无场景信息时由帧差样本(samples:[{t,diff,luma}])选点,
// 仅在完全无帧差数据时才用最大空隙二分兜底(dyadic 点,不再是 (i+0.5)/n 均匀公式)。
const asc = (arr) => arr.every((v, i) => i === 0 || v >= arr[i - 1]);

test('pickFrameTimes:无场景边界+帧差样本 → 按帧差贪心取点(禁用均匀)', () => {
  const d = 60, n = 4;
  const samples = [
    { t: 10, diff: 5, luma: 120 }, { t: 20, diff: 40, luma: 120 },
    { t: 30, diff: 10, luma: 120 }, { t: 40, diff: 50, luma: 120 },
    { t: 50, diff: 8, luma: 120 },
  ];
  const ts = vf.pickFrameTimes(d, [], n, samples);
  // 按 diff 降序 40,20,30,50 均可选(minSep=60/12=5,彼此间距 ≥10)
  assert.deepStrictEqual(ts, [20, 30, 40, 50]);
  // 明确不等于旧均匀公式 (i+0.5)/n = [7.5,22.5,37.5,52.5]
  assert.notDeepStrictEqual(ts, [7.5, 22.5, 37.5, 52.5]);
});

test('pickFrameTimes:帧差取点跳过黑帧样本(luma<8)', () => {
  const d = 60, n = 2;
  const samples = [
    { t: 10, diff: 99, luma: 2 },  // 黑帧,diff 再高也不选
    { t: 30, diff: 20, luma: 120 },
  ];
  const ts = vf.pickFrameTimes(d, [], n, samples);
  assert.ok(ts.includes(30), '选中唯一非黑样本: ' + ts.join(','));
  assert.ok(!ts.includes(10), '黑帧样本被排除: ' + ts.join(','));
});

test('pickFrameTimes:无场景边界+无帧差数据 → 二分兜底(非均匀公式)', () => {
  const ts = vf.pickFrameTimes(60, [], 6);
  // 最大空隙二分:30 → 15 → 45 → 7.5 → 22.5 → 37.5
  assert.deepStrictEqual(ts, [7.5, 15, 22.5, 30, 37.5, 45]);
});

test('pickFrameTimes:边界少于帧数+帧差样本 → 优先帧差补齐而非二分', () => {
  const d = 100, n = 6;
  const bounds = [30, 70]; // 场景中点 15, 50, 85
  const samples = [
    { t: 5, diff: 50, luma: 120 },   // 距 15 为 10 ≥ minSep(100/18≈5.56)→ 可选
    { t: 63, diff: 40, luma: 120 },  // 距 50/85 均 ≥13 → 可选
    { t: 95, diff: 60, luma: 120 },  // 距 85 为 10 → 可选
  ];
  const ts = vf.pickFrameTimes(d, bounds, n, samples);
  assert.deepStrictEqual(ts, [5, 15, 50, 63, 85, 95]);
});

test('pickFrameTimes:帧差补齐遵守最小间隔,不挤在一次动作爆发上', () => {
  const d = 100, n = 4;
  const samples = [
    { t: 50, diff: 60, luma: 120 }, { t: 51, diff: 59, luma: 120 },
    { t: 52, diff: 58, luma: 120 }, { t: 90, diff: 10, luma: 120 },
  ];
  const ts = vf.pickFrameTimes(d, [], n, samples);
  // minSep=100/12≈8.33:50 选中后 51/52 被拒,90 入选,剩余名额二分补齐
  assert.ok(ts.includes(50) && ts.includes(90), '帧差点分散: ' + ts.join(','));
  assert.ok(!ts.includes(51) && !ts.includes(52), '过近样本被拒: ' + ts.join(','));
  assert.strictEqual(ts.length, n);
  assert.ok(asc(ts));
});

test('pickFrameTimes:边界多于帧数 → 恰好 n 个、升序、落在 [0,d]', () => {
  const d = 300, n = 6;
  // 20 个边界 → 21 个场景,候选 21 个中点
  const bounds = Array.from({ length: 20 }, (_, i) => (d * (i + 1)) / 21);
  const ts = vf.pickFrameTimes(d, bounds, n);
  assert.strictEqual(ts.length, n);
  assert.ok(asc(ts));
  assert.ok(ts[0] >= 0 && ts[n - 1] <= d);
  // 分层应覆盖首末段
  assert.ok(ts[0] < d / n, '首点落在首段内');
  assert.ok(ts[n - 1] > d - d / n, '末点落在末段内');
});

test('pickFrameTimes:分层取时段内无场景点 → 用段内帧差最高点兜底(非段中心)', () => {
  const d = 100, n = 4;
  // 7 个密集边界 → 8 个候选中点(0.5 首帧保护后 7 个),3 个名额分 3 段,
  // 末段 [66.7,100] 无场景点
  const bounds = [1, 2, 3, 4, 5, 6, 7];
  const samples = [{ t: 70, diff: 9, luma: 120 }, { t: 90, diff: 30, luma: 120 }];
  const ts = vf.pickFrameTimes(d, bounds, n, samples);
  assert.strictEqual(ts.length, n);
  assert.ok(Math.abs(ts[0] - 0.5) < 0.06, '首帧保护: ' + ts.join(','));
  assert.ok(ts.includes(90), '末段取帧差最高点 90 而非段中心 83.3: ' + ts.join(','));
  assert.ok(!ts.some((t) => Math.abs(t - 83.33) < 0.5), '不再是段中心兜底: ' + ts.join(','));
});

test('pickFrameTimes:边界少 → 场景点全保留 + 空隙二分补齐到 n', () => {
  const d = 100, n = 6;
  const bounds = [30, 70]; // 3 个场景 → 候选中点 15, 50, 85
  const ts = vf.pickFrameTimes(d, bounds, n);
  assert.strictEqual(ts.length, n);
  assert.ok(asc(ts));
  // 三个场景中点必须全保留(距 0 ≥1s,无首帧保护占用名额)
  for (const mid of [15, 50, 85]) {
    assert.ok(ts.some((t) => Math.abs(t - mid) < 0.06), '保留场景中点 ' + mid + ': ' + ts.join(','));
  }
});

test('pickFrameTimes:首场景点距 0 <1s 固定保留(封面/标题帧)', () => {
  const d = 100, n = 4;
  // 边界 1.6 与 60:首场景 [0,1.6] 中点 0.8 <1s → 固定保留
  const ts = vf.pickFrameTimes(d, [1.6, 60], n);
  assert.strictEqual(ts.length, n);
  assert.ok(Math.abs(ts[0] - 0.8) < 0.06, '首帧 0.8 固定保留: ' + ts.join(','));
  // 其余场景点 30.8、80 也在
  assert.ok(ts.some((t) => Math.abs(t - 30.8) < 0.06));
  assert.ok(ts.some((t) => Math.abs(t - 80) < 0.06));
});

test('pickFrameTimes:极短视频(<1s)至少 1 帧且不抛错', () => {
  const ts = vf.pickFrameTimes(0.6, [], 4);
  assert.ok(ts.length >= 1);
  assert.ok(ts[0] >= 0 && ts[0] < 0.6);
});

test('pickFrameTimes:非法时长回退 [0],不抛错', () => {
  assert.deepStrictEqual(vf.pickFrameTimes(0, [1, 2], 6), [0]);
  assert.deepStrictEqual(vf.pickFrameTimes(NaN, [], 6), [0]);
  assert.deepStrictEqual(vf.pickFrameTimes(-5, [], 6), [0]);
});

test('pickFrameTimes:非法边界被过滤(越界/乱序/NaN)', () => {
  const ts = vf.pickFrameTimes(100, [NaN, -3, 150, 50, 20], 4);
  assert.strictEqual(ts.length, 4);
  assert.ok(asc(ts));
  // 有效边界 20、50 → 场景中点 10、35、75 应保留
  for (const mid of [10, 35, 75]) assert.ok(ts.some((t) => Math.abs(t - mid) < 0.06), '中点 ' + mid);
});

test('pickFrameTimes:长空隙二分补齐倾向于均匀分布', () => {
  const d = 200, n = 8;
  const bounds = [10, 20]; // 头部 3 个密集场景,尾部一大段空隙
  const ts = vf.pickFrameTimes(d, bounds, n);
  assert.strictEqual(ts.length, n);
  assert.ok(asc(ts));
  // 尾部大空隙 [20,200] 应被补齐点覆盖
  assert.ok(ts.some((t) => t > 150), '尾部空隙有点: ' + ts.join(','));
});
