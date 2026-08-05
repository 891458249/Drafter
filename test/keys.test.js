// keys.js tests:迁移、保存/脱敏、切换默认、删除、模型识别(带 mock fetch)
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ui-keys-test-'));
installElectronStub(tmp);
const store = require('../src/main/store');
const keys = require('../src/main/keys');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('旧单 apiKey 自动迁移为多 key 列表并设为默认', () => {
  store.setSetting('apiKey', 'sk-ant-legacy1234');
  const list = keys.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, '默认 Key');
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
  assert.strictEqual(keys.activeKey().name, '默认 Key', '删除默认后应回退到剩余第一个');
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
