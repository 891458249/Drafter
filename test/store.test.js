// store.js smoke tests: settings round-trip, session upsert/list, JSONL event log.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-store-test-'));
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

test('legacy store: 新文件缺失时读旧品牌 store 兜底,写入回落新文件名(v0.9.35 更名)', () => {
  const newFile = path.join(tmp, 'drafter-store.json');
  const midFile = path.join(tmp, 'desktopui-store.json');
  const legacyFile = path.join(tmp, 'claude-ui-store.json');
  const bak = fs.readFileSync(newFile, 'utf8'); // 前面的用例已写出新文件
  fs.renameSync(newFile, newFile + '.bak');
  fs.writeFileSync(legacyFile, JSON.stringify({ settings: { theme: 'legacy-mark' }, sessions: [], recentProjects: [], cronJobs: [] }));
  try {
    // 新文件缺失 → 最旧的 legacy 兜底读到
    assert.strictEqual(store.getSetting('theme'), 'legacy-mark');
    // 中间代 desktopui 存在时优先于最旧的 claude-ui
    fs.writeFileSync(midFile, JSON.stringify({ settings: { theme: 'mid-mark' }, sessions: [], recentProjects: [], cronJobs: [] }));
    assert.strictEqual(store.getSetting('theme'), 'mid-mark');
    // 写入走新文件名;旧文件只读兜底不删
    store.setSetting('theme', 'rewritten');
    assert.ok(fs.existsSync(newFile));
    assert.ok(fs.existsSync(legacyFile));
    assert.strictEqual(store.getSetting('theme'), 'rewritten');
  } finally {
    fs.rmSync(legacyFile, { force: true });
    fs.rmSync(midFile, { force: true });
    fs.rmSync(newFile, { force: true });
    fs.writeFileSync(newFile, bak);
  }
});

test('modelUsage: 同模型用量累加', () => {
  store.addModelUsage('m1', { input_tokens: 10, output_tokens: 5 }, 0.001);
  store.addModelUsage('m1', { input_tokens: 20, output_tokens: 7 }, 0.002);
  const usage = store.loadStore().modelUsage.m1;
  assert.strictEqual(usage.input, 30);
  assert.strictEqual(usage.output, 12);
  assert.ok(Math.abs(usage.cost - 0.003) < 1e-9);
});

test('keyUsage: 周/月桶累加与周期锚点正确', () => {
  store.addKeyUsage('k1', 1.5, { input_tokens: 100, output_tokens: 10 });
  store.addKeyUsage('k1', 2.5, { input_tokens: 50, output_tokens: 5 });
  const u = store.getKeyUsage('k1');
  const now = Date.now();
  assert.strictEqual(u.weekStart, store.weekStartOf(now));
  assert.strictEqual(u.monthStart, store.monthStartOf(now));
  assert.ok(Math.abs(u.weekCost - 4) < 1e-9);
  assert.ok(Math.abs(u.monthCost - 4) < 1e-9);
  assert.strictEqual(u.weekInput, 150);
  assert.strictEqual(u.monthOutput, 15);
  // 周期锚点:本周一 0 点、本月 1 号 0 点(本地)
  const ws = new Date(store.weekStartOf(now));
  assert.strictEqual(ws.getDay() === 0 ? 7 : ws.getDay(), 1, '周锚点必须是周一');
  assert.strictEqual(ws.getHours() + ws.getMinutes() + ws.getSeconds(), 0);
  const ms = new Date(store.monthStartOf(now));
  assert.strictEqual(ms.getDate(), 1, '月锚点必须是 1 号');
  // 未知 key 返回 null
  assert.strictEqual(store.getKeyUsage('nope'), null);
});
