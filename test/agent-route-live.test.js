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
const { SessionManager } = require('../src/main/sessions');

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

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
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(out);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

function makeManager(port) {
  const events = [];
  const mgr = new SessionManager(() => null, (extra) => ({
    ...process.env, ...extra,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: 'test-token',
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
