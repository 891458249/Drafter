// keys.js tests:迁移、保存/脱敏、切换默认、删除、模型识别(带 mock fetch)
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-keys-test-'));
installElectronStub(tmp);
const store = require('../src/main/store');
const keys = require('../src/main/keys');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('旧单 apiKey 自动迁移为多 key 列表并设为默认', () => {
  store.setSetting('apiKey', 'sk-ant-legacy1234');
  const list = keys.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'Kuro');
  assert.strictEqual(list[0].keyHint, '…1234');
  assert.strictEqual(list[0].key, undefined, '脱敏列表不得带完整 key');
  assert.strictEqual(store.getSetting('apiKey', null), null, '旧字段应被清除');
  assert.strictEqual(keys.activeKey().key, 'sk-ant-legacy1234');
});

test('save: 新增/编辑、类型自动猜测、首个 key 自动设为默认', () => {
  const r1 = keys.save({ name: '库洛', key: 'kuro-abcdef9999', baseUrl: 'https://gw.example.com' });
  assert.strictEqual(r1.ok, true);
  const kuro = keys.list().find((k) => k.name === '库洛');
  assert.strictEqual(kuro.kind, 'authToken', '非 sk-ant 前缀应猜为 authToken');
  assert.strictEqual(kuro.baseUrl, 'https://gw.example.com');
  const r2 = keys.save({ name: '官方', key: 'sk-ant-official777' });
  assert.strictEqual(r2.ok, true);
  const official = keys.list().find((k) => k.name === '官方');
  assert.strictEqual(official.kind, 'apiKey');
  assert.ok(!('key' in official), '列表项不得含完整 key');
  // 空 key 拒绝
  assert.strictEqual(keys.save({ name: 'x', key: '' }).ok, false);
});

test('setActive / remove:切换默认与删除后回退', () => {
  const all = keys.list();
  const official = all.find((k) => k.name === '官方');
  assert.strictEqual(keys.setActive(official.id).ok, true);
  assert.strictEqual(keys.activeKey().name, '官方');
  keys.remove(official.id);
  assert.strictEqual(keys.activeKey().name, 'Kuro', '删除默认后应回退到剩余第一个');
  assert.strictEqual(keys.setActive('k_nope').ok, false);
});

test('refreshModels: 按 key 拉取并缓存模型列表(mock fetch)', async () => {
  const kuro = keys.list().find((k) => k.name === '库洛');
  keys.setActive(kuro.id); // activeModels 读活跃 key,先切过去
  const origFetch = global.fetch;
  let seenUrl = '', seenAuth = '';
  global.fetch = async (url, opts) => {
    seenUrl = url; seenAuth = opts.headers.authorization;
    return { ok: true, json: async () => ({ data: [{ id: 'claude-fable-5' }, { id: 'claude-haiku-4-5' }] }) };
  };
  try {
    const r = await keys.refreshModels(kuro.id);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.models, ['claude-fable-5', 'claude-haiku-4-5']);
    assert.ok(seenUrl.startsWith('https://gw.example.com/v1/models'), '应打到 key 的 baseUrl');
    assert.strictEqual(seenAuth, 'Bearer kuro-abcdef9999', 'authToken 应走 Bearer 头');
    assert.deepStrictEqual(keys.activeModels(), r.models, '活跃 key 的模型应可读缓存');
  } finally {
    global.fetch = origFetch;
  }
});

test('额度字段保存 + 模型勾选白名单优先', () => {
  const kuro = keys.list().find((k) => k.name === '库洛');
  // 额度保存不影响 key 本体
  const r = keys.save({ id: kuro.id, quotaWeek: '50', quotaMonth: '200' });
  assert.strictEqual(r.ok, true);
  const after = keys.list().find((k) => k.id === kuro.id);
  assert.strictEqual(after.quotaWeek, 50);
  assert.strictEqual(after.quotaMonth, 200);
  assert.ok(after.keyHint.endsWith('9999'), 'key 本体不应被额度保存破坏');
  // 勾选白名单优先于全量缓存
  assert.deepStrictEqual(keys.activeModels(), ['claude-fable-5', 'claude-haiku-4-5']);
  keys.setModelsEnabled(kuro.id, ['claude-fable-5']);
  assert.deepStrictEqual(keys.activeModels(), ['claude-fable-5']);
  // 恢复全量
  keys.setModelsEnabled(kuro.id, null);
  assert.deepStrictEqual(keys.activeModels(), ['claude-fable-5', 'claude-haiku-4-5']);
});

