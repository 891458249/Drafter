const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-readonly-boundary-'));
require('./helpers/electron-stub').installElectronStub(tmp);
const store = require('../src/main/store');
const projects = require('../src/main/projects');
const { Session } = require('../src/main/sessions');
const locked = path.join(tmp, 'locked.txt');
fs.writeFileSync(locked, 'preserve');
store.upsertProject({ id: 'protected', dirs: [tmp], files: [{ path: locked, tag: 'readonly' }] });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const reason = (name, input) => projects.readonlyToolReason('protected', tmp, name, input);

test('只读标签阻止 shell、MCP 和子 Agent，仍允许读取与非保护文件编辑', () => {
  for (const name of ['Bash', 'Agent', 'Task', 'mcp__server__write', 'UnknownTool']) assert.match(reason(name, {}), /已阻止调用/);
  assert.equal(reason('Read', { file_path: locked }), null);
  assert.equal(reason('Write', { file_path: 'new.txt' }), null);
  assert.match(reason('Write', { file_path: 'locked.txt' }), /只读/);
  assert.match(reason('Write', {}), /无法确定/);
});

test('路径大小写、链接和新文件的链接父目录不能绕过保护', () => {
  if (process.platform === 'win32') {
    assert.ok(reason('Edit', { file_path: locked.toUpperCase() }));
    assert.ok(reason('Write', { file_path: locked + ':stream' }));
  }
  const hard = path.join(tmp, 'hard.txt');
  fs.linkSync(locked, hard);
  assert.ok(reason('Write', { file_path: hard }));
  const dir = path.join(tmp, 'protected-dir');
  fs.mkdirSync(dir);
  const alias = path.join(tmp, 'alias');
  fs.symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  store.upsertProject({ id: 'directory', files: [{ path: dir, tag: 'readonly' }] });
  assert.ok(projects.readonlyToolReason('directory', tmp, 'Write', { file_path: path.join(alias, 'new.txt') }));
});

test('自动放行和绕过权限模式也遵守只读保护', async () => {
  for (const mode of ['dontAsk', 'bypassPermissions', 'acceptEdits']) {
    const s = new Session({}, { id: 'x', cwd: tmp, projectId: 'protected', permissionMode: mode });
    s._emit = () => {};
    s.autoAllowTools.add('Bash');
    assert.equal((await s._onPermission('Bash', { command: 'echo changed > locked.txt' })).behavior, 'deny');
  }
});

test('权限卡等待中标签变化，切换不询问也不能放行已受保护操作', async () => {
  store.upsertProject({ id: 'dynamic', files: [] });
  const s = new Session({ notifyPermission() {} }, { id: 'dynamic-session', cwd: tmp, projectId: 'dynamic', permissionMode: 'default' });
  s._emit = () => {};
  const pending = s._onPermission('Bash', { command: 'echo changed > locked.txt' });
  store.upsertProject({ id: 'dynamic', files: [{ path: locked, tag: 'readonly' }] });
  await s.setPermissionMode('dontAsk');
  assert.equal((await pending).behavior, 'deny');
});

test('只读状态读取失败时阻止操作，无只读标签的项目保持原行为', (t) => {
  assert.equal(projects.readonlyToolReason(null, tmp, 'Bash', {}), null);
  t.mock.method(store, 'listProjects', () => { throw new Error('disk failure'); });
  assert.match(reason('Bash', {}), /检查失败/);
});
