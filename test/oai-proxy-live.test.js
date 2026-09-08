// 协议级端到端:真实 claude.exe → oai-proxy(翻译层)→ 假 OpenAI Chat Completions 后端。
// 验证 OpenAI 协议 Key 的会话全链路:Anthropic 请求被翻译成 OpenAI 格式发出、
// 流式响应翻回、tool_use → tool_calls → 真实执行 → tool_result 以 role:tool 回到上游。
// 零真实付费请求;CLAUDE_CONFIG_DIR/userData/cwd 全部隔离,不碰真实数据。
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { installElectronStub } = require('./helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-oai-live-'));
installElectronStub(tmp);
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, '.claude');
const store = require('../src/main/store');
const proxy = require('../src/main/oai-proxy');
const { SessionManager } = require('../src/main/sessions');

after(async () => {
  try { await proxy.stop(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// --- 假 OpenAI 后端 ------------------------------------------------------------
const OAI_TOKEN = 'oai-test-token';

function chunk(model, delta, finish = null) {
  return `data: ${JSON.stringify({ id: 'chatcmpl-x', model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
function usageChunk(model) {
  return `data: ${JSON.stringify({ id: 'chatcmpl-x', model, choices: [], usage: { prompt_tokens: 42, completion_tokens: 9 } })}\n\n`;
}
const DONE = 'data: [DONE]\n\n';

// 第 1 轮:要求调 Bash echo;第 2 轮(见 role:tool):文本收尾
function scriptOpenAI(body) {
  const hasToolReply = (body.messages || []).some((m) => m.role === 'tool');
  if (!hasToolReply) {
    return chunk(body.model, { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '' } }] })
      + chunk(body.model, { tool_calls: [{ index: 0, function: { arguments: '{"command":"echo oai-proxy-live"}' } }] })
      + chunk(body.model, {}, 'tool_calls')
      + usageChunk(body.model) + DONE;
  }
  return chunk(body.model, { role: 'assistant', content: '工具结果收到,结束。' })
    + chunk(body.model, {}, 'stop')
    + usageChunk(body.model) + DONE;
}

let gw = null;
const gwRequests = [];

before(async () => {
  gw = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!req.url.endsWith('/v1/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"no such route"}}');
        return;
      }
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      gwRequests.push({ body, auth: req.headers['authorization'] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(scriptOpenAI(body));
    });
  });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  store.setSetting('apiKeys', [{
    id: 'k_oai_live', name: 'OAI', key: OAI_TOKEN, baseUrl: `http://127.0.0.1:${gw.address().port}`,
    kind: 'authToken', protocol: 'openai', enabled: true,
    models: ['gpt-6-astra'], modelsEnabled: null,
    modelGroups: [{ category: 'chat', model_type: 'chat', models: ['gpt-6-astra'] }],
  }]);
  await proxy.start();
});

after(async () => {
  if (gw) await new Promise((r) => { try { gw.closeAllConnections && gw.closeAllConnections(); } catch {} gw.close(r); });
});

async function waitResult(events, ms = 90000) {
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

test('真实 claude.exe 经翻译代理跑通 OpenAI 协议会话(含工具回路)', { timeout: 120000 }, async () => {
  const events = [];
  const mgr = new SessionManager(() => null, (extra) => ({
    ...process.env, ...extra,
    ANTHROPIC_BASE_URL: proxy.baseUrlFor('k_oai_live'),
    ANTHROPIC_AUTH_TOKEN: OAI_TOKEN,
    ANTHROPIC_API_KEY: '',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  }));
  mgr.send = (ch, payload) => { if (ch === 'sess:event') events.push(payload); };
  const cwd = path.join(tmp, 'case-openai');
  fs.mkdirSync(cwd, { recursive: true });
  const meta = mgr.create({ cwd, kind: 'code', keyId: 'k_oai_live', model: 'gpt-6-astra', permissionMode: 'bypassPermissions' });
  const s = mgr.get(meta.id);
  try {
    s.send('请执行一个 echo 然后告诉我结果');
    const result = await waitResult(events);
    assert.ok(result, '应收到 result 事件');

    assert.ok(gwRequests.length >= 2, '工具回路应产生至少两轮上游请求');
    assert.ok(gwRequests.every((r) => r.auth === 'Bearer ' + OAI_TOKEN), '代理应换发存储 key 的 Bearer');
    assert.ok(gwRequests.every((r) => r.body.model === 'gpt-6-astra'), '模型名应原样透传');
    // 首轮可能是并行的会话标题生成(无工具),主循环请求按「带 tools」定位
    const main1 = gwRequests.find((r) => Array.isArray(r.body.tools) && r.body.tools.length);
    assert.ok(main1, '应有带工具表的主循环请求');
    const r1 = main1.body;
    assert.strictEqual(r1.messages[0].role, 'system', 'Claude Code 系统提示应映射为 system 消息');
    assert.ok(r1.tools.some((t) => t.function && t.function.name === 'Bash'), '工具表应翻译成 OpenAI functions');
    assert.strictEqual(r1.stream, true);
    assert.deepStrictEqual(r1.stream_options, { include_usage: true });

    const r2 = gwRequests.find((r) => (r.body.messages || []).some((m) => m.role === 'tool'));
    assert.ok(r2, '应有一轮带 role:tool 工具结果的请求');
    const toolMsg = r2.body.messages.find((m) => m.role === 'tool');
    assert.strictEqual(toolMsg.tool_call_id, 'call_1');
    assert.ok(String(toolMsg.content).includes('oai-proxy-live'), 'tool_result 应含真实执行输出');
    const assistantMsg = r2.body.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    assert.ok(assistantMsg, '第二轮应含 tool_calls 形式的 assistant 历史');
    assert.strictEqual(assistantMsg.tool_calls[0].function.name, 'Bash');

    // 回合用量应来自末尾 usage chunk(经 message_delta 回填)
    const usage = (result.modelUsage && JSON.stringify(result.modelUsage)) || JSON.stringify(result.usage || {});
    assert.ok(usage.includes('42') || usage.includes('input'), 'result 应带 usage 记账:' + usage);
  } finally {
    try { s.stop(); } catch {}
  }
});