test('usageUrl:保存/清空/非法协议拒绝,且不影响脱敏', () => {
  const kuro = keys.list().find((k) => k.name === '库洛');
  const r = keys.save({ id: kuro.id, usageUrl: 'https://gw.example.com/usage' });
  assert.strictEqual(r.ok, true);
  const after = keys.list().find((k) => k.id === kuro.id);
  assert.strictEqual(after.usageUrl, 'https://gw.example.com/usage');
  assert.ok(!('key' in after), '列表项仍不得含完整 key');
  assert.strictEqual(keys.save({ id: kuro.id, usageUrl: 'ftp://bad' }).ok, false, '非 http/https 应拒绝');
  assert.strictEqual(keys.save({ id: kuro.id, usageUrl: '' }).ok, true);
  assert.strictEqual(keys.list().find((k) => k.id === kuro.id).usageUrl, '', '空串应清空 usageUrl');
});

test('balanceProvider:命中 moonshot/deepseek,未命中返回 null', () => {
  assert.ok(keys.balanceProvider('https://api.moonshot.cn'), '国内站应命中');
  assert.ok(keys.balanceProvider('https://api.moonshot.ai'), '国际站应命中');
  assert.ok(keys.balanceProvider('https://api.kimi.ai'), 'kimi.ai 应命中');
  assert.ok(keys.balanceProvider('https://api.deepseek.com/v1'), '带路径也应按 host 命中');
  assert.strictEqual(keys.balanceProvider('https://gw.example.com'), null, '未知网关不命中');
  assert.strictEqual(keys.balanceProvider(''), null);
});

test('queryBalance: Moonshot 响应解析并缓存(mock fetch)', async () => {
  const r0 = keys.save({ name: '月之暗面', key: 'sk-moonshot-8888', baseUrl: 'https://api.moonshot.cn' });
  assert.strictEqual(r0.ok, true);
  const moon = keys.list().find((k) => k.name === '月之暗面');
  assert.strictEqual(moon.canBalance, true, '命中映射的 Key 应标记 canBalance');
  const origFetch = global.fetch;
  let seenUrl = '', seenAuth = '';
  global.fetch = async (url, opts) => {
    seenUrl = url; seenAuth = opts.headers.authorization;
    return { ok: true, json: async () => ({ data: { available_balance: 12.5, voucher_balance: 10, cash_balance: 2.5 } }) };
  };
  try {
    const r = await keys.queryBalance(moon.id);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, '可用余额 ¥12.50(代金券 ¥10.00 / 现金 ¥2.50)');
    assert.strictEqual(seenUrl, 'https://api.moonshot.cn/v1/users/me/balance');
    assert.strictEqual(seenAuth, 'Bearer sk-moonshot-8888', '余额接口应走 Bearer 头');
    const cached = keys.list().find((k) => k.id === moon.id);
    assert.strictEqual(cached.balanceCache.text, r.text, '成功结果应持久化到 balanceCache');
  } finally {
    global.fetch = origFetch;
  }
});

test('queryBalance: 401 透传为错误文案且不覆盖缓存(mock fetch)', async () => {
  const moon = keys.list().find((k) => k.name === '月之暗面');
  const before = keys.list().find((k) => k.id === moon.id).balanceCache;
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  try {
    const r = await keys.queryBalance(moon.id);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /401/);
    assert.ok(!r.error.includes('sk-moonshot'), '错误文案不得带 key');
    const cached = keys.list().find((k) => k.id === moon.id).balanceCache;
    assert.deepStrictEqual(cached, before, '失败不得覆盖既有缓存');
  } finally {
    global.fetch = origFetch;
  }
});

test('queryBalance: 未命中映射的 Key 拒绝自动查询', async () => {
  const kuro = keys.list().find((k) => k.name === '库洛');
  assert.strictEqual(kuro.canBalance, false);
  const r = await keys.queryBalance(kuro.id);
  assert.strictEqual(r.ok, false);
});

