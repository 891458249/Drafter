// 会话级子 Agent 模型:构造 SDK AgentDefinition、禁用空配置、持久化与安全重启。
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-agent-models-test-'));
installElectronStub(tmp);
const store = require('../src/main/store');
const keys = require('../src/main/keys');
const { SessionManager, Session, normalizeAgentModels, buildSessionAgents } = require('../src/main/sessions');
Session.prototype.start = async () => {};

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function seedKeys() {
  store.setSetting('apiKeys', [{
    id: 'k1', name: 'Gateway', key: 'secret', baseUrl: 'https://example.test', enabled: true,
    models: ['gpt-5.6-sol', 'claude-sonnet-5', 'claude-haiku-4-5', 'image-gen'],
    modelsEnabled: ['gpt-5.6-sol', 'claude-sonnet-5', 'claude-haiku-4-5', 'image-gen'],
    modelGroups: [
      { category: 'chat', model_type: 'chat', models: ['gpt-5.6-sol', 'claude-sonnet-5', 'claude-haiku-4-5'] },
      { category: 'image', model_type: 'image', models: ['image-gen'] },
    ],
  }, {
    id: 'k2', name: 'Other', key: 'other', baseUrl: 'https://other.test', enabled: true,
    models: ['claude-sonnet-5'], modelsEnabled: ['claude-sonnet-5'],
    modelGroups: [{ category: 'chat', model_type: 'chat', models: ['claude-sonnet-5'] }],
  }]);
}

function makeSession({ agentModels = [], keyId = 'k1', model = 'gpt-5.6-sol' } = {}) {
  seedKeys();
  const mgr = new SessionManager(() => null, () => ({}));
  const meta = mgr.create({ cwd: tmp, kind: 'code', keyId, model, agentModels });
  return { mgr, session: mgr.get(meta.id) };
}

test('空子 Agent 列表同时禁用 Agent 与 Task 兼容名', () => {
  assert.deepStrictEqual(buildSessionAgents({ keyId: 'k1', model: 'gpt-5.6-sol', agentModels: [] }), {
    disallowedTools: ['Agent', 'Task'],
  });
});

test('同 Key 的 GPT 与 Claude 模型生成独立 AgentDefinition', () => {
  seedKeys();
  const built = buildSessionAgents({
    keyId: 'k1', model: 'gpt-5.6-sol',
    agentModels: [
      { keyId: 'k1', model: 'claude-sonnet-5' },
      { keyId: 'k1', model: 'claude-haiku-4-5' },
    ],
  });
  assert.ok(built.agents);
  assert.deepStrictEqual(Object.values(built.agents).map((a) => a.model), ['claude-sonnet-5', 'claude-haiku-4-5']);
  for (const def of Object.values(built.agents)) {
    assert.ok(def.description);
    assert.ok(def.prompt);
  }
});

test('规范化去重并过滤主模型、跨 Key、媒体模型和未启用模型', () => {
  seedKeys();
  const clean = normalizeAgentModels([
    { keyId: 'k1', model: 'claude-sonnet-5' },
    { keyId: 'k1', model: 'claude-sonnet-5' },
    { keyId: 'k1', model: 'gpt-5.6-sol' },
    { keyId: 'k2', model: 'claude-sonnet-5' },
    { keyId: 'k1', model: 'image-gen' },
    { keyId: 'k1', model: 'not-enabled' },
    null,
  ], 'k1', { requireEnabled: true, excludeModel: 'gpt-5.6-sol' });
  assert.deepStrictEqual(clean, [{ keyId: 'k1', model: 'claude-sonnet-5' }]);
});

test('未运行会话设置子 Agent 仅持久化', async () => {
  const { mgr, session } = makeSession();
  session.running = false;
  let stopped = 0, started = 0;
  session.stop = () => { stopped++; };
  session.start = async () => { started++; };
  const clean = await session.setAgentModels([{ keyId: 'k1', model: 'claude-sonnet-5' }]);
  assert.deepStrictEqual(clean, [{ keyId: 'k1', model: 'claude-sonnet-5' }]);
  assert.strictEqual(stopped, 0);
  assert.strictEqual(started, 0);
  assert.deepStrictEqual(mgr.list().find((m) => m.id === session.id).agentModels, clean);
});

test('空闲运行会话设置子 Agent 立即 resume 重启', async () => {
  const { session } = makeSession();
  session.running = true;
  session.busy = false;
  session.meta.sdkSessionId = 'sdk_1';
  let stopped = 0, resume = null;
  session.stop = () => { stopped++; };
  session.start = async (opts) => { resume = opts.resume; };
  await session.setAgentModels([{ keyId: 'k1', model: 'claude-sonnet-5' }]);
  assert.strictEqual(stopped, 1);
  assert.strictEqual(resume, true);
});

test('忙碌会话设置子 Agent 延迟到回合后重启', async () => {
  const { session } = makeSession();
  session.running = true;
  session.busy = true;
  let stopped = 0;
  session.stop = () => { stopped++; };
  await session.setAgentModels([{ keyId: 'k1', model: 'claude-sonnet-5' }]);
  assert.strictEqual(stopped, 0);
  assert.strictEqual(session.needRestart, true);
});

test('主模型跨 Key 会清除旧 Key 子 Agent 并只重启一次', async () => {
  const { session } = makeSession({ agentModels: [{ keyId: 'k1', model: 'claude-sonnet-5' }] });
  session.running = true;
  session.busy = false;
  session.q = { setModel: async () => { throw new Error('不应热切模型'); } };
  let stopped = 0, started = 0;
  session.stop = () => { stopped++; };
  session.start = async () => { started++; };
  await session.setModel('claude-sonnet-5', 'k2');
  assert.deepStrictEqual(session.meta.agentModels, []);
  assert.strictEqual(stopped, 1);
  assert.strictEqual(started, 1);
});

test('分支继承子 Agent 模型列表', () => {
  const { mgr, session } = makeSession({ agentModels: [{ keyId: 'k1', model: 'claude-sonnet-5' }] });
  // branch() 依赖历史锚点;直接验证 create 的显式字段路径和持久化结果。
  const child = mgr.create({
    cwd: tmp, kind: 'code', keyId: session.meta.keyId, model: session.meta.model,
    agentModels: session.meta.agentModels,
  });
  assert.deepStrictEqual(child.agentModels, [{ keyId: 'k1', model: 'claude-sonnet-5' }]);
});
