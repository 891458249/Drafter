// effort.js(v0.15.20):推理深度档位表、中文名映射、滑块索引换算与按模型归一化。
// 关键前提:SDK 的 EffortLevel 只有 low/medium/high/xhigh/max(sdk.d.ts:539),
// 没有 ultra;UI 五档必须落回这五个值,否则下发无效。
const { test } = require('node:test');
const assert = require('node:assert');

let M;
test('setup', async () => {
  M = await import('../src/renderer/effort.js?v=' + Date.now());
});

test('EFFORT_LEVELS:必须是 SDK 认的五个值,且不含 ultra', () => {
  assert.deepEqual(M.EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(!M.EFFORT_LEVELS.includes('ultra'), 'ultra 不是合法 EffortLevel,不能出现在档位表里');
  assert.strictEqual(M.indexToLevel(M.EFFORT_FALLBACK_INDEX), 'high', 'SDK 官方默认档是 high');
});

test('effortIndex:档位 → 0..4,默认/未知 → -1', () => {
  assert.strictEqual(M.effortIndex('low'), 0);
  assert.strictEqual(M.effortIndex('medium'), 1);
  assert.strictEqual(M.effortIndex('high'), 2);
  assert.strictEqual(M.effortIndex('xhigh'), 3);
  assert.strictEqual(M.effortIndex('max'), 4);
  assert.strictEqual(M.effortIndex(null), -1, 'null = 跟随默认');
  assert.strictEqual(M.effortIndex(undefined), -1);
  assert.strictEqual(M.effortIndex(''), -1);
  assert.strictEqual(M.effortIndex('ultra'), -1, '未知档位按默认处理,不能当成第 5 档');
});

test('indexToLevel:0..4 → 档位,越界/非整数 → null', () => {
  assert.strictEqual(M.indexToLevel(0), 'low');
  assert.strictEqual(M.indexToLevel(4), 'max');
  assert.strictEqual(M.indexToLevel(-1), null);
  assert.strictEqual(M.indexToLevel(5), null);
  assert.strictEqual(M.indexToLevel(2.5), null);
  assert.strictEqual(M.indexToLevel(NaN), null);
});

test('effortLabel:中文名,默认/未知 → 「默认」', () => {
  assert.strictEqual(M.effortLabel('low'), '轻度');
  assert.strictEqual(M.effortLabel('medium'), '适中');
  assert.strictEqual(M.effortLabel('high'), '深度');
  assert.strictEqual(M.effortLabel('xhigh'), '更深');
  assert.strictEqual(M.effortLabel('max'), '极限');
  assert.strictEqual(M.effortLabel(null), M.EFFORT_DEFAULT_LABEL);
  assert.strictEqual(M.effortLabel('ultra'), M.EFFORT_DEFAULT_LABEL);
});

test('effortPercent:等距 0/25/50/75/100,默认与越界收敛', () => {
  assert.strictEqual(M.effortPercent(0), 0);
  assert.strictEqual(M.effortPercent(1), 25);
  assert.strictEqual(M.effortPercent(2), 50);
  assert.strictEqual(M.effortPercent(3), 75);
  assert.strictEqual(M.effortPercent(4), 100);
  assert.strictEqual(M.effortPercent(-1), 0, '「默认」不点亮任何填充');
  assert.strictEqual(M.effortPercent(9), 100);
  assert.strictEqual(M.effortPercent(NaN), 0);
});

test('normalizeEffort:无能力数据时原样下发,由 SDK 自行降级', () => {
  assert.strictEqual(M.normalizeEffort('max', undefined), 'max');
  assert.strictEqual(M.normalizeEffort('max', null), 'max');
  assert.strictEqual(M.normalizeEffort('xhigh', []), 'xhigh');
});

test('normalizeEffort:受支持则原样返回', () => {
  const all = ['low', 'medium', 'high', 'xhigh', 'max'];
  for (const lv of all) assert.strictEqual(M.normalizeEffort(lv, all), lv);
});

test('normalizeEffort:不支持时先向下找最近档', () => {
  // 只支持 low/high:medium → low,i>2 的档 → high
  assert.strictEqual(M.normalizeEffort('medium', ['low', 'high']), 'low');
  assert.strictEqual(M.normalizeEffort('xhigh', ['low', 'high']), 'high');
  assert.strictEqual(M.normalizeEffort('max', ['low', 'high']), 'high');
  // 典型的「xhigh 不被支持 → 退回 high」
  assert.strictEqual(M.normalizeEffort('xhigh', ['low', 'medium', 'high']), 'high');
  // max 不被支持 → 退回 xhigh(若支持)
  assert.strictEqual(M.normalizeEffort('max', ['low', 'medium', 'high', 'xhigh']), 'xhigh');
});

test('normalizeEffort:下方无受支持档时向上找', () => {
  assert.strictEqual(M.normalizeEffort('low', ['high', 'max']), 'high');
  assert.strictEqual(M.normalizeEffort('medium', ['max']), 'max');
});

test('normalizeEffort:非法档位与完全不匹配都返回 null', () => {
  assert.strictEqual(M.normalizeEffort(null, ['low']), null, '「默认」不是档位,不走归一化');
  assert.strictEqual(M.normalizeEffort('ultra', ['low', 'max']), null);
  assert.strictEqual(M.normalizeEffort('max', ['turbo', 'nonsense']), null, '能力表里全是不认识的值');
});

test('effortDowngradeNote:仅在真的降级时给提示', () => {
  assert.strictEqual(M.effortDowngradeNote('max', 'xhigh'), '该模型不支持「极限」,将按「更深」执行');
  assert.strictEqual(M.effortDowngradeNote('max', 'max'), null, '未降级不提示');
  assert.strictEqual(M.effortDowngradeNote(null, 'high'), null, '「默认」不做提示');
  assert.strictEqual(M.effortDowngradeNote('max', null), null);
});

// ---- 模型能力表(v0.15.20)----
// 数据形状取自实测:Query.supportedModels() 在 claude.exe 0.3.218 上返回 5 条,
// 4 条带完整五档,haiku 一条两字段都没有。下面第一组用例就是这份真实返回的缩影。

const REAL_MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Default (recommended)',
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-4-8[1M]', displayName: 'claude-opus-4-8',
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-fable-5[1M]', resolvedModel: 'claude-fable-5[1m]', displayName: 'claude-fable-5',
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5[1M]', displayName: 'claude-sonnet-5',
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'claude-haiku-4-5-20251001' },
];