test('baseUrl 自带 /v1 时端点不重复拼接(模型 + 余额)', async () => {
  const r1 = keys.save({ name: '带v1网关', key: 'gw-token-6666', baseUrl: 'https://gw2.example.com/v1' });
  assert.strictEqual(r1.ok, true);
  const gw = keys.list().find((k) => k.name === '带v1网关');
  const r2 = keys.save({ name: '月之暗面v1', key: 'sk-moonshot-v1-5555', baseUrl: 'https://api.moonshot.cn/v1' });
  assert.strictEqual(r2.ok, true);
  const moon1 = keys.list().find((k) => k.name === '月之暗面v1');

  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    if (url.includes('/models')) return { ok: true, json: async () => ({ data: [{ id: 'm-1' }] }) };
    return { ok: true, json: async () => ({ data: { available_balance: 1, voucher_balance: 0, cash_balance: 1 } }) };
  };
  try {
    const rm = await keys.refreshModels(gw.id);
    assert.strictEqual(rm.ok, true);
    assert.strictEqual(seen[0], 'https://gw2.example.com/my-models/api', '分组接口应先尝试且不带 /v1');
    assert.strictEqual(seen[1], 'https://gw2.example.com/v1/models?limit=100', '模型端点不得出现 /v1/v1');
    const rb = await keys.queryBalance(moon1.id);
    assert.strictEqual(rb.ok, true);
    assert.strictEqual(seen[2], 'https://api.moonshot.cn/v1/users/me/balance', '余额端点不得出现 /v1/v1');
  } finally {
    global.fetch = origFetch;
  }
});

