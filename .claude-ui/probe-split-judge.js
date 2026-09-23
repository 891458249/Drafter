// 拆分子任务「先判断」端到端冒烟(v0.15.18):
// 本地假 OpenAI 服务 + 真 Key + 真 claude.exe,走真实 UI 链路验证:
//  ① 判断提示词带上「同项目组其他并行会话现状」(S1 标题/空闲)
//  ② 混合判断结果(1 并行 + 1 等兄弟子任务 + 1 等当前会话)在卡片上正确呈现
//  ③ 确认后并行项各建一个会话;等待项不建会话,而是排入目标会话的消息队列
//  ④ 关键行为:当前会话手上还有没跑完的回合时,排入的等待项是「排队」而非「插队」。
//     假网关把当前会话的第一个回合**扣住不放**(longGate,由探针显式放行),
//     于是能确定性验证:放行前它一步没动,放行后它才在长回合之后执行——
//     不依赖任何 sleep 赌时间窗。
// 注:受管 launch 会 KILL_ON_JOB_CLOSE 硬杀长探针(v0.15.14 已坐实),故隔离直跑
// (独立 userData / 独立 CDP 端口)+ finally 自清理,跑完用 debug-runtime verify 核对无残留。
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules';
require('module').Module._initPaths();

const EXE = 'D:/ClaudeUI/node_modules/electron/dist/electron.exe';
const temp = path.join(os.tmpdir(), `drafter-split-judge-${process.pid}`);
const userData = path.join(temp, 'userdata');
const CDP_PORT = 9236;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CWD = 'D:/ClaudeUI';
const OTHER_TITLE = '冒烟-同项目组其他会话B';
const TITLE_A = '冒烟-主会话A';
const MARK_LONG = 'LONG-TASK';
const MARK_BACKEND = 'SPLIT-BACKEND';
const MARK_FRONT = 'SPLIT-FRONT';
const MARK_README = 'SPLIT-README';
const LONG_TASK = `${MARK_LONG}:重构登录页的样式与结构,这一轮先跑着别停`;

// 假网关返回的混合判断结果:1 并行 + 1 等兄弟子任务 + 1 等当前会话
const SPLIT = [
  { title: '搭建后端接口', detail: MARK_BACKEND + ':用 Express 实现 /api/posts 增删改查', mode: 'parallel' },
  { title: '前端页面对接', detail: MARK_FRONT + ':接后端接口渲染文章列表', mode: 'wait', waitFor: '#1' },
  { title: '补写 README', detail: MARK_README + ':补写项目说明', mode: 'wait', waitFor: 'current' },
];

const agentHits = [];  // 抓到的 SDK 会话请求(stream=true)里带我们标记的那条消息
const splitHits = [];  // 抓到的拆分请求原文
const streamSeen = []; // 所有 stream 请求的分类摘要(诊断用)
// 扣住「当前会话第一个回合」的闸门:探针显式放行,保证「排队而非插队」可确定复现
let openLongGate = null;
const longGate = new Promise((r) => { openLongGate = r; });
let gateUsed = false;

function markerOf(text) {
  const m = String(text).match(/SPLIT-[A-Z]+|LONG-TASK/);
  return m ? m[0] : '(none)';
}

function textOf(m) {
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && (b.text || b.content)) || '').join(' ');
  return '';
}

