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
