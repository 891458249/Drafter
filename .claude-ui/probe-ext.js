// 扩展板块(v0.15.16)端到端冒烟:本地假 OpenAI 服务 + 真 Key,走真实 UI 链路验证
// ①扩展板块模板卡片渲染 ②模板复制副本+AI 起草+保存 ③会话挂载+本条指定(pin)
// ④真实 SDK 发送时假网关抓到 <drafter-skills> 索引与 <drafter-skill> pinned 全文
// ⑤自定义 Agent(session 作用域)经 composer 菜单挂载,meta.customAgentIds 落库。
// 注:受管 launch 会 KILL_ON_JOB_CLOSE 硬杀长探针(v0.15.14 已坐实),故隔离直跑
// (独立 userData/独立 CDP 端口)+ finally 自清理,跑完用 debug-runtime verify 核对无残留。
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules';
require('module').Module._initPaths();

const EXE = 'D:/ClaudeUI/node_modules/electron/dist/electron.exe';
const temp = path.join(os.tmpdir(), `drafter-ext-smoke-${process.pid}`);
const userData = path.join(temp, 'userdata');
const CDP_PORT = 9235;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const DRAFT_MARK = 'DRAFTMARK-9c2b';
const PIN_MARK = 'PINMARK-7f3e1';
const SKILL_NAME = '探针技能XYZ';
const AGENT_NAME = 'probe-agent-smoke';

// ---------------------------------------------------------------------------
// 假 OpenAI 后端:/v1/models + /v1/chat/completions(stream=SDK 会话;非流式=AI 起草)
// ---------------------------------------------------------------------------
const captured = []; // 抓取的 chat/completions 请求体(SDK 会话流量)
function sse(text) {
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-x', model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return chunk({ role: 'assistant', content: text }) + chunk({}, 'stop')
    + `data: ${JSON.stringify({ id: 'chatcmpl-x', model: 'mock-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
    + 'data: [DONE]\n\n';
}
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    return;
  }
  if (req.method === 'POST' && req.url.endsWith('/v1/chat/completions')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      if (body.stream) {
        captured.push(raw);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse('技能冒烟回显。'));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content:
          `## 何时触发\n${DRAFT_MARK} 当用户说冒烟时触发\n## 步骤\n1. 逐字引用标记` } }] }));
      }
    });
    return;
  }
  res.writeHead(404); res.end('{}');
});

function connect(url) {
  const ws = new (require('ws').WebSocket)(url);
  const pending = new Map();
  let id = 0;
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });
  return new Promise((resolve) => ws.on('open', () => resolve({
    ws,
    send(method, params = {}) {
      return new Promise((resolve2, reject) => {
        const requestId = ++id;
        pending.set(requestId, resolve2);
        ws.send(JSON.stringify({ id: requestId, method, params }));
        setTimeout(() => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          reject(new Error(`timeout: ${method}`));
        }, 30000);
      });
    },
  })));
}

