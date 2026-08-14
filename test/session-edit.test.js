// store.js 会话历史编辑(v0.9.9):locateEcho 锚点定位 / branchSlice 分支切片 / writeSessionEvents
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-session-edit-test-'));
installElectronStub(tmp);
const store = require('../src/main/store');

const SID = 's_edit_test';

function seed(events) {
  for (const e of events) store.appendSessionEvent(SID, e);
}

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('locateEcho:定位 echo,prevUuid 偏好最近的 assistant 锚点', () => {
  seed([
    { type: 'ui_user_input', uuid: 'u1', content: '第一条' },
    { type: 'assistant', uuid: 'a1', message: { content: [] } },
    { type: 'user', uuid: 'tr1', message: { content: [{ type: 'tool_result' }] } },
    { type: 'assistant', uuid: 'a2', message: { content: [] } },
    { type: 'ui_user_input', uuid: 'u2', content: '第二条' },
    { type: 'assistant', uuid: 'a3', message: { content: [] } },
  ]);
  const loc = store.locateEcho(SID, 'u2');
  assert.strictEqual(loc.ok, true);
  assert.strictEqual(loc.index, 4);
  assert.strictEqual(loc.prevUuid, 'a2', '锚点应是 echo 之前最近的 assistant');
  assert.strictEqual(loc.isFirst, false);
});

test('locateEcho:echo 前无 assistant 时退化为 user 锚点;首条消息无锚点但 isFirst 标记', () => {
  seed([
    { type: 'ui_user_input', uuid: 'u1', content: '第一条' },
    { type: 'user', uuid: 'tr1', message: { content: [] } },
    { type: 'ui_user_input', uuid: 'u2', content: '第二条' },
  ]);
  const loc = store.locateEcho(SID, 'u2');
  assert.strictEqual(loc.prevUuid, 'tr1');
  const first = store.locateEcho(SID, 'u1');
  assert.strictEqual(first.prevUuid, null);
  assert.strictEqual(first.isFirst, true);
});

test('locateEcho:找不到 echo 时返回错误(旧版本消息无锚点)', () => {
  seed([{ type: 'ui_user_input', content: '旧消息无 uuid' }]);
  const loc = store.locateEcho(SID, 'missing');
  assert.strictEqual(loc.ok, false);
  assert.match(loc.error, /锚点/);
});

test('branchSlice:切片到目标 echo 回合结束(下一条 echo 之前),锚点含其回复', () => {
  const events = [
    { type: 'ui_user_input', uuid: 'u1', content: '第一条' },
    { type: 'assistant', uuid: 'a1', message: {} },
    { type: 'result', subtype: 'success' },
    { type: 'ui_user_input', uuid: 'u2', content: '第二条' },
    { type: 'assistant', uuid: 'a2', message: {} },
    { type: 'ui_user_input', uuid: 'u3', content: '第三条' },
    { type: 'assistant', uuid: 'a3', message: {} },
  ];
  // 从 u1 分支:含 u1 回合(a1+result),不含 u2 之后
  let s = store.branchSlice(events, 0);
  assert.strictEqual(s.prefix.length, 3);
  assert.strictEqual(s.anchorUuid, 'a1');
  // 从 u2 分支:含 u1、u2 两回合,u3 之后被切掉
  s = store.branchSlice(events, 3);
  assert.strictEqual(s.prefix.length, 5);
  assert.strictEqual(s.anchorUuid, 'a2');
  // 从最后一条 echo 分支:切到日志末尾
  s = store.branchSlice(events, 5);
  assert.strictEqual(s.prefix.length, 7);
  assert.strictEqual(s.anchorUuid, 'a3');
});

test('branchSlice:回合内只有 echo(ui_user_input 不算 SDK 锚点)时 anchorUuid 为 null', () => {
  const events = [
    { type: 'ui_user_input', uuid: 'u1', content: 'hello' },
  ];
  const s = store.branchSlice(events, 0);
  assert.strictEqual(s.anchorUuid, null, 'lastAnchor 只认 assistant/user 事件,纯 echo 无 SDK 锚点');
});

test('writeSessionEvents:整文件重写,编辑后的内容替换到位', () => {
  seed([
    { type: 'ui_user_input', uuid: 'u1', content: '原文' },
    { type: 'assistant', uuid: 'a1', message: {} },
  ]);
  const loc = store.locateEcho(SID, 'u1');
  const kept = [...loc.events.slice(0, loc.index), { ...loc.events[loc.index], content: '改后' }];
  assert.strictEqual(store.writeSessionEvents(SID, kept), true);
  const reread = store.readSessionEvents(SID, Number.MAX_SAFE_INTEGER);
  assert.strictEqual(reread.length, 1, 'echo 之后的事件被截断');
  assert.strictEqual(reread[0].content, '改后');
  assert.strictEqual(reread[0].uuid, 'u1', '锚点 uuid 保留');
});