// 找出这条请求「最新一条带标记的消息」:SDK 会在我们的提示词之后再塞一条
// 「Available agent types for the Agent tool: …」的用户消息,所以不能只看最后一条,
// 要从后往前扫、取第一条命中标记的(claude.exe 内部那条起标题请求用 <session> 包裹,另行排除)。
function findTurnMarker(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = textOf(msgs[i]);
    const m = t.match(/(SPLIT-[A-Z]+|LONG-TASK)/);
    if (m) return { marker: m[0], text: t };
  }
  return null;
}

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
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      if (body.stream) { // SDK 侧流量(经 oai-proxy 翻译)
        const hit = findTurnMarker(body);
        const text = (hit ? hit.text : '').trim();
        // claude.exe 自己会发一条「给会话起标题」的请求(<session> 包裹),那不是我们的回合,
        // 别把它算成 agent 回合(否则会误吃闸门、误判次序)
        const internal = !!hit && (text.startsWith('<session>') || text.includes('Write the title in the predominant language'));
        const isOurTurn = !!hit && !internal;
        streamSeen.push(`${hit ? (internal ? 'internal' : 'turn') : 'nomarker'}/tools=${Array.isArray(body.tools) ? body.tools.length : 0}: ${text.slice(0, 50).replace(/\s+/g, ' ')}`);
        if (!isOurTurn) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(sse('MOCK-TITLE'));
          return;
        }
        agentHits.push(text);
        const marker = markerOf(text);
        if (marker === MARK_LONG && !gateUsed) {
          gateUsed = true;
          await longGate; // 扣住不放,直到探针确认完「等待项确实在排队」再放行
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse('AGENT-REPLY::' + marker));
        return;
      }
      if (JSON.stringify(body.messages || '').includes('你是任务拆解助手')) {
        splitHits.push(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(SPLIT) } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
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

function replyText(ev) {
  if (!ev || ev.type !== 'assistant') return '';
  const c = ev.message && ev.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (b && b.type === 'text' ? b.text : '')).join('');
}
// 助手回复里出现某标记的下标(回复由假网关生成,只含 'AGENT-REPLY::<标记>')
function firstAssistantAt(events, mark) {
  return events.findIndex((e) => e.type === 'assistant' && replyText(e).includes(mark));
}
function firstEchoAt(events, mark) {
  return events.findIndex((e) => e.type === 'ui_user_input' && JSON.stringify(e.content).includes(mark));
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const llmPort = server.address().port;
  fs.mkdirSync(userData, { recursive: true });
  const env = { ...process.env, DRAFTER_USERDATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DSH_HOME;
  const child = spawn(EXE, ['D:/ClaudeUI', `--remote-debugging-port=${CDP_PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let childExited = false;
  child.on('exit', () => { childExited = true; });
  try {
    await waitForCdp();
    const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const mainPage = pages.find((p) => p.url.includes('index.html'));
    if (!mainPage) throw new Error('main page not found: ' + JSON.stringify(pages.map((p) => p.url)));
    const main = await connect(mainPage.webSocketDebuggerUrl);
    const evaluate = async (expression, awaitP = false) => {
      const r = await main.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: awaitP });
      const res = r.result || {};
      if (res.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(res.exceptionDetails));
      return res.result ? res.result.value : undefined;
    };
    const busyOf = (sid) => evaluate(
      `import('./renderer/state.js').then(m => { const s = m.state.sessions.get('${sid}'); return !!(s && s.ui && s.ui.busy); })`, true);

    await wait(4000);
    await evaluate(`window.alert = (m) => { window.__alertMsg = String(m); }`);
    await evaluate(`(() => { for (const m of document.querySelectorAll('.modal-mask')) m.classList.add('hidden'); })()`);

    // ① 真 Key 指向本地假服务(protocol=openai → agent 流量走 oai-proxy 转 chat/completions)
    const keySaved = await evaluate(`window.api.keysSave({ name: 'MockLLM', key: 'sk-mock', baseUrl: 'http://127.0.0.1:${llmPort}', protocol: 'openai' })`, true);
    if (!keySaved || !keySaved.ok) throw new Error('keysSave failed: ' + JSON.stringify(keySaved));
    await wait(500);

    // ② 两个同 cwd 会话:主会话 A(本次需求所在)+ B(同项目组其他并行会话)
    const a = await evaluate(`window.api.sessCreate({ standalone: true, cwd: '${CWD}', keyId: '${keySaved.id}', model: 'mock-model' })`, true);
    const b = await evaluate(`window.api.sessCreate({ standalone: true, cwd: '${CWD}', keyId: '${keySaved.id}', model: 'mock-model' })`, true);
    await evaluate(`window.api.sessRename('${b.id}', '${OTHER_TITLE}')`, true);
    // A 也必须先起名:title.js 的 autoTitle 只在标题为空时才写,先占住就不会被自动标题覆盖
    await evaluate(`window.api.sessRename('${a.id}', '${TITLE_A}')`, true);
    await evaluate(`import('./renderer/chat.js').then(m => { m.ensureSession('${a.id}', ${JSON.stringify(a)}); m.setActiveSession('${a.id}'); })`, true);
    await wait(500);
    console.log('[0] session A =', a.id, ' B =', b.id);

    // ③ 让 A 忙起来:真实 SDK 回合,响应被假网关扣住(直到 longGate 放行)
    await evaluate(`(() => { document.querySelector('#input').value = ${JSON.stringify(LONG_TASK)}; })()`);
    await evaluate(`document.querySelector('#btn-send').click()`);
    // 首个真实回合要等 claude.exe 起来(可能好几秒),给足 60s;响应被闸门扣着,慢也无所谓
    for (let i = 0; i < 120 && !agentHits.some((t) => t.includes(MARK_LONG)); i++) await wait(500);
    await wait(500);
    if (!agentHits.some((t) => t.includes(MARK_LONG))) {
      throw new Error('长任务回合没有真正打到网关(agent 链路没通): agent=' + JSON.stringify(agentHits)
        + ' streams=' + JSON.stringify(streamSeen));
    }
    const busy = await busyOf(a.id);
    console.log('[1] 长任务回合进行中,会话 A busy =', busy);
    if (!busy) throw new Error('主会话未被占用,无法验证「排队而非插队」');
    const titleNow = (await evaluate(`window.api.sessList()`, true)).find((s) => s.id === a.id);
    console.log('[1b] A 的标题:', JSON.stringify(titleNow && titleNow.title));
    if (!titleNow || titleNow.title !== TITLE_A) throw new Error('A 的标题被自动标题覆盖,落地目标无法辨识');

    // ④ 激活开关 → 发送 → 真实拆分(判断依据里应带其他会话现状)
    await evaluate(`document.querySelector('#btn-split-subtasks').click()`);
    await wait(200);
    if (!await evaluate(`document.querySelector('#btn-split-subtasks').classList.contains('split-on')`)) {
      throw new Error('split toggle did not arm');
    }
    await evaluate(`(() => { document.querySelector('#input').value = '做一个带用户系统的博客'; })()`);
    await evaluate(`document.querySelector('#btn-send').click()`);
    for (let i = 0; i < 40 && !splitHits.length; i++) await wait(250);
    await wait(600);
    const modalShown = await evaluate(`!document.querySelector('#split-modal').classList.contains('hidden')`);
    if (!modalShown) throw new Error('split modal did not open; alert=' + (await evaluate('window.__alertMsg')));
    const card = await evaluate(`[...document.querySelectorAll('#split-list .split-row')].map(r => ({
      title: r.querySelector('.split-title').value,
      mode: r.querySelector('.split-mode').value,
      wait: r.querySelector('.split-wait').value,
      waitHidden: r.querySelector('.split-wait').classList.contains('hidden'),
    }))`);
    const hint = await evaluate(`document.querySelector('#split-hint').textContent`);
    console.log('[2] 卡片:', JSON.stringify(card));
    console.log('    小结:', hint);
    if (card.length !== 3) throw new Error('expected 3 rows, got ' + JSON.stringify(card));
    if (!(card[0].mode === 'parallel' && card[1].mode === 'wait' && card[2].mode === 'wait')) {
      throw new Error('mode 未按判断结果预设: ' + JSON.stringify(card.map((c) => c.mode)));
    }
    if (card[1].wait !== '#1') throw new Error('等兄弟子任务的引用未预设为 #1: ' + card[1].wait);
    if (card[2].wait !== 'current') throw new Error('等当前会话未预设为 current: ' + card[2].wait);
    if (card[0].waitHidden !== true || card[1].waitHidden !== false) throw new Error('等待目标下拉显隐不对');
    if (!hint.includes('1 项可并行') || !hint.includes('2 项需等待')) throw new Error('判断小结不对: ' + hint);

    // 判断依据:提示词里应带上同项目组其他会话(S1 = 会话 B)
    const prompt = (splitHits[0] || '').replace(/\\n/g, '\n').replace(/\\"/g, '"');
    if (!prompt.includes(OTHER_TITLE)) throw new Error('判断提示词未带上其他并行会话标题:' + prompt.slice(0, 600));
    if (!/S1\. .*\[空闲\]/.test(prompt)) throw new Error('判断提示词未标注其他会话的编号/状态:' + prompt.slice(0, 600));
    console.log('[3] 判断提示词含其他并行会话现状(S1 = ' + OTHER_TITLE + ' [空闲])');

    // ⑤ 确认 → 落地(此时 A 仍被扣着,还没跑完长回合)
    await evaluate(`document.querySelector('#split-confirm').click()`);
    await wait(2000);
    const doneLabel = await evaluate(`document.querySelector('#split-confirm').textContent`);
    const resultLines = await evaluate(`[...document.querySelectorAll('#split-list .split-result-line')].map(e => e.textContent)`);
    console.log('[4] 结果视图:', doneLabel, JSON.stringify(resultLines));
    if (doneLabel !== '完成') throw new Error('落地后未切到结果视图');
    // 等待目标要指向正确的会话:等兄弟子任务 → 新建的那个;等当前会话 → A 本身
    if (!resultLines[1].includes('搭建后端接口')) throw new Error('等兄弟子任务的落地目标不对:' + resultLines[1]);
    if (!resultLines[2].includes(TITLE_A)) throw new Error('等当前会话的落地目标不是 A:' + resultLines[2]);
    const list = await evaluate(`window.api.sessList()`, true);
    const spawned = (list || []).filter((s) => (s.title || '').startsWith('⧉'));
    console.log('[5] 新建会话:', JSON.stringify(spawned.map((s) => s.title)));
    if (spawned.length !== 1) throw new Error('应只为主「并行」项建 1 个会话(等待项不建会话),实际 ' + spawned.length);

    // ⑥ 排队语义:此刻长回合还扣着,排入的等待项必须一步没动
    const held = await evaluate(`window.api.sessHistory('${a.id}')`, true);
    const at0 = {
      busy: await busyOf(a.id),
      echoLong: firstEchoAt(held, LONG_TASK),
      echoQueued: firstEchoAt(held, MARK_README),
      replyLong: firstAssistantAt(held, MARK_LONG),
      replyQueued: firstAssistantAt(held, MARK_README),
      aux: held.findIndex((e) => e.type === 'ui_aux' && String(e.message || '').includes('已排入子任务')),
    };
    console.log('[6] 长回合未放行时:', JSON.stringify(at0));
    if (!at0.busy) throw new Error('落地的瞬间主会话已不忙,前提不成立');
    if (at0.echoQueued < 0) throw new Error('排入的等待项没有出现在主会话历史里');
    if (!(at0.echoLong >= 0 && at0.echoLong < at0.echoQueued)) throw new Error('事件次序异常:' + JSON.stringify(at0));
    if (at0.replyLong >= 0 || at0.replyQueued >= 0) {
      throw new Error('长回合还没结束,后面的子任务就已经跑了(插队):' + JSON.stringify(at0));
    }
    if (at0.aux < 0) throw new Error('缺少「已排入子任务」提示');
    const auxMsg = String(held[at0.aux] && held[at0.aux].message || '');
    if (!auxMsg.includes('需等本会话当前回合完成')) throw new Error('提示文案未说明在等待:' + auxMsg);
    if (firstEchoAt(held, MARK_BACKEND) >= 0) throw new Error('并行项被误排进了主会话');

    // 放行长回合 → 排队的子任务必须在它之后才执行
    openLongGate();
    let hist = [];
    for (let i = 0; i < 60; i++) {
      await wait(1000);
      hist = await evaluate(`window.api.sessHistory('${a.id}')`, true);
      if (firstAssistantAt(hist, MARK_README) >= 0) break;
    }
    const at1 = {
      replyLong: firstAssistantAt(hist, MARK_LONG),
      replyQueued: firstAssistantAt(hist, MARK_README),
    };
    console.log('[7] 放行后主会话事件次序:', JSON.stringify(at1), '总数:', hist.length);
    if (at1.replyLong < 0 || at1.replyQueued < 0) throw new Error('主会话里排队那条没跑完:' + JSON.stringify(at1));
    if (!(at1.replyLong < at1.replyQueued)) throw new Error('排入的子任务没有排在正在跑的回合之后:' + JSON.stringify(at1));

    // ⑦ 等兄弟子任务的那条要落进新建会话的队列里
    const sub = spawned[0];
    let subHist = [];
    for (let i = 0; i < 60; i++) {
      await wait(1000);
      subHist = await evaluate(`window.api.sessHistory('${sub.id}')`, true);
      if (firstAssistantAt(subHist, MARK_FRONT) >= 0) break;
    }
    const subAt = {
      echoBackend: firstEchoAt(subHist, MARK_BACKEND),
      replyBackend: firstAssistantAt(subHist, MARK_BACKEND),
      echoFront: firstEchoAt(subHist, MARK_FRONT),
      replyFront: firstAssistantAt(subHist, MARK_FRONT),
    };
    console.log('[8] 新建会话事件次序:', JSON.stringify(subAt));
    if (subAt.echoFront < 0 || subAt.replyFront < 0) throw new Error('等兄弟子任务的项没有落到新建会话:' + JSON.stringify(subAt));
    if (!(subAt.replyBackend < subAt.replyFront)) throw new Error('兄弟子任务没有按先后执行:' + JSON.stringify(subAt));

    console.log('PASS: 拆分先判断端到端(其他会话现状进提示词 → 混合判断卡 → 并行建会话 / 等待排队且不插队)');
  } finally {
    openLongGate(); // 兜底放行,避免假网关请求悬挂导致 electron 无法退出
    try { server.close(); } catch {}
    if (!childExited) { try { child.kill(); } catch {} }
    await wait(2000);
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch (e) {
      console.error('cleanup warning:', e.message);
    }
  }
}

main().catch((error) => { console.error('FAIL:', error); process.exitCode = 1 });
