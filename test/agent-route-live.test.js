// 协议级回归:真实 Agent SDK + claude.exe 对本地模拟 Messages 网关。
// 验证委派守卫在真实运行时(非单测直调)拦截「内置 Agent + sonnet 覆盖」的实测
// 越权路径,且合法子 Agent 以注册模型真实发出请求。全部打本地 127.0.0.1 假网关,
// 零真实付费请求;CLAUDE_CONFIG_DIR/userData/cwd 全部隔离,不碰真实数据。
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-agent-route-live-'));
installElectronStub(tmp);
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, '.claude');
const store = require('../src/main/store');
const modelGuard = require('../src/main/model-guard-proxy');
const { SessionManager } = require('../src/main/sessions');
const extensions = require('../src/main/extensions');

before(() => modelGuard.start());
after(async () => { await modelGuard.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

store.setSetting('apiKeys', [{
  id: 'k1', name: 'Fake', key: 'fake', baseUrl: 'http://127.0.0.1', enabled: true,
  models: ['gpt-6-astra', 'gpt-5.4'], modelsEnabled: ['gpt-6-astra', 'gpt-5.4'],
  modelGroups: [{ category: 'chat', model_type: 'chat', models: ['gpt-6-astra', 'gpt-5.4'] }],
}]);

// --- 假网关:按脚本回 SSE,记录每个请求的真实 model ---

function sseText(model, text) {
  return [
    ['message_start', { type: 'message_start', message: { id: 'msg_' + Math.random().toString(36).slice(2), type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

function sseToolUse(model, id, name, input) {
  return [
    ['message_start', { type: 'message_start', message: { id: 'msg_' + Math.random().toString(36).slice(2), type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

// script(req, rawBody, n) → SSE 字符串;n 为第几个 messages 请求(1 起)
function startGateway(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":1}');
        return;
      }
      if (!req.url.includes('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"fake"}}');
        return;
      }
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      requests.push({ model: body.model, raw });
      let out;
      try { out = script(body, raw, requests.length); }
      catch (e) { out = sseText(body.model || 'unknown', '(script error: ' + e.message + ')'); }
      if (out && typeof out === 'object') {
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(out);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

function makeManager(port) {
  // 代理按 Key 存储的 baseUrl 决定真实上游;测试启动前把假网关端口写回 Key。
  const apiKeys = (store.getSetting('apiKeys') || []).map((k) => ({ ...k, baseUrl: `http://127.0.0.1:${port}` }));
  store.setSetting('apiKeys', apiKeys);
  const events = [];
  const mgr = new SessionManager(() => null, (extra) => ({
    ...process.env, ...extra,
    ANTHROPIC_BASE_URL: extra.__modelGuardBaseUrl || `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: 'fake',
    ANTHROPIC_API_KEY: '',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  }));
  mgr.send = (ch, payload) => { if (ch === 'sess:event') events.push(payload); };
  return { mgr, events };
}

async function waitResult(events, ms = 75000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find((p) => p.ev && p.ev.type === 'result');
    if (hit) return hit.ev;
    const err = events.find((p) => p.ev && p.ev.type === 'ui_error');
    if (err) throw new Error('会话报错: ' + err.ev.message);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('等待 result 超时');
}

for (const kind of ['code', 'chat']) test(`真实运行时:${kind} 自动压缩后保持会话继续对话`, { timeout: 90000 }, async () => {
  let mainRequests = 0;
  const gw = await startGateway((body) => {
    if (/Write the title in the predominant language/.test(JSON.stringify(body.messages))) return sseText(body.model, 'title');
    mainRequests++;
    const response = sseText(body.model, '记住项目暗号 ORCHID。继续任务。');
    return mainRequests === 6 ? response.replace('"input_tokens":10', '"input_tokens":190000') : response;
  });
  const { mgr, events } = makeManager(gw.port);
  const cwd = path.join(tmp, 'compact-' + kind);
  fs.mkdirSync(cwd, { recursive: true });
  const meta = mgr.create({ cwd, kind, keyId: 'k1', model: 'gpt-6-astra', permissionMode: 'bypassPermissions' });
  const s = mgr.get(meta.id);
  try {
    for (let i = 0; i < 6; i++) {
      events.length = 0;
      s.send('记住项目暗号 ORCHID，然后回复收到。第' + i + '轮 ' + '历史工作记录。'.repeat(1000));
      await waitResult(events);
    }
    const sessionId = s.meta.sdkSessionId;
    const firstEvents = [...events];
    events.length = 0;
    s.send('暗号是什么？继续任务。');
    await waitResult(events);
    assert.ok([...firstEvents, ...events].some((e) => e.ev.type === 'ui_compact'), '应收到真实自动压缩边界; 请求数=' + gw.requests.length + ';事件=' + JSON.stringify([...firstEvents, ...events].map((e) => e.ev)));
    assert.equal(s.meta.sdkSessionId, sessionId);
    assert.ok(gw.requests.length >= 3, '应包括摘要请求和压缩后回复');
    assert.ok(gw.requests.at(-1).raw.includes('ORCHID'));
    assert.equal(s.busy, false);
  } finally { s.stop(); await s._debugCleanup?.cleanup(); gw.server.close(); }
});

for (const kind of ['code', 'chat']) test(`真实运行时:${kind} 提供方拒绝超长上下文后自动恢复`, { timeout: 90000 }, async () => {
  let rejected = false;
  const gw = await startGateway((body) => {
    if (/Write the title in the predominant language/.test(JSON.stringify(body.messages))) return sseText(body.model, 'title');
    if (!rejected && JSON.stringify(body.messages).includes('触发溢出')) {
      rejected = true;
      return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } } };
    }
    return sseText(body.model, '项目暗号 ORCHID，已保留任务。');
  });
  const { mgr, events } = makeManager(gw.port);
  const cwd = path.join(tmp, 'overflow-' + kind);
  fs.mkdirSync(cwd, { recursive: true });
  const meta = mgr.create({ cwd, kind, keyId: 'k1', model: 'gpt-6-astra', permissionMode: 'bypassPermissions' });
  const s = mgr.get(meta.id);
  try {
    for (let i = 0; i < 6; i++) { events.length = 0; s.send('ORCHID 工作记录' + i + '历史。'.repeat(1000)); await waitResult(events); }
    const sessionId = s.meta.sdkSessionId;
    events.length = 0;
    s.send('触发溢出：请继续任务');
    const result = await waitResult(events);
    assert.equal(rejected, true);
    assert.equal(result.is_error, false, JSON.stringify(result));
    assert.ok(events.some((e) => e.ev.type === 'ui_compact'));
    assert.equal(s.meta.sdkSessionId, sessionId);
  } finally { s.stop(); await s._debugCleanup?.cleanup(); gw.server.close(); }
});

test('真实运行时:极速聊天手动压缩后可继续，失败不清空会话', { timeout: 90000 }, async () => {
  let reject = false;
  const gw = await startGateway((body) => {
    if (reject && !/Write the title/.test(JSON.stringify(body.messages))) return { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'fake auth failure' } } };
    return sseText(body.model, '项目 ORCHID 的摘要与回复。');
  });
  const { mgr, events } = makeManager(gw.port);
  const cwd = path.join(tmp, 'manual-compact'); fs.mkdirSync(cwd, { recursive: true });
  const meta = mgr.create({ cwd, kind: 'chat', keyId: 'k1', model: 'gpt-6-astra', permissionMode: 'bypassPermissions' });
  const s = mgr.get(meta.id);
  try {
    for (let i = 0; i < 4; i++) { events.length = 0; s.send('ORCHID 记录' + i + '工作内容。'.repeat(1000)); await waitResult(events); }
    const sessionId = s.meta.sdkSessionId;
    events.length = 0; s.send('/compact');
    const compactResult = await waitResult(events).catch((e) => { console.log('COMPACT DEBUG', JSON.stringify(events.map((x) => x.ev && { type: x.ev.type, subtype: x.ev.subtype, raw: x.ev.raw && x.ev.raw.type || x.ev.raw }))); throw e; });
    void compactResult;
    assert.ok(events.some((e) => e.ev.type === 'ui_compact'));
    assert.equal(s.meta.sdkSessionId, sessionId);
    events.length = 0; reject = true; s.send('失败测试');
    await new Promise((r) => setTimeout(r, 8000));
    const lateCompact = events.filter((e) => e.ev.type === 'ui_compact' || e.ev.type === 'ui_compacting');
    assert.deepEqual(lateCompact, [], '401 不能触发上下文溢出重试;实际事件=' + JSON.stringify(events.map((e) => e.ev && { t: e.ev.type, st: e.ev.subtype, active: e.ev.active, res: e.ev.result, err: e.ev.error, result: e.ev.result && typeof e.ev.result === 'string' ? e.ev.result.slice(0, 80) : undefined, trigger: e.ev.trigger })));
    await s.interrupt(); // 引擎对 401 会静默重试数分钟(v0.15.1 已知);中断后会话必须仍可用
    await waitResult(events, 15000).catch(() => {}); // 等被中断回合的终态 result 到达再清事件
    reject = false; events.length = 0; s.send('继续 ORCHID');
    assert.equal((await waitResult(events)).is_error, false);
    assert.equal(s.meta.sdkSessionId, sessionId);
  } finally { s.stop(); gw.server.close(); }
});

test('真实运行时:Stop 与用户 interrupt 都释放登记的调试连接', { timeout: 90000 }, async () => {
  const resources = require('../src/main/debug-resources');
  let releaseCount = 0;
  const gw = await startGateway((body) => sseText(body.model, '调试结束'));
  const { mgr, events } = makeManager(gw.port);
  const cwd = path.join(tmp, 'debug-stop');
  fs.mkdirSync(cwd, { recursive: true });
  const meta = mgr.create({ cwd, kind: 'code', keyId: 'k1', model: 'gpt-6-astra', permissionMode: 'bypassPermissions' });
  const s = mgr.get(meta.id);
  try {
    await s.start();
    const startedAt = Date.now();
    while (!s._debugCleanup && Date.now() - startedAt < 10000) await new Promise((r) => setTimeout(r, 25));
    const scope = JSON.parse(s._debugCleanup.prompt.match(/--scope ("[^"]+")/)[1]);
    resources.attach(scope, { name: 'stop connection', release: () => releaseCount++, verify: () => true });
    s.send('完成');
    await waitResult(events);
    assert.equal(releaseCount, 1, '真实 Stop hook 应先释放再结束回合');
    resources.attach(scope, { name: 'interrupt connection', release: () => releaseCount++, verify: () => true });
    s.busy = true;
    await s.interrupt();
    assert.equal(releaseCount, 2);
  } finally { s.stop(); await s._debugCleanup?.cleanup(); gw.server.close(); }
});

test('真实运行时:bypass 模式下只读项目的 Bash 写入由 PreToolUse 阻止', { timeout: 90000 }, async () => {
  const cwd = path.join(tmp, 'case-readonly');
  fs.mkdirSync(cwd, { recursive: true });
  const locked = path.join(cwd, 'locked.txt');
  fs.writeFileSync(locked, 'preserve');
  store.upsertProject({ id: 'readonly-live', dirs: [cwd], files: [{ path: locked, tag: 'readonly' }] });
  const gw = await startGateway((body, raw) => raw.includes('tool_result')
    ? sseText(body.model, '操作已阻止。')
    : sseToolUse(body.model, 'toolu_ro', 'Bash', { command: 'echo changed > locked.txt' }));
  const { mgr, events } = makeManager(gw.port);
  const meta = mgr.create({ cwd, projectId: 'readonly-live', kind: 'code', keyId: 'k1', model: 'gpt-6-astra', permissionMode: 'bypassPermissions' });
  const s = mgr.get(meta.id);
  try {
    s.send('执行任务');
    await waitResult(events);
    assert.equal(fs.readFileSync(locked, 'utf8'), 'preserve');
    assert.ok(gw.requests.some((r) => r.raw.includes('tool_result') && r.raw.includes('只读')), '拒绝原因必须通过真实工具回路返回');
  } finally { s.stop(); gw.server.close(); }
});

test('真实运行时:内置 Explore + sonnet 覆盖被守卫拦截,网关未收到任何 Claude 请求', { timeout: 90000 }, async () => {
  const gw = await startGateway((body, raw, n) => {
    if (n === 1) {
      // 主模型决定委派:内置 Explore + 显式 sonnet(HARU 实测越权路径)
      return sseToolUse(body.model, 'toolu_1', 'Agent', { subagent_type: 'Explore', model: 'sonnet', prompt: '调查一下', description: 't' });
    }
    return sseText(body.model, '明白,已改用直接回答。');
  });
  const { mgr, events } = makeManager(gw.port);
  const cwd = path.join(tmp, 'case-deny');
  fs.mkdirSync(cwd, { recursive: true });
  const meta = mgr.create({
    cwd, kind: 'code', keyId: 'k1', model: 'gpt-6-astra',
    agentModels: [{ keyId: 'k1', model: 'gpt-5.4' }],
    permissionMode: 'bypassPermissions',
  });
  const s = mgr.get(meta.id);
  try {
    s.send('请处理这个任务');
    await waitResult(events);
    assert.ok(gw.requests.length >= 2, '应有第二轮带 tool_result 的请求');
    for (const r of gw.requests) {
      assert.ok(!/sonnet|claude/i.test(r.model || ''), '不得向网关发出未勾选模型的请求:' + r.model);
    }
    assert.ok(gw.requests.some((r) => r.raw.includes('tool_result') && r.raw.includes('启用列表')), '拒绝原因应随 tool_result 回到主模型');
    const route = store.readSessionEvents(meta.id).filter((e) => e.type === 'ui_agent_route');
    assert.ok(route.some((e) => e.action === 'deny' && e.agentType === 'Explore'), '应有 deny 审计事件');
  } finally {
    try { s.stop(); } catch {}
    gw.server.close();
  }
});

test('真实运行时:合法子 Agent 以注册模型发出请求,绕过尝试被拒', { timeout: 90000 }, async () => {
  const gw = await startGateway((body, raw) => {
    if (body.model === 'gpt-5.4') return sseText('gpt-5.4', '子任务完成'); // 子 Agent 请求
    if (raw.includes('tool_result')) return sseText(body.model, '主流程结束');
    return sseToolUse(body.model, 'toolu_1', 'Agent', { subagent_type: 'model-gpt-5-4', prompt: '回复 ok', description: 't' });
  });
  const { mgr, events } = makeManager(gw.port);
  const cwd = path.join(tmp, 'case-allow');
  fs.mkdirSync(cwd, { recursive: true });
  const meta = mgr.create({
    cwd, kind: 'code', keyId: 'k1', model: 'gpt-6-astra',
    agentModels: [{ keyId: 'k1', model: 'gpt-5.4' }],
    permissionMode: 'bypassPermissions',
  });
  const s = mgr.get(meta.id);
  try {
    s.send('请处理这个任务');
    await waitResult(events);
    assert.ok(gw.requests.some((r) => r.model === 'gpt-5.4'), '子 Agent 应以注册的 gpt-5.4 发请求');
    assert.ok(gw.requests.every((r) => !/sonnet|claude/i.test(r.model || '')), '不得出现未勾选模型请求');
    const data = JSON.parse(fs.readFileSync(path.join(tmp, 'drafter-store.json'), 'utf8'));
    assert.ok(data.modelUsage && data.modelUsage['gpt-5.4'], '用量面板应把子 Agent 记到 gpt-5.4 名下');
    assert.ok(!data.modelUsage['claude-sonnet-5'], '不得出现 Claude 记账');
  } finally {
    try { s.stop(); } catch {}
    gw.server.close();
  }
});

test('真实运行时:已注册子 Agent 的 sonnet 覆盖被剥掉,实际仍走固定模型', { timeout: 90000 }, async () => {
  const gw = await startGateway((body, raw) => {
    if (body.model === 'gpt-5.4') return sseText('gpt-5.4', '子任务完成');
    if (raw.includes('tool_result')) return sseText(body.model, '主流程结束');
    // Kuro 网关实测形态:主模型调合法自定义 Agent,但仍按 Agent schema 塞 model:"sonnet"。
    return sseToolUse(body.model, 'toolu_1', 'Agent', {
      subagent_type: 'model-gpt-5-4', model: 'sonnet', prompt: '回复 ok', description: 't',
    });
  });
  const { mgr, events } = makeManager(gw.port);
  const cwd = path.join(tmp, 'case-rewrite');
  fs.mkdirSync(cwd, { recursive: true });
  const meta = mgr.create({
    cwd, kind: 'code', keyId: 'k1', model: 'gpt-6-astra',
    agentModels: [{ keyId: 'k1', model: 'gpt-5.4' }],
    permissionMode: 'bypassPermissions',
  });
  const s = mgr.get(meta.id);
  try {
    s.send('请处理这个任务');
    await waitResult(events);
    assert.ok(gw.requests.some((r) => r.model === 'gpt-5.4'), '剥掉覆盖后子 Agent 应以注册的 gpt-5.4 发请求');
    assert.ok(gw.requests.every((r) => !/sonnet|claude/i.test(r.model || '')), '不得把覆盖的 sonnet 发给网关');
    const route = store.readSessionEvents(meta.id).filter((e) => e.type === 'ui_agent_route');
    assert.ok(route.some((e) => e.action === 'rewrite' && e.requestedModel === 'sonnet'), '应有 rewrite 审计事件');
    assert.ok(!route.some((e) => e.action === 'deny'), '合法子 Agent 不得再进入 deny 重试循环');
  } finally {
    try { s.stop(); } catch {}
    gw.server.close();
  }
});

for (const inherit of [false, true]) test(`真实运行时:自定义${inherit ? '默认' : '固定'}模型创建后可 SendMessage 续聊`, { timeout: 90000 }, async () => {
  let mainRequests = 0;
  let childRequests = 0;
  let agentId;
  const gw = await startGateway((body, raw) => {
    if (/Write the title in the predominant language/.test(JSON.stringify(body.messages))) return sseText(body.model, 'title');
    if (body.model === 'gpt-5.4' || JSON.stringify(body.system).includes('AUDIT_CHILD_SCOPE')) {
      childRequests++;
      return sseText(body.model, '子 Agent 已完成本次指令。');
    }
    mainRequests++;
    if (mainRequests === 1) return sseToolUse(body.model, 'audit-spawn', 'Agent', {
      subagent_type: 'audit-reviewer', prompt: '完成一次检查', description: '检查', run_in_background: false, name: 'auditor',
    });
    if (mainRequests === 2) {
      agentId = raw.match(/agentId:\s*([A-Za-z0-9_-]+)/)?.[1];
      return sseToolUse(body.model, 'audit-followup', 'SendMessage', { to: inherit ? 'auditor' : agentId || 'missing-agent', message: '再检查一次', summary: '再次检查' });
    }
    return sseText(body.model, '完成');
  });
  const { mgr, events } = makeManager(gw.port);
  store.setSetting('extensions', { skills: [], agents: [] });
  const saved = extensions.save('agent', { name: 'audit-reviewer', prompt: 'AUDIT_CHILD_SCOPE: 你是审查员，只需回复完成。',
    model: inherit ? null : 'k1|gpt-5.4', scope: 'global' });
  assert.equal(saved.ok, true, saved.error);
  const cwd = path.join(tmp, 'followup-' + inherit);
  fs.mkdirSync(cwd, { recursive: true });
  const meta = mgr.create({ cwd, kind: 'code', keyId: 'k1', model: 'gpt-6-astra',
    agentModels: [], permissionMode: 'bypassPermissions' });
  const session = mgr.get(meta.id);
  try {
    session.send('请执行检查，然后发消息让子任务再检查一次。');
    await waitResult(events);
    assert.ok(agentId, '真实 SDK 结果应提供 agentId: ' + JSON.stringify(events.filter((e) =>
      ['user', 'ui_agent_route', 'ui_task', 'ui_error'].includes(e.ev.type)).map((e) => e.ev)));
    assert.equal(await session._resolveAgentModel(agentId), inherit ? 'gpt-6-astra' : 'gpt-5.4');
    const until = Date.now() + 5000;
    while (childRequests < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.ok(childRequests >= 2, `续聊应再次请求子模型，实际 ${childRequests} 次`);
    assert.ok(!events.some((e) => e.ev.type === 'ui_agent_route' && ['deny', 'network-deny'].includes(e.ev.action)),
      JSON.stringify(events.filter((e) => e.ev.type === 'ui_agent_route').map((e) => e.ev)));
    // Clear both caches: exercise the actual SDK-created transcript directory.
    session._agentRoute.spawned.clear();
    session.meta.agentModelRecords = null;
    assert.equal(await session._resolveAgentModel(agentId), inherit ? 'gpt-6-astra' : 'gpt-5.4');
    assert.ok(events.some((e) => e.ev.type === 'ui_task' && e.ev.status === 'completed'));
    assert.ok(events.some((e) => e.ev.type === 'ui_task' && e.ev.parentId === 'audit-followup' && e.ev.status === 'running'),
      '续聊的新一轮应重新显示运行中');
  } finally {
    session.stop(); gw.server.close();
    store.setSetting('extensions', { skills: [], agents: [] });
  }
});
