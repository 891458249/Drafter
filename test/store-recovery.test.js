const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-store-recovery-'));
require('./helpers/electron-stub').installElectronStub(tmp);
const store = require('../src/main/store');
const file = path.join(tmp, 'drafter-store.json');
const original = { settings: { theme: 'saved' }, sessions: [{ id: 'retained' }], projects: [] };
beforeEach(() => {
  for (const name of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, name));
  fs.writeFileSync(file, JSON.stringify(original));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('损坏或错误类型的配置无备份时拒绝读取/覆盖，并保留原文件', () => {
  for (const raw of ['{truncated', 'null', '[]', '{"sessions":{}}']) {
    fs.writeFileSync(file, raw);
    assert.throws(() => store.loadStore(), /配置损坏/);
    assert.throws(() => store.setSetting('theme', 'new'), /配置损坏/);
    assert.throws(() => store.saveStore({ settings: {} }), /配置损坏/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});

test('损坏配置从有效备份恢复，保存前保留损坏原件与会话', () => {
  fs.writeFileSync(file + '.bak', JSON.stringify(original));
  fs.writeFileSync(file, '{truncated');
  assert.deepEqual(store.loadStore(), original);
  store.setSetting('theme', 'new');
  assert.equal(store.listSessions()[0].id, 'retained');
  assert.equal(store.getSetting('theme'), 'new');
  const corrupt = fs.readdirSync(tmp).find((n) => n.includes('.corrupt-'));
  assert.equal(fs.readFileSync(path.join(tmp, corrupt), 'utf8'), '{truncated');
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), original);
});

test('原子替换失败会向调用者报错，原配置与有效备份都保留', (t) => {
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) throw Object.assign(new Error('simulated disk error'), { code: 'EIO' });
    return rename(from, to);
  });
  assert.throws(() => store.setSetting('theme', 'new'), /simulated disk error/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), original);
  assert.equal(fs.readdirSync(tmp).some((n) => n.includes('.tmp-')), false);
});

test('读取权限错误不能退回空数据或旧备份', (t) => {
  fs.writeFileSync(file + '.bak', JSON.stringify(original));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (name, ...args) => {
    if (name === file) throw Object.assign(new Error('simulated permission denied'), { code: 'EACCES' });
    return read(name, ...args);
  });
  assert.throws(() => store.loadStore(), /已停止保存/);
  assert.throws(() => store.setSetting('theme', 'new'), /已停止保存/);
});

test('原文件缺失时从备份恢复；成功保存后备份保留上一版', () => {
  store.setSetting('theme', 'second');
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak')).settings.theme, 'saved');
  fs.unlinkSync(file);
  assert.deepEqual(store.loadStore(), original);
});
