// store.js smoke tests: settings round-trip, session upsert/list, JSONL event log.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ui-store-test-'));
installElectronStub(tmp);
const store = require('../src/main/store');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('settings: 写入后读回,置 null 后回退默认值', () => {
  store.setSetting('theme', { mode: 'dark', fontSize: 14 });
  assert.deepStrictEqual(store.getSetting('theme'), { mode: 'dark', fontSize: 14 });

  store.setSetting('theme', null);
  assert.strictEqual(store.getSetting('theme', 'fallback'), 'fallback');
});

test('sessions: upsert 新建与按 id 更新,list 不重复', () => {
  const meta = store.upsertSession({ id: 's1', cwd: 'D:/x', title: '第一版' });
  assert.ok(meta.createdAt > 0);

  store.upsertSession({ id: 's1', title: '改名后' });
  store.upsertSession({ id: 's2', cwd: 'D:/y', title: '另一个' });

  const all = store.listSessions();
  assert.strictEqual(all.length, 2);
  const s1 = all.find((x) => x.id === 's1');
  assert.strictEqual(s1.title, '改名后');
  assert.strictEqual(s1.cwd, 'D:/x'); // 未提供的字段保留
  assert.ok(s1.updatedAt >= s1.createdAt);
});

test('JSONL 事件日志: 追加后按序读回', () => {
  store.appendSessionEvent('sess-log', { type: 'init', n: 1 });
  store.appendSessionEvent('sess-log', { type: 'result', n: 2, cost: 0.01 });

  const events = store.readSessionEvents('sess-log');
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].type, 'init');
  assert.strictEqual(events[1].cost, 0.01);

  // 不存在的会话返回空数组而不是抛错
  assert.deepStrictEqual(store.readSessionEvents('no-such-session'), []);
});

test('modelUsage: 同模型用量累加', () => {
  store.addModelUsage('m1', { input_tokens: 10, output_tokens: 5 }, 0.001);
  store.addModelUsage('m1', { input_tokens: 20, output_tokens: 7 }, 0.002);
  const usage = store.loadStore().modelUsage.m1;
  assert.strictEqual(usage.input, 30);
  assert.strictEqual(usage.output, 12);
  assert.ok(Math.abs(usage.cost - 0.003) < 1e-9);
});
