// 会话级子 Agent 模型:构造 SDK AgentDefinition、禁用空配置、持久化与安全重启。
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-agent-models-test-'));
installElectronStub(tmp);
// 守卫的 resume 核实会读子 Agent transcript;隔离 CLAUDE_CONFIG_DIR,绝不碰真实 ~/.claude
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, '.claude');
const store = require('../src/main/store');
const keys = require('../src/main/keys');
const { SessionManager, Session, normalizeAgentModels, buildSessionAgents, transcriptPath } = require('../src/main/sessions');
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

test('空子 Agent 列表同时禁用 Agent/Task/Workflow/SendMessage', () => {
  const built = buildSessionAgents({ keyId: 'k1', model: 'gpt-5.6-sol', agentModels: [] });
  assert.deepStrictEqual(built.disallowedTools, ['Agent', 'Task', 'Workflow', 'SendMessage']);
  assert.strictEqual(built.allowedAgents.size, 0);
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
  assert.deepStrictEqual([...built.allowedAgents.values()], ['claude-sonnet-5', 'claude-haiku-4-5']);
  for (const def of Object.values(built.agents)) {
    assert.ok(def.description);
    assert.ok(def.prompt);
    // 防嵌套委派:子 Agent 不得再派生/驱动下级任务(嵌套会绕开白名单)
    assert.deepStrictEqual(def.disallowedTools, ['Agent', 'Task', 'Workflow', 'SendMessage']);
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

// --- 委派守卫(PreToolUse 硬白名单) ---

function makeGuardedSession({ agentModels = [{ keyId: 'k1', model: 'claude-haiku-4-5' }], sdkSessionId = null } = {}) {
  const { mgr, session } = makeSession({ agentModels, keyId: 'k1', model: 'gpt-5.6-sol' });
  const built = buildSessionAgents(session.meta);
  session._agentRoute = { allowed: built.allowedAgents, spawned: new Map() };
  session.meta.sdkSessionId = sdkSessionId;
  return { mgr, session };
}

function denied(res) {
  return !!(res && res.hookSpecificOutput && res.hookSpecificOutput.permissionDecision === 'deny');
}
function routeEvents(session) {
  return store.readSessionEvents(session.id).filter((e) => e.type === 'ui_agent_route');
}

test('守卫:内置 Explore + 显式 sonnet 被拒(实测 HARU 的越权路径)', async () => {
  const { session } = makeGuardedSession();
  const res = await session._guardDelegation({
    tool_name: 'Agent', tool_use_id: 'tu_1',
    tool_input: { subagent_type: 'Explore', model: 'sonnet', prompt: '调查' },
  });
  assert.ok(denied(res));
  const evs = routeEvents(session);
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].action, 'deny');
  assert.strictEqual(evs[0].agentType, 'Explore');
  assert.strictEqual(evs[0].requestedModel, 'sonnet');
});

test('守卫:未指定 subagent_type(默认内置)被拒并列出可用 Agent', async () => {
  const { session } = makeGuardedSession();
  const res = await session._guardDelegation({ tool_name: 'Agent', tool_use_id: 'tu_1', tool_input: { prompt: '干一件事' } });
  assert.ok(denied(res));
  assert.ok(res.hookSpecificOutput.permissionDecisionReason.includes('model-claude-haiku-4-5'));
});

test('守卫:已注册类型无 model 覆盖 → 放行并登记派发记录', async () => {
  const { session } = makeGuardedSession();
  const res = await session._guardDelegation({
    tool_name: 'Agent', tool_use_id: 'tu_ok',
    tool_input: { subagent_type: 'model-claude-haiku-4-5', prompt: '做一件事' },
  });
  assert.deepStrictEqual(res, {});
  assert.strictEqual(session._agentRoute.spawned.get('tu_ok'), 'claude-haiku-4-5');
  assert.strictEqual(routeEvents(session)[0].action, 'allow');
});

test('守卫:已注册类型另行指定其他模型 → 拒绝覆盖', async () => {
  const { session } = makeGuardedSession();
  const res = await session._guardDelegation({
    tool_name: 'Task', tool_use_id: 'tu_2',
    tool_input: { subagent_type: 'model-claude-haiku-4-5', model: 'claude-sonnet-5' },
  });
  assert.ok(denied(res));
  assert.ok(res.hookSpecificOutput.permissionDecisionReason.includes('claude-haiku-4-5'));
});

test('守卫:回合中取消勾选立即对新调用生效(不等重启)', async () => {
  const { session } = makeGuardedSession();
  const input = { subagent_type: 'model-claude-haiku-4-5', prompt: 'x' };
  assert.deepStrictEqual(await session._guardDelegation({ tool_name: 'Agent', tool_use_id: 'a', tool_input: input }), {});
  session.meta.agentModels = []; // 用户在回合中取消勾选
  assert.ok(denied(await session._guardDelegation({ tool_name: 'Agent', tool_use_id: 'b', tool_input: input })));
});

test('守卫:Workflow 一律拒绝(脚本内部派生绕开白名单)', async () => {
  const { session } = makeGuardedSession();
  assert.ok(denied(await session._guardDelegation({ tool_name: 'Workflow', tool_use_id: 'w', tool_input: { script: 'x' } })));
});

test('守卫:SendMessage 续聊必须能核实模型;PostToolUse 捕获 agentId', async () => {
  const { session } = makeGuardedSession();
  // 未知目标(旧配置/旧版本子任务)→ fail closed
  assert.ok(denied(await session._guardDelegation({ tool_name: 'SendMessage', tool_use_id: 'm1', tool_input: { to: 'a8d1a7cf0bd65d932', message: 'x' } })));
  // 本 query 派发:tool_use_id → 模型;Agent 结果带 agentId → 捕获映射
  await session._guardDelegation({ tool_name: 'Agent', tool_use_id: 'tu_9', tool_input: { subagent_type: 'model-claude-haiku-4-5', prompt: 'x' } });
  await session._trackSpawnedAgent({ tool_name: 'Agent', tool_use_id: 'tu_9', tool_response: '完成了。agentId: abc123' });
  assert.deepStrictEqual(await session._guardDelegation({ tool_name: 'SendMessage', tool_use_id: 'm2', tool_input: { to: 'abc123', message: '继续' } }), {});
  // 取消勾选后,同一 agentId 的续聊立即被拒
  session.meta.agentModels = [];
  assert.ok(denied(await session._guardDelegation({ tool_name: 'SendMessage', tool_use_id: 'm3', tool_input: { to: 'abc123', message: '继续' } })));
});

test('守卫:resume 跨重启经 transcript 核实实际模型', async () => {
  const { session } = makeGuardedSession({ sdkSessionId: 'sdk_guard' });
  const base = transcriptPath('sdk_guard', session.meta.cwd);
  const dir = path.join(path.dirname(base), 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'agent-old1.jsonl');
  // 首条 <synthetic> 占位不应误读为模型
  fs.writeFileSync(f, JSON.stringify({ message: { role: 'assistant', model: '<synthetic>' } }) + '\n'
    + JSON.stringify({ message: { role: 'assistant', model: 'claude-haiku-4-5' } }) + '\n');
  const ok = await session._guardDelegation({
    tool_name: 'Agent', tool_use_id: 'r1',
    tool_input: { subagent_type: 'model-claude-haiku-4-5', resume: 'old1', prompt: '继续' },
  });
  assert.deepStrictEqual(ok, {});
  // 旧 Sonnet 子任务:与定义固定模型不一致 → 拒绝唤醒
  fs.writeFileSync(f, JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-5' } }) + '\n');
  const no = await session._guardDelegation({
    tool_name: 'Agent', tool_use_id: 'r2',
    tool_input: { subagent_type: 'model-claude-haiku-4-5', resume: 'old1', prompt: '继续' },
  });
  assert.ok(denied(no));
});

test('result 按 modelUsage 拆到真实执行模型;无明细回退主模型', () => {
  const { session } = makeSession();
  session._handleMessage({
    type: 'result', session_id: 'sdk_1', is_error: false,
    usage: { input_tokens: 1000, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.5,
    modelUsage: {
      'gpt-5.6-sol': { inputTokens: 600, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.3, contextWindow: 1000 },
      'claude-sonnet-5': { inputTokens: 400, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.2, contextWindow: 1000 },
    },
  });
  const data = JSON.parse(fs.readFileSync(path.join(tmp, 'drafter-store.json'), 'utf8'));
  assert.strictEqual(data.modelUsage['gpt-5.6-sol'].input, 600);
  assert.strictEqual(data.modelUsage['gpt-5.6-sol'].output, 100);
  assert.strictEqual(data.modelUsage['claude-sonnet-5'].input, 400);
  assert.strictEqual(data.modelUsage['claude-sonnet-5'].output, 50);
  assert.ok(Math.abs(data.modelUsage['claude-sonnet-5'].cost - 0.2) < 1e-9);
  // 旧格式(无 modelUsage)回退主模型,不重复拆账
  session._handleMessage({ type: 'result', session_id: 'sdk_1', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 });
  const data2 = JSON.parse(fs.readFileSync(path.join(tmp, 'drafter-store.json'), 'utf8'));
  assert.strictEqual(data2.modelUsage['gpt-5.6-sol'].input, 610);
});
