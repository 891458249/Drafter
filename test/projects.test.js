// projects.js smoke tests: ensureForDir idempotency, file tag persistence
// and read-only enforcement. Runs on the electron stub (store.js dependency).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ui-projects-test-'));
installElectronStub(tmp);
const projects = require('../src/main/projects');

const projDir = path.join(tmp, 'my-proj');
fs.mkdirSync(projDir);

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('ensureForDir: 同一目录重复调用返回同一个项目组,不重复建组', () => {
  const p1 = projects.ensureForDir(projDir);
  assert.ok(p1.id.startsWith('p_'));
  assert.strictEqual(p1.name, 'my-proj');

  const p2 = projects.ensureForDir(projDir);
  assert.strictEqual(p2.id, p1.id);
  assert.strictEqual(projects.list().length, 1);
});

test('setTag: 文件标签切换后持久化,isReadonly 实时生效', () => {
  const p = projects.ensureForDir(projDir);
  const file = path.join(projDir, 'locked.txt');

  projects.addFiles(p.id, [file], 'editable');
  assert.strictEqual(projects.isReadonly(p.id, file), false);

  projects.setTag(p.id, file, 'readonly');
  // 重新从 store 读取(模拟持久化后的二次访问)
  const reloaded = projects.get(p.id);
  const entry = reloaded.files.find((f) => f.path === file);
  assert.strictEqual(entry.tag, 'readonly');
  assert.strictEqual(projects.isReadonly(p.id, file), true);

  // 只读标签打在“目录路径”上时,其子路径也被拦截
  const folder = path.join(projDir, 'docs');
  projects.addFiles(p.id, [folder], 'readonly');
  assert.strictEqual(projects.isReadonly(p.id, path.join(folder, 'nested.md')), true);

  // 未登记的路径不受限制
  assert.strictEqual(projects.isReadonly(p.id, path.join(projDir, 'other.txt')), false);
});

test('pruneMissing: 清理失效登记,主目录删除且无会话的组被移除', () => {
  const store = require('../src/main/store');
  const keepDir = path.join(tmp, 'keep-proj');
  const goneDir = path.join(tmp, 'gone-proj');
  const ghostDir = path.join(tmp, 'ghost-proj');
  fs.mkdirSync(keepDir);
  fs.mkdirSync(goneDir);
  // ghostDir 故意不创建:主目录一开始就不存在

  const keep = projects.ensureForDir(keepDir);
  const existFile = path.join(keepDir, 'a.txt');
  fs.writeFileSync(existFile, 'x');
  projects.addFiles(keep.id, [existFile, path.join(keepDir, 'missing.txt')], 'editable');
  projects.addDir(keep.id, path.join(tmp, 'no-such-extra-dir'));

  const gone = projects.ensureForDir(goneDir);
  store.upsertSession({ id: 'sess-keep', cwd: goneDir, projectId: gone.id }); // gone 组有会话

  const ghost = projects.ensureForDir(ghostDir); // 无会话且主目录不存在

  const r = projects.pruneMissing();
  // 失效的额外目录与文件被清理,存在的保留
  const keepAfter = projects.get(keep.id);
  assert.deepStrictEqual(keepAfter.dirs, [keepDir]);
  assert.deepStrictEqual(keepAfter.files.map((f) => f.path), [existFile]);
  // 全局清理计数:至少包含本组的 1 个失效目录与 1 个失效文件
  // (本测试文件共享 store,前两个用例登记的 locked.txt/docs 同样会被正确清理)
  assert.ok(r.dirs >= 1);
  assert.ok(r.files >= 1);
  // 有会话的组即使主目录失效也保留
  assert.ok(projects.get(gone.id), 'gone 组有会话,应保留');
  // 无会话且主目录不存在的组被移除
  assert.strictEqual(projects.get(ghost.id), null, 'ghost 组应被移除');
  assert.ok(r.groups.length >= 1);
});