test('buildEffortCapabilityTable:真实返回里 4 条拿到完整五档', () => {
  const t = M.buildEffortCapabilityTable(REAL_MODELS);
  for (const name of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5']) {
    assert.deepEqual(M.lookupEffortLevels(t, name), ['low', 'medium', 'high', 'xhigh', 'max'], name);
  }
  // 别名 value 也收(用户可能直接把 'sonnet' 当模型名)
  assert.deepEqual(M.lookupEffortLevels(t, 'sonnet'), ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('buildEffortCapabilityTable:haiku 无 effort 字段 ⇒ 命中空数组(已知不支持)', () => {
  const t = M.buildEffortCapabilityTable(REAL_MODELS);
  assert.deepEqual(M.lookupEffortLevels(t, 'claude-haiku-4-5-20251001'), []);
  assert.strictEqual(M.modelRejectsEffort(t, 'claude-haiku-4-5-20251001'), true);
  assert.strictEqual(M.modelRejectsEffort(t, 'claude-sonnet-5'), false, '支持 effort 的模型不算被拒');
});

test('lookupEffortLevels:模型名归一化(小写、去尾部 [1M]/[1m])', () => {
  const t = M.buildEffortCapabilityTable(REAL_MODELS);
  assert.deepEqual(M.lookupEffortLevels(t, 'claude-sonnet-5[1M]'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(M.lookupEffortLevels(t, 'CLAUDE-Sonnet-5'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(M.lookupEffortLevels(t, '  claude-sonnet-5  '), ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('lookupEffortLevels:表里没有 ⇒ null(未知,原样下发,绝不猜)', () => {
  const t = M.buildEffortCapabilityTable(REAL_MODELS);
  // 项目日常在用的网关模型全都不在 claude.exe 这张内置表里
  for (const name of ['kimi-k3', 'GPT-6 Astra', 'gpt-6-astra', 'deepseek-v4']) {
    assert.strictEqual(M.lookupEffortLevels(t, name), null, name);
    assert.strictEqual(M.modelRejectsEffort(t, name), false, name + ' 不能因查不到就当成不支持');
  }
});

test('lookupEffortLevels:null 与 [] 含义不同,不能混为一谈', () => {
  const t = M.buildEffortCapabilityTable(REAL_MODELS);
  assert.strictEqual(M.lookupEffortLevels(null, 'claude-sonnet-5'), null, '没表 = 未知');
  assert.strictEqual(M.lookupEffortLevels(t, null), null, '没模型名 = 未知');
  assert.strictEqual(M.lookupEffortLevels(t, ''), null);
  assert.notDeepEqual(M.lookupEffortLevels(t, 'claude-haiku-4-5-20251001'), null, '已知不支持 ≠ 未知');
});

test('buildEffortCapabilityTable:只认 SDK 五档,别的值滤掉', () => {
  const t = M.buildEffortCapabilityTable([
    { value: 'x', supportsEffort: true, supportedEffortLevels: ['low', 'ultra', 'turbo', 'max'] },
  ]);
  assert.deepEqual(M.lookupEffortLevels(t, 'x'), ['low', 'max'], 'ultra/turbo 不是合法 EffortLevel');
});

test('buildEffortCapabilityTable:支持但没给档位 ⇒ 不收录(不设限,按未知处理)', () => {
  const t = M.buildEffortCapabilityTable([{ value: 'y', supportsEffort: true }]);
  assert.strictEqual(M.lookupEffortLevels(t, 'y'), null);
});

test('buildEffortCapabilityTable:supportsEffort 明确为 false ⇒ 已知不支持', () => {
  const t = M.buildEffortCapabilityTable([{ value: 'z', supportsEffort: false }]);
  assert.deepEqual(M.lookupEffortLevels(t, 'z'), []);
});

test('buildEffortCapabilityTable:脏输入不炸', () => {
  assert.deepEqual(M.buildEffortCapabilityTable(null), {});
  assert.deepEqual(M.buildEffortCapabilityTable('nope'), {});
  assert.deepEqual(M.buildEffortCapabilityTable([null, 42, {}, { value: '' }]), {},
    '无效条目与空名一律跳过');
});

