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

test('compaction enabled with conservative budget, preserves earlier triggers and env', () => {
  assert.deepEqual(compactionSettings('deepseek-chat'), { autoCompactEnabled: true, autoCompactWindow: 131072 });
  assert.equal(compactionSettings('gpt-6-astra').autoCompactWindow, 200000);
  assert.equal(compactionSettings('unknown').autoCompactEnabled, true);
  assert.deepEqual(compactionEnv({ SECRET: 'preserved', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' }), { SECRET: 'preserved', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' });
  assert.equal(compactionEnv({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '100' }).CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '80');
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
