// Resume recovery: a provider-side transcript can be semantically invalid after
// an interrupted turn even though its JSONL file still exists. The session must
// clear only that failed resume anchor, preserving Drafter's replay history.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-resume-recovery-'));
installElectronStub(tmp);
const store = require('../src/main/store');
const { Session, SessionManager } = require('../src/main/sessions');

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function throwingQuery(message) {
  return {
    async *[Symbol.asyncIterator]() {
      throw new Error(message);
    },
  };
}

test('恢复会话遇到 message.uuid 错误:清 SDK 锚点并保留本地历史', async () => {
  const id = 's_resume_corrupt';
  store.upsertSession({ id, cwd: tmp, sdkSessionId: 'sdk_broken', title: '恢复测试' });
  store.appendSessionEvent(id, { type: 'ui_user_input', content: '此前的可见历史' });
  const mgr = new SessionManager(() => null, () => ({}));
  const s = new Session(mgr, { id, cwd: tmp, sdkSessionId: 'sdk_broken', title: '恢复测试' });
  const q = throwingQuery('No message found with message.uuid: abc');
  s.q = q;
  s._resumeQuery = q;
  s.running = true;
  s.busy = true;

  await s._pump();

  assert.strictEqual(s.meta.sdkSessionId, null);
  assert.ok(s.meta.resumeLostAt, '应记录 SDK 上下文降级时间');
  assert.strictEqual(store.listSessions().find((m) => m.id === id).sdkSessionId, null);
  assert.ok(store.readSessionEvents(id).some((e) => e.type === 'ui_user_input' && e.content === '此前的可见历史'), '本地回放历史不可丢失');
  assert.ok(store.readSessionEvents(id).some((e) => e.type === 'ui_error' && /无法恢复/.test(e.message)), '应持久化恢复说明');
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.busy, false);
});

test('非恢复 query 的同类错误不清除当前 SDK 锚点', async () => {
  const id = 's_not_resume';
  store.upsertSession({ id, cwd: tmp, sdkSessionId: 'sdk_keep' });
  const sent = [];
  const mgr = new SessionManager(() => ({ isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } }), () => ({}));
  const s = new Session(mgr, { id, cwd: tmp, sdkSessionId: 'sdk_keep' });
  const q = throwingQuery('No message found with message.uuid: unrelated');
  s.q = q;
  s.running = true;

  await s._pump();

  assert.strictEqual(s.meta.sdkSessionId, 'sdk_keep');
  assert.ok(sent.some((p) => p.payload && p.payload.ev && p.payload.ev.type === 'ui_error' && /会话异常终止/.test(p.payload.ev.message)));
});
