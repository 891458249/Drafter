// 「不询问」模式(v0.12.x 语义修正):模型的操作建议一律按其推荐执行直到任务
// 完成,中途不弹权限卡;与 bypassPermissions 的区别是只读硬拦截仍生效。
// 此前 dontAsk 是「自动拒绝未预批准」,与该模式名的直觉相反。
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-perm-modes-'));
installElectronStub(tmp);
const store = require('../src/main/store');
const projects = require('../src/main/projects');
const { Session, SessionManager } = require('../src/main/sessions');

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

let n = 0;
function makeSession(meta = {}) {
  const mgr = new SessionManager(() => null, () => ({}));
  const id = 's_perm_' + (++n);
  const s = new Session(mgr, { id, cwd: tmp, kind: 'code', permissionMode: 'dontAsk', ...meta });
  return s;
}

test('不询问:编辑与非编辑工具都自动放行', async () => {
  const s = makeSession();
  const edit = await s._onPermission('Edit', { file_path: path.join(tmp, 'a.js'), new_string: 'x' });
  assert.strictEqual(edit.behavior, 'allow');
  assert.deepStrictEqual(edit.updatedInput, { file_path: path.join(tmp, 'a.js'), new_string: 'x' });
  const bash = await s._onPermission('Bash', { command: 'npm test' });
  assert.strictEqual(bash.behavior, 'allow', 'Bash 等非编辑工具也应自动放行');
  assert.strictEqual(s.pendingPerms.size, 0, '不应产生待裁决权限卡');
});

test('不询问:只读硬拦截仍然生效(唯一保留的拦截)', async () => {
  const dir = path.join(tmp, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const roFile = path.join(dir, 'locked.js');
  const p = projects.ensureForDir(dir);
  store.upsertProject({ id: p.id, files: [{ path: roFile, tag: 'readonly' }] });
  const s = makeSession({ projectId: p.id });
  const r = await s._onPermission('Edit', { file_path: roFile, new_string: 'x' });
  assert.strictEqual(r.behavior, 'deny', '只读文件即使不询问模式也必须拦截');
  assert.ok(/只读/.test(r.message));
});

test('热切到不询问:挂起的权限卡按放行了结', async () => {
  const s = makeSession({ permissionMode: 'default' });
  const decisions = [];
  s.pendingPerms.set('perm_1', { resolve: (r) => decisions.push(r), toolName: 'Write', input: {} });
  s.pendingPerms.set('perm_2', { resolve: (r) => decisions.push(r), toolName: 'Bash', input: {} });
  await s.setPermissionMode('dontAsk');
  assert.strictEqual(s.pendingPerms.size, 0, '挂起卡片应全部了结');
  assert.strictEqual(decisions.length, 2);
  assert.ok(decisions.every((d) => d.behavior === 'allow'), '挂起卡片应按放行了结而非拒绝');
  assert.strictEqual(store.listSessions().find((m) => m.id === s.id).permissionMode, 'dontAsk');
});

test('热切到不询问(运行中):SDK 控制请求失败也不影响本地放行兜底', async () => {
  const s = makeSession({ permissionMode: 'default' });
  s.running = true;
  s.q = { setPermissionMode: async () => { throw new Error('unsupported mode'); } };
  const r = await s.setPermissionMode('dontAsk');
  assert.strictEqual(r, false, '控制请求失败返回 false,只记日志');
  const bash = await s._onPermission('Bash', { command: 'dir' });
  assert.strictEqual(bash.behavior, 'allow', '本地兜底仍按最新模式放行');
});

test('对照:默认模式仍弹权限卡,bypassPermissions 行为不变', async () => {
  const s = makeSession({ permissionMode: 'default' });
  const p = s._onPermission('Bash', { command: 'dir' });
  assert.strictEqual(s.pendingPerms.size, 1, '默认模式应产生待裁决卡片');
  const reqId = [...s.pendingPerms.keys()][0];
  s.respondPermission(reqId, 'allow');
  assert.strictEqual((await p).behavior, 'allow');

  const s2 = makeSession({ permissionMode: 'bypassPermissions' });
  assert.strictEqual((await s2._onPermission('Bash', { command: 'dir' })).behavior, 'allow');
});