test('apiRoot: 归一到不含 /v1 的根(buildEnv 的 ANTHROPIC_BASE_URL 同用此规则)', () => {
  // claude.exe 会在 ANTHROPIC_BASE_URL 后再拼 /v1/messages:baseUrl 带 /v1 会变 /v1/v1 → 404
  assert.strictEqual(keys.apiRoot('https://api.kimi.com/coding/v1'), 'https://api.kimi.com/coding');
  assert.strictEqual(keys.apiRoot('https://api.kimi.com/coding/v1/'), 'https://api.kimi.com/coding');
  assert.strictEqual(keys.apiRoot('https://gw.example.com/'), 'https://gw.example.com');
  assert.strictEqual(keys.apiRoot('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/anthropic', '无 /v1 后缀应保持不变');
  assert.strictEqual(keys.apiRoot(''), 'https://api.anthropic.com', '缺省归位官方');
  assert.strictEqual(keys.apiRoot(undefined), 'https://api.anthropic.com');
});

test('多选激活:默认启用,setEnabled 控制 enabledModels 聚合', () => {
  // 现有 key 默认全部启用
  for (const k of keys.list()) assert.strictEqual(k.enabled, true, `${k.name} 应默认启用`);
  // 库洛有模型缓存(claude-fable-5, claude-haiku-4-5)
  const agg = keys.enabledModels();
  assert.ok(Array.isArray(agg) && agg.length >= 2);
  const kuro = keys.list().find((k) => k.name === '库洛');
  const kuroEntries = agg.filter((e) => e.keyId === kuro.id);
  assert.deepStrictEqual(kuroEntries.map((e) => e.model), ['claude-fable-5', 'claude-haiku-4-5']);
  assert.strictEqual(kuroEntries[0].keyName, '库洛');
  // 取消勾选后其模型退出聚合
  assert.strictEqual(keys.setEnabled(kuro.id, false).ok, true);
  assert.strictEqual(keys.list().find((k) => k.id === kuro.id).enabled, false);
  const agg2 = keys.enabledModels() || [];
  assert.strictEqual(agg2.filter((e) => e.keyId === kuro.id).length, 0, '停用后模型应退出下拉聚合');
  // 重新启用恢复
  keys.setEnabled(kuro.id, true);
  assert.ok((keys.enabledModels() || []).some((e) => e.keyId === kuro.id));
  assert.strictEqual(keys.setEnabled('k_nope', true).ok, false);
});

test('enabledModels:模型勾选白名单优先于全量缓存', () => {
  const kuro = keys.list().find((k) => k.name === '库洛');
  keys.setModelsEnabled(kuro.id, ['claude-fable-5']);
  const agg = keys.enabledModels() || [];
  assert.deepStrictEqual(agg.filter((e) => e.keyId === kuro.id).map((e) => e.model), ['claude-fable-5']);
  keys.setModelsEnabled(kuro.id, null); // 恢复全量
});

test('byId:主进程内部解析完整条目(会话 env 注入用)', () => {
  const kuro = keys.list().find((k) => k.name === '库洛');
  const raw = keys.byId(kuro.id);
  assert.strictEqual(raw.key, 'kuro-abcdef9999', 'byId 应返回含完整 key 的原始条目(仅限主进程)');
  assert.strictEqual(keys.byId('k_nope'), null);
});

test('编辑保存:key 留空保留原 secret,其余字段正常更新', () => {
  const kuro = keys.list().find((k) => k.name === '库洛');
  const r = keys.save({ id: kuro.id, name: '库洛网关', key: '', baseUrl: 'https://gw2.example.com' });
  assert.strictEqual(r.ok, true, '编辑时 key 留空不应报「Key 不能为空」');
  const after = keys.list().find((k) => k.id === kuro.id);
  assert.strictEqual(after.name, '库洛网关');
  assert.strictEqual(after.baseUrl, 'https://gw2.example.com');
  assert.ok(after.keyHint.endsWith('9999'), 'secret 应保持不变');
  assert.strictEqual(keys.byId(kuro.id).key, 'kuro-abcdef9999', '原始条目 key 不应被清空');
  // 留空以外的正常更新仍生效
  keys.save({ id: kuro.id, key: 'kuro-newkey-7777' });
  assert.strictEqual(keys.byId(kuro.id).key, 'kuro-newkey-7777');
  keys.save({ id: kuro.id, key: 'kuro-abcdef9999' }); // 还原,避免影响其他用例
});

test('迁移:已存在的「默认 Key」自动改名为「Kuro」并持久化', () => {
  const raw = store.getSetting('apiKeys', []);
  store.setSetting('apiKeys', [...raw, { id: 'k_legacydef', name: '默认 Key', key: 'sk-ant-olddefault-4321', baseUrl: '', kind: 'apiKey', models: [], modelsAt: 0 }]);
  const renamed = keys.list().find((k) => k.id === 'k_legacydef');
  assert.strictEqual(renamed.name, 'Kuro', '加载时应一次性改名');
  assert.strictEqual(renamed.keyHint, '…4321', '改名不得影响 key 本体');
  const persisted = store.getSetting('apiKeys', []).find((k) => k.id === 'k_legacydef');
  assert.strictEqual(persisted.name, 'Kuro', '改名应随 store 保存生效');
  keys.remove('k_legacydef'); // 清理,避免影响其他用例
});

test('refreshModels: 优先 /my-models/api,存 modelGroups 并平铺 models(mock fetch)', async () => {
  const kuro = keys.list().find((k) => k.name === '库洛网关');
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    // Kuro 网关分组接口:同组内去重由 refreshModels 的并集逻辑负责
    return { ok: true, json: async () => ({ total_models: 3, groups: [
      { category: 'claude', model_type: 'chat', count: 2, models: ['claude-fable-5', 'kling-3-0'] },
      { category: 'kling', model_type: 'video', count: 1, models: ['kling-3-0'] },
    ] }) };
  };
  try {
    const r = await keys.refreshModels(kuro.id);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.models, ['claude-fable-5', 'kling-3-0'], 'models 应为各组并集(跨组重复去重)');
    assert.deepStrictEqual(seen, ['https://gw2.example.com/my-models/api'], '分组成功时不应再请求 /v1/models');
    const raw = keys.byId(kuro.id);
    assert.strictEqual(raw.modelGroups.length, 2);
    assert.strictEqual(raw.modelGroups[1].model_type, 'video');
    const pub = keys.list().find((k) => k.id === kuro.id);
    assert.strictEqual(pub.modelGroups.length, 2, '脱敏列表应带 modelGroups');
    assert.ok(!('key' in pub), '脱敏列表仍不得含完整 key');
  } finally {
    global.fetch = origFetch;
  }
});

test('refreshModels: /my-models/api 404 时回退 /v1/models 且 modelGroups 置 null(mock fetch)', async () => {
  const kuro = keys.list().find((k) => k.name === '库洛网关');
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    if (url.includes('/my-models/api')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => ({ data: [{ id: 'claude-fable-5' }, { id: 'claude-haiku-4-5' }] }) };
  };
  try {
    const r = await keys.refreshModels(kuro.id);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.models, ['claude-fable-5', 'claude-haiku-4-5']);
    assert.deepStrictEqual(seen, [
      'https://gw2.example.com/my-models/api',
      'https://gw2.example.com/v1/models?limit=100',
    ], '应先试分组接口,404 后回退 /v1/models');
    assert.strictEqual(keys.byId(kuro.id).modelGroups, null, '回退成功应清空 modelGroups');
  } finally {
    global.fetch = origFetch;
  }
});