async function waitForCdp() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) return; } catch {}
    await wait(500);
  }
  throw new Error('CDP did not start');
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const llmPort = server.address().port;
  fs.mkdirSync(userData, { recursive: true });
  const env = { ...process.env, DRAFTER_USERDATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DSH_HOME;
  const child = spawn(EXE, ['D:/ClaudeUI', `--remote-debugging-port=${CDP_PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let mainWs = null;
  try {
    await waitForCdp();
    const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const mainPage = pages.find((p) => p.url.includes('index.html'));
    if (!mainPage) throw new Error('main page not found: ' + JSON.stringify(pages.map((p) => p.url)));
    const main = await connect(mainPage.webSocketDebuggerUrl);
    mainWs = main.ws;
    const evaluate = async (expression, awaitP = false) => {
      const r = await main.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: awaitP });
      const res = r.result || {};
      if (res.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(res.exceptionDetails));
      return res.result ? res.result.value : undefined;
    };
    await wait(4000);
    await evaluate(`window.alert = (m) => { window.__alertMsg = String(m); }`);
    await evaluate(`(() => { for (const m of document.querySelectorAll('.modal-mask')) m.classList.add('hidden'); })()`);

    // ① 真 Key 指向本地假服务(openai 协议→ SDK 流量走 oai-proxy 翻译层)
    const keySaved = await evaluate(`window.api.keysSave({ name: 'MockLLM', key: 'sk-mock', baseUrl: 'http://127.0.0.1:${llmPort}', protocol: 'openai' })`, true);
    if (!keySaved || !keySaved.ok) throw new Error('keysSave failed: ' + JSON.stringify(keySaved));
    await evaluate(`window.api.keysRefreshModels('${keySaved.id}')`, true);
    await wait(500);

    // ② 切到扩展板块:预置模板卡片渲染(技能页签 3 张)
    await evaluate(`document.querySelector('#section-switch button[data-sec="ext"]').click()`);
    await wait(800);
    const secExt = await evaluate(`document.body.classList.contains('sec-ext')`);
    const presetCards = await evaluate(`[...document.querySelectorAll('#ext-grid .ext-card')].map(c => c.querySelector('.ext-card-name').textContent)`);
    console.log('[1] sec-ext:', secExt, 'skill cards:', JSON.stringify(presetCards));
    if (!secExt) throw new Error('未进入 sec-ext');
    if (!presetCards.includes('代码审查清单')) throw new Error('预置技能模板未渲染');

    // ③ 点预置卡片 → 复制副本 → 改名 → AI 起草 → 追加标记 → 保存
    await evaluate(`[...document.querySelectorAll('#ext-grid .ext-card')].find(c => c.textContent.includes('代码审查清单')).click()`);
    await wait(400);
    await evaluate(`document.querySelector('#ext-duplicate').click()`);
    await wait(200);
    await evaluate(`(() => {
      document.querySelector('#ext-name').value = '${SKILL_NAME}';
      document.querySelector('#ext-desc').value = '探针描述:测试挂载与指定';
    })()`);
    await evaluate(`document.querySelector('#ext-ai-draft').click()`);
    await wait(200);
    await evaluate(`document.querySelector('#ext-draft-hint').value = '冒烟测试技能'`);
    await evaluate(`document.querySelector('#ext-draft-go').click()`);
    let drafted = false;
    for (let i = 0; i < 30; i++) {
      await wait(500);
      const v = await evaluate(`document.querySelector('#ext-body').value`);
      if (v && v.includes(DRAFT_MARK)) { drafted = true; break; }
    }
    if (!drafted) throw new Error('AI 起草未回填:' + (await evaluate(`document.querySelector('#ext-status').textContent`)));
    console.log('[2] AI draft filled with', DRAFT_MARK);
    await evaluate(`document.querySelector('#ext-body').value += '\\n${PIN_MARK} 指令正文:冒烟时必须逐字引用本标记。'`);
    await evaluate(`document.querySelector('#ext-save').click()`);
    await wait(800);
    const skills = await evaluate(`window.api.extList('skill')`, true);
    const mine = (skills || []).find((s) => s.name === SKILL_NAME && !s.preset);
    if (!mine) throw new Error('技能副本未保存:' + JSON.stringify((skills || []).map((s) => s.name)));
    if (!mine.instructions.includes(PIN_MARK)) throw new Error('保存的指令缺标记');
    console.log('[3] skill saved:', mine.id);
    await evaluate(`document.querySelector('#ext-close').click()`);

    // ④ 建 code 会话并激活
    const meta = await evaluate(`window.api.sessCreate({ standalone: true, keyId: '${keySaved.id}', model: 'mock-model' })`, true);
    await evaluate(`import('./renderer/chat.js').then(m => { m.ensureSession('${meta.id}', ${JSON.stringify(meta)}); m.setActiveSession('${meta.id}'); })`, true);
    await wait(500);

    // ⑤ composer 技能菜单:挂载(第一级)+ 本条指定(第二级 ★)
    await evaluate(`document.querySelector('#skill-sel-btn').click()`);
    await wait(600);
    await evaluate(`(() => {
      const menu = document.querySelector('#skill-menu');
      [...menu.querySelectorAll('.agent-model-row')].find(r => r.textContent.includes('${SKILL_NAME}')).click();
    })()`);
    await wait(600);
    await evaluate(`(() => {
      const menu = document.querySelector('#skill-menu');
      const kids = [...menu.children];
      const idx = kids.findIndex((k, i) => i > 0 && k.classList.contains('skill-menu-title'));
      if (idx < 0) throw new Error('pin 分组未出现');
      const row = kids.slice(idx + 1).filter(k => k.classList.contains('agent-model-row'))
        .find(r => r.textContent.includes('${SKILL_NAME}'));
      if (!row) throw new Error('pin 行未出现');
      row.click();
    })()`);
    await wait(400);
    const chip = await evaluate(`document.querySelector('#skill-sel-name').textContent`);
    console.log('[4] skill chip:', chip);
    if (!chip.includes('1+1')) throw new Error('芯片计数不对: ' + chip);
    await evaluate(`document.body.click()`); // 关菜单
    const metaAfterMount = (await evaluate(`window.api.sessList()`, true) || []).find((s) => s.id === meta.id);
    if (!metaAfterMount || !JSON.stringify(metaAfterMount.skillIds || []).includes(mine.id)) {
      throw new Error('meta.skillIds 未落库: ' + JSON.stringify(metaAfterMount && metaAfterMount.skillIds));
    }
    console.log('[5] meta.skillIds persisted:', JSON.stringify(metaAfterMount.skillIds));

    // ⑥ 真实发送:假网关应抓到 <drafter-skills> 索引 + pinned 全文
    await evaluate(`document.querySelector('#input').value = '你好,冒烟测试'`);
    await evaluate(`document.querySelector('#btn-send').click()`);
    let hit = null;
    for (let i = 0; i < 120; i++) {
      await wait(1000);
      hit = captured.find((raw) => raw.includes('drafter-skills'));
      if (hit) break;
    }
    if (!hit) throw new Error('假网关未抓到含技能索引的请求,captured=' + captured.length + '; alert=' + (await evaluate('window.__alertMsg')));
    const checks = {
      index: hit.includes('drafter-skills'),
      indexHasName: hit.includes(SKILL_NAME),
      pinnedBlock: hit.includes('drafter-skill'),
      pinnedFullText: hit.includes(PIN_MARK),
      userText: hit.includes('冒烟测试'),
    };
    console.log('[6] gateway capture checks:', JSON.stringify(checks));
    for (const [k, v] of Object.entries(checks)) if (!v) throw new Error('发送注入断言失败: ' + k);
    // pin 发送后已清空(芯片回到挂载计数)
    await wait(1500);
    const chipAfter = await evaluate(`document.querySelector('#skill-sel-name').textContent`);
    console.log('[7] chip after send:', chipAfter);
    if (!chipAfter.includes('(1)') || chipAfter.includes('★')) throw new Error('pin 未在发送后清空: ' + chipAfter);

    // ⑦ 自定义 Agent(session 作用域、不绑定)→ composer「子 Agent」菜单挂载
    await evaluate(`document.querySelector('#section-switch button[data-sec="ext"]').click()`);
    await wait(600);
    await evaluate(`document.querySelector('#ext-tabs button[data-ext-tab="agent"]').click()`);
    await wait(300);
    await evaluate(`document.querySelector('#btn-ext-new').click()`);
    await wait(500);
    await evaluate(`(() => {
      document.querySelector('#ext-name').value = '${AGENT_NAME}';
      document.querySelector('#ext-desc').value = '探针 Agent';
      document.querySelector('#ext-body').value = '你是探针 Agent,只回报收到。';
      const scope = document.querySelector('#ext-scope');
      scope.value = 'session';
      scope.dispatchEvent(new Event('change'));
    })()`);
    await wait(600); // renderScope 是异步(sessList)
    const scopeTargetVal = await evaluate(`document.querySelector('#ext-scope-target').value`);
    await evaluate(`document.querySelector('#ext-save').click()`);
    await wait(600);
    const agents = await evaluate(`window.api.extList('agent')`, true);
    const myAgent = (agents || []).find((a) => a.name === AGENT_NAME);
    if (!myAgent) throw new Error('自定义 Agent 未保存');
    if (myAgent.scope !== 'session' || myAgent.scopeId !== null) {
      throw new Error('Agent 作用域不对: ' + JSON.stringify({ scope: myAgent.scope, scopeId: myAgent.scopeId, sel: scopeTargetVal }));
    }
    console.log('[8] custom agent saved:', myAgent.id, 'scope=session, scopeId=null');
    await evaluate(`document.querySelector('#ext-close').click()`);

    // 回 code 板块,经 composer 子 Agent 菜单挂载
    await evaluate(`document.querySelector('#section-switch button[data-sec="code"]').click()`);
    await wait(1200);
    await evaluate(`document.querySelector('#agent-models-btn').click()`);
    await wait(800);
    await evaluate(`(() => {
      const menu = document.querySelector('#agent-models-menu');
      const rows = [...menu.querySelectorAll('.agent-model-row')];
      const row = rows.find(r => r.textContent.includes('${AGENT_NAME}') && !r.disabled);
      if (!row) throw new Error('菜单里没有可挂载的 ${AGENT_NAME}: ' + rows.map(r => r.textContent).join('|'));
      row.click();
    })()`);
    await wait(800);
    const metaFinal = (await evaluate(`window.api.sessList()`, true) || []).find((s) => s.id === meta.id);
    if (!metaFinal || !JSON.stringify(metaFinal.customAgentIds || []).includes(myAgent.id)) {
      throw new Error('meta.customAgentIds 未落库: ' + JSON.stringify(metaFinal && metaFinal.customAgentIds));
    }
    console.log('[9] meta.customAgentIds persisted:', JSON.stringify(metaFinal.customAgentIds));

    // ⑧ store 层断言
    const storeDump = await evaluate(`window.api.getStore()`, true);
    const ext = storeDump && storeDump.settings && storeDump.settings.extensions;
    const storeOk = !!ext && (ext.skills || []).some((s) => s.name === SKILL_NAME)
      && (ext.agents || []).some((a) => a.name === AGENT_NAME)
      && (ext.skills || []).filter((s) => s.preset).length >= 3
      && (ext.agents || []).filter((a) => a.preset).length >= 3;
    if (!storeOk) throw new Error('store.settings.extensions 断言失败');
    console.log('[10] store.extensions ok (mine + 3+3 presets)');

    console.log('PASS: 扩展板块端到端(模板副本 → AI 起草 → 挂载+pin → 真实发送注入 → 自定义 Agent 挂载落库)');
  } finally {
    try { if (mainWs) mainWs.close(); } catch {}
    child.kill();
    server.close();
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch {}
  }
}

main().catch((error) => { console.error('FAIL:', error); process.exitCode = 1; });
