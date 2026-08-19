// 画布/素材板块 CDP 冒烟(v0.10.0):electron --remote-debugging-port=9222 下
// 用 Node 内置 WebSocket 驱动 Runtime.evaluate 走完板块主流程:
// 切画布板块 → 新建画布 → 加图片节点 → 校验节点 DOM/模型多选 → 切素材板块 → 回 code。
// 只读 UI 状态,不触发真实生成(不扣费)。用法:
//   1) 先启动:unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron . --remote-debugging-port=9222
//   2) 再跑:node .claude-ui/smoke-canvas.js
const CDP = 'http://127.0.0.1:9222';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(CDP + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('找不到渲染页目标(应用未启动或调试端口未开)');
}

let seq = 0;
const pending = new Map();
let ws;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面内执行出错:' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result && r.result.value;
}

const steps = [];
async function step(name, fn) {
  try {
    const v = await fn();
    steps.push(['PASS', name, v === undefined ? '' : String(v)]);
  } catch (e) {
    steps.push(['FAIL', name, e.message]);
  }
}

(async () => {
  const url = await getPageWs();
  ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result || {}); pending.delete(m.id); }
  };

  await step('错误钩子安装', () => evalJs(`window.__errs=[];window.addEventListener('error',e=>__errs.push(String(e.message)));window.addEventListener('unhandledrejection',e=>__errs.push('rej:'+String(e.reason)));'ok'`));
  await step('Drawflow 全局可用', () => evalJs(`typeof Drawflow`));
  await step('boot 完成(渲染模块无加载错误)', () => evalJs(`!!document.querySelector('#section-switch button[data-sec="canvas"]')`));

  await step('切到画布板块', async () => {
    await evalJs(`document.querySelector('#section-switch button[data-sec="canvas"]').click();'clicked'`);
    await sleep(1200);
    return evalJs(`document.body.classList.contains('sec-canvas')`);
  });
  await step('画布板块新建按钮文案', () => evalJs(`document.getElementById('btn-new-session').textContent`));
  await step('新建画布(走侧栏按钮)', async () => {
    await evalJs(`document.getElementById('btn-new-session').click();'clicked'`);
    await sleep(800);
    return evalJs(`document.getElementById('canvas-empty').classList.contains('hidden') && document.querySelectorAll('#session-list .session-item').length`);
  });
  await step('加图片生成节点(＋节点菜单)', async () => {
    await evalJs(`document.getElementById('btn-cv-add').click();'m'`);
    await sleep(200);
    await evalJs(`document.querySelector('#cv-add-menu button[data-nt="image"]').click();'n'`);
    await sleep(400);
    return evalJs(`document.querySelectorAll('#drawflow .drawflow-node').length`);
  });
  await step('节点含 prompt 框/模型多选/生成按钮', () => evalJs(`
    const b=document.querySelector('#drawflow .drawflow-node .cv-body');
    JSON.stringify({prompt: !!b.querySelector('.cv-prompt'), msel: !!b.querySelector('.cv-msel'), gen: !!b.querySelector('.cv-gen'), chips: b.querySelectorAll('.cv-msel label').length})
  `));
  await step('再加文本节点并连线', async () => {
    await evalJs(`document.getElementById('btn-cv-add').click();'m'`);
    await sleep(200);
    await evalJs(`document.querySelector('#cv-add-menu button[data-nt="text"]').click();'n'`);
    await sleep(400);
    return evalJs(`document.querySelectorAll('#drawflow .drawflow-node').length`);
  });
  await step('自动保存落盘(防抖 600ms)', async () => {
    await sleep(1200);
    return evalJs(`document.getElementById('canvas-save-hint').textContent.includes('已保存')`);
  });

  await step('v0.10.1 文本生成节点(llmtext)', async () => {
    await evalJs(`document.getElementById('btn-cv-add').click();'m'`);
    await sleep(200);
    const r = await evalJs(`(() => {
      const b = document.querySelector('#cv-add-menu button[data-nt="llmtext"]');
      if (!b) return 'menu-missing';
      b.click();
      return 'clicked';
    })()`);
    await sleep(400);
    const body = await evalJs(`(() => {
      const nodes = document.querySelectorAll('#drawflow .drawflow-node');
      const last = nodes[nodes.length - 1];
      const b = last && last.querySelector('.cv-body');
      return b ? JSON.stringify({prompt: !!b.querySelector('.cv-prompt'), msel: !!b.querySelector('.cv-msel'), gen: !!b.querySelector('.cv-gen')}) : 'no-body';
    })()`);
    return r + ' ' + body;
  });
  await step('v0.10.1 模板菜单(预置播种 + 存为模板行)', async () => {
    await evalJs(`document.getElementById('btn-cv-tpl').click();'t'`);
    await sleep(400);
    return evalJs(`JSON.stringify({
      presets: [...document.querySelectorAll('#cv-tpl-menu .cv-tpl-use')].map((x) => x.textContent.trim()),
      saveRow: !!document.querySelector('#cv-tpl-menu [data-tplsave]'),
      exportRow: !!document.querySelector('#cv-tpl-menu [data-tplexport]'),
    })`);
  });
  await step('v0.10.1 从模板新建画布(首个预置)', async () => {
    await evalJs(`document.querySelector('#cv-tpl-menu .cv-tpl-use').click();'u'`);
    await sleep(1200);
    return evalJs(`JSON.stringify({
      nodes: document.querySelectorAll('#drawflow .drawflow-node').length,
      connections: document.querySelectorAll('#drawflow svg.connection').length,
      saveHint: document.getElementById('canvas-save-hint').textContent,
    })`);
  });

  await step('切到素材板块', async () => {
    await evalJs(`document.querySelector('#section-switch button[data-sec="assets"]').click();'clicked'`);
    await sleep(1500);
    return evalJs(`document.body.classList.contains('sec-assets')`);
  });
  await step('素材网格渲染(卡片或空态)', () => evalJs(`
    const g=document.getElementById('assets-grid');
    JSON.stringify({cards: g.querySelectorAll('.asset-card').length, emptyShown: !document.getElementById('assets-empty').classList.contains('hidden'), sidebarHidden: getComputedStyle(document.getElementById('sidebar')).display==='none'})
  `));

  await step('回 code 板块(无残留显隐错乱)', async () => {
    await evalJs(`document.querySelector('#section-switch button[data-sec="code"]').click();'clicked'`);
    await sleep(800);
    return evalJs(`JSON.stringify({sec:document.body.classList.contains('sec-code'),composer:getComputedStyle(document.querySelector('.composer')).display!=='none',sidebar:getComputedStyle(document.getElementById('sidebar')).display!=='none'})`);
  });

  await step('全程渲染端错误', () => evalJs(`JSON.stringify(window.__errs)`));

  for (const [st, name, extra] of steps) console.log(st, '|', name, extra ? '| ' + extra : '');
  const fails = steps.filter(([st]) => st === 'FAIL');
  console.log(fails.length ? `\n${fails.length} 项失败` : '\n全部通过');
  ws.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('冒烟驱动失败:', e.message); process.exit(2); });
