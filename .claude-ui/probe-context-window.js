// 探针:向隔离会话发 /context,读回 SDK 自己解析的「自动压缩窗口 / 阈值」,
// 用来判定 autoCompactWindow 到底有没有被采纳、阈值公式是什么。
// 打本地假网关,零真实付费请求;CLAUDE_CONFIG_DIR/userData/cwd 全隔离。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { installElectronStub } = require('../test/helpers/electron-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-ctx-probe-'));
installElectronStub(tmp);
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, '.claude');
const store = require('../src/main/store');
const modelGuard = require('../src/main/model-guard-proxy');
const { SessionManager } = require('../src/main/sessions');

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

function startGateway() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":1}');
        return;
      }
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      if (!req.url.includes('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"fake"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(sseText(body.model || 'unknown', 'ok'));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

function makeManager(port) {
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

async function waitResult(events, ms = 60000) {
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

// 从事件里抠出所有可读文本(assistant 文本 + tool 结果),用于找 /context 输出
function allText(events) {
  const out = [];
  for (const p of events) {
    const ev = p.ev || {};
    if (ev.type === 'ui_assistant' || ev.type === 'ui_text') out.push(JSON.stringify(ev));
    if (ev.type === 'ui_other') out.push(JSON.stringify(ev.raw));
    if (ev.type === 'result') out.push(JSON.stringify(ev));
  }
  return out.join('\n');
}

(async () => {
  await modelGuard.start();
  const gw = await startGateway();
  store.setSetting('apiKeys', [{
    id: 'k1', name: 'Fake', key: 'fake', baseUrl: `http://127.0.0.1:${gw.port}`, enabled: true,
    models: ['gpt-6-astra'], modelsEnabled: ['gpt-6-astra'],
    modelGroups: [{ category: 'chat', model_type: 'chat', models: ['gpt-6-astra'] }],
  }]);
  const { mgr, events } = makeManager(gw.port);
  const cwd = path.join(tmp, 'ctx');
  fs.mkdirSync(cwd, { recursive: true });
  const meta = mgr.create({ cwd, kind: 'code', keyId: 'k1', model: 'gpt-6-astra', permissionMode: 'bypassPermissions' });
  const s = mgr.get(meta.id);
  try {
    events.length = 0;
    s.send('/context');
    await waitResult(events).catch((e) => { console.log('result 等待失败:', e.message); });
    const text = allText(events);
    console.log('=== DRAFTER_TEST_WINDOW =', process.env.DRAFTER_TEST_WINDOW || '(未设) ===');
    for (const line of text.split('\\n')) if (/[Aa]uto-?compact|threshold|window|tokens/i.test(line)) console.log('  >', line.slice(0, 400));
    console.log('--- 原始事件类型 ---');
    console.log(events.map((p) => (p.ev || {}).type).join(','));
  } finally {
    s.stop();
    await s._debugCleanup?.cleanup();
    gw.server.close();
    await modelGuard.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
})();
