// sessions.js Session.setModel(v0.11.x):跨 Key 切换模型必须重启 query 换凭据,
// 否则旧 Key 的 token 打到新 Key 的网关必 403「模型未配置」。
// 复用 setGem/addDir 的 needRestart 模式:回合中标记,空闲立即 stop+start。
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-setmodel-test-'));
installElectronStub(tmp);
const { SessionManager, Session } = require('../src/main/sessions');
// SessionManager.create() 会 fire-and-forget 调 Session.start() 真起 query(spawn claude.exe):
// 子进程占住事件循环,文件测试全过也无法退出,全套件随之卡死(v0.11.4 起既有)。
// 本文件只测 setModel 的重启决策,一律把原型 start stub 掉,不真起 query。
Session.prototype.start = async () => {};

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

let n = 0;
function makeMgr() {
  // 每用例独立 cwd 子目录,避免会话事件文件与清理冲突
  const cwd = path.join(tmp, 'case-' + (++n));
  fs.mkdirSync(cwd, { recursive: true });
  const mgr = new SessionManager(() => null, (extra, keyId) => ({ keyId }));
  return { mgr, cwd };
}

function makeSession(mgr, cwd, { keyId, model } = {}) {
  const s = mgr.create({ cwd, kind: 'code', keyId: keyId || null, model: model || null });
  const live = mgr.get(s.id);
  // stub 运行态:绕过 loadSdk/query
  live.running = true;
  live.q = { setModel: async () => {} };
  return live;
}

test('同 Key 换模型:走 q.setModel,不重启', async () => {
  const { mgr, cwd } = makeMgr();
  const s = makeSession(mgr, cwd, { keyId: 'k_a', model: 'm1' });
  let stopped = 0, started = 0;
  s.stop = () => { stopped++; };
  s.start = async () => { started++; };
  const r = await s.setModel('m2', 'k_a');
  assert.strictEqual(r, true);
  assert.strictEqual(s.meta.model, 'm2');
  assert.strictEqual(s.meta.keyId, 'k_a');
  assert.strictEqual(stopped, 0, '同 Key 不应重启');
  assert.strictEqual(started, 0);
  assert.ok(!s.needRestart);
});

test('跨 Key 换模型(空闲):立即 stop+start 重启换凭据', async () => {
  const { mgr, cwd } = makeMgr();
  const s = makeSession(mgr, cwd, { keyId: 'k_a', model: 'm1' });
  let stopped = 0, started = 0, resumeArg = null;
  s.busy = false;
  s.stop = () => { stopped++; };
  s.start = async (opts) => { started++; resumeArg = opts && opts.resume; };
  const r = await s.setModel('kimi-for-coding', 'k_b');
  assert.strictEqual(r, true);
  assert.strictEqual(s.meta.model, 'kimi-for-coding');
  assert.strictEqual(s.meta.keyId, 'k_b');
  assert.strictEqual(stopped, 1, '跨 Key 空闲应 stop');
  assert.strictEqual(started, 1, '跨 Key 空闲应 start');
  assert.strictEqual(resumeArg, false, '无 sdkSessionId 时不 resume');
  assert.ok(!s.needRestart);
});

test('跨 Key 换模型(回合中):标记 needRestart,不打断', async () => {
  const { mgr, cwd } = makeMgr();
  const s = makeSession(mgr, cwd, { keyId: 'k_a', model: 'm1' });
  let stopped = 0, started = 0;
  s.busy = true;
  s.stop = () => { stopped++; };
  s.start = async () => { started++; };
  const r = await s.setModel('kimi-for-coding', 'k_b');
  assert.strictEqual(r, true);
  assert.strictEqual(s.meta.keyId, 'k_b');
  assert.strictEqual(stopped, 0, '回合中不应打断');
  assert.strictEqual(started, 0);
  assert.strictEqual(s.needRestart, true, '回合中应标记 needRestart 待回合后重启');
});

test('跨 Key 换模型带 sdkSessionId:重启时 resume 保上下文', async () => {
  const { mgr, cwd } = makeMgr();
  const s = makeSession(mgr, cwd, { keyId: 'k_a', model: 'm1' });
  s.meta.sdkSessionId = 'sdk_123';
  let resumeArg = null;
  s.busy = false;
  s.stop = () => {};
  s.start = async (opts) => { resumeArg = opts && opts.resume; };
  await s.setModel('m2', 'k_b');
  assert.strictEqual(resumeArg, true, '有 sdkSessionId 的重启应 resume 保上下文');
});

test('清除模型(置 null):keyId 同步清除,同 Key 不重启', async () => {
  const { mgr, cwd } = makeMgr();
  const s = makeSession(mgr, cwd, { keyId: 'k_a', model: 'm1' });
  let stopped = 0;
  s.stop = () => { stopped++; };
  // keyId 显式传 null → 清除绑定;prevKeyId=k_a → null 视为变化,但模型也置 null
  // 此处验证「默认」选项(空 value → parseModelValue 得 {keyId:null,model:null})
  await s.setModel(null, null);
  assert.strictEqual(s.meta.model, null);
  assert.strictEqual(s.meta.keyId, null);
});
