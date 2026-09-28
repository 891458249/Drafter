const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installElectronStub } = require('./helpers/electron-stub');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-compaction-test-'));
installElectronStub(tmp);
const { Session } = require('../src/main/sessions');
const { compactionSettings, compactionEnv } = require('../src/main/context-compaction');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('compaction window follows the model real window, capped at the SDK proactive limit', () => {
  assert.deepEqual(compactionSettings('deepseek-chat'), { autoCompactEnabled: true, autoCompactWindow: 131072 });
  // v0.15.20:去掉 v0.15.10~0.15.19 的 Math.min(…, 200000) 钳位——它把 1M 模型压成
  // 200K,压缩在 187000 token(圈上 ≈18.7%)就触发,PCT_OVERRIDE=100 对它无效。
  assert.equal(compactionSettings('glm-4.6').autoCompactWindow, 204800);
  // 但上限只能到 1000000:实测窗口 >1000000 时 SDK 完全不做主动压缩
  // (1000000 触发 / 1000001 不触发),放行真实 1M 窗口等于把主力模型的主动压缩关掉。
  assert.equal(compactionSettings('claude-fable-5').autoCompactWindow, 1000000);
  assert.equal(compactionSettings('gpt-6-astra').autoCompactWindow, 1000000);
  assert.equal(compactionSettings('grok-4-fast').autoCompactWindow, 1000000);
  // 表未命中(不认识该模型)才退回 200000
  assert.deepEqual(compactionSettings('unknown'), { autoCompactEnabled: true, autoCompactWindow: 200000 });
  // v0.15.17:自动压缩只在 100% 触发,环境里其它变量原样保留;任何更低覆盖值都被顶成 100
  assert.deepEqual(compactionEnv({ SECRET: 'preserved' }), { SECRET: 'preserved', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '100' });
  assert.equal(compactionEnv({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' }).CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '100');
  assert.equal(compactionEnv({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '100' }).CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '100');
});
test('SDK compact status and boundary are forwarded without finishing the turn', () => {
  const events = [];
  const session = { busy: true, _emit: (e) => events.push(e) };
  Session.prototype._handleMessage.call(session, { type: 'system', subtype: 'status', status: 'compacting' });
  assert.equal(session.compacting, true);
  assert.equal(session.busy, true);
  Session.prototype._handleMessage.call(session, { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'network' });
  assert.equal(session.compacting, false);
  assert.equal(events[1].error, 'network');
  Session.prototype._handleMessage.call(session, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } });
  assert.equal(events[2].type, 'ui_compact');
  assert.equal(events[2].trigger, 'auto');
  assert.equal(session.busy, true);
});
test('Harness gets known model windows without inventing unknown capacity', () => {
  const { keyToProvider } = require('../src/main/harness/keys-bridge');
  const provider = keyToProvider({ id: 'k', models: ['deepseek-chat', 'kimi-k3', 'private-model'] });
  assert.deepEqual(provider.models, [{ id: 'deepseek-chat', contextWindow: 131072 }, { id: 'kimi-k3', contextWindow: 1048576 }, { id: 'private-model' }]);
});
