// files.js smoke tests: listFiles ignore rules, read/save round-trip,
// optimistic-concurrency conflict on stale mtime.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const files = require('../src/main/files');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ui-files-test-'));

// 非 git 目录 → listFiles 走 walk 兜底
fs.mkdirSync(path.join(tmp, 'src'));
fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
fs.mkdirSync(path.join(tmp, '.git'));
fs.writeFileSync(path.join(tmp, 'src', 'a.js'), 'a');
fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'x.js'), 'x');
fs.writeFileSync(path.join(tmp, '.git', 'config'), 'g');
fs.writeFileSync(path.join(tmp, 'b.txt'), 'b');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('listFiles: 排除 node_modules 与 .git,保留普通文件', async () => {
  const list = await files.listFiles(tmp);
  assert.ok(list.includes('b.txt'), '应包含 b.txt');
  assert.ok(list.some((f) => f.replace(/\\/g, '/') === 'src/a.js'), '应包含 src/a.js');
  assert.ok(!list.some((f) => f.includes('node_modules')), '不应包含 node_modules');
  assert.ok(!list.some((f) => f.split(/[\\/]/).includes('.git')), '不应包含 .git');
});

test('readFile/saveFile: 写入后读回内容一致', () => {
  const w = files.saveFile(tmp, 'round.txt', '第一版内容');
  assert.strictEqual(w.ok, true);
  assert.ok(w.mtimeMs > 0);

  const r = files.readFile(tmp, 'round.txt');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.content, '第一版内容');
  assert.strictEqual(r.mtimeMs, w.mtimeMs);
});

test('saveFile: 过期 mtime 触发冲突拒绝,最新 mtime 正常写入', () => {
  const w1 = files.saveFile(tmp, 'conflict.txt', 'v1');
  assert.strictEqual(w1.ok, true);

  const stale = files.saveFile(tmp, 'conflict.txt', 'v2-stale', w1.mtimeMs - 10000);
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.conflict, true);
  // 冲突时文件内容不应被覆盖
  assert.strictEqual(files.readFile(tmp, 'conflict.txt').content, 'v1');

  const fresh = files.saveFile(tmp, 'conflict.txt', 'v2', w1.mtimeMs);
  assert.strictEqual(fresh.ok, true);
  assert.strictEqual(files.readFile(tmp, 'conflict.txt').content, 'v2');
});
