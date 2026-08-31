// Isolated CDP smoke for the canvas ComfyUI integration.
// Requires a running development Electron instance on 9238; deliberately works with no ComfyUI server.
const CDP = 'http://127.0.0.1:9238';
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(CDP + '/json/list')).json();
      const page = list.find((target) => target.type === 'page' && target.url.includes('index.html'));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('CDP renderer target unavailable');
}

let seq = 0;
const waiting = new Map();
let ws;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  return result.result && result.result.value;
}
const checks = [];
async function check(name, fn) {
  try { checks.push(['PASS', name, String(await fn())]); }
  catch (error) { checks.push(['FAIL', name, error.message]); }
}

(async () => {
  ws = new WebSocket(await pageWs());
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && waiting.has(message.id)) { waiting.get(message.id).resolve(message.result || {}); waiting.delete(message.id); }
  };

  await check('renderer boot and error capture', () => evaluate(`window.__smokeErrors=[];window.addEventListener('error',e=>__smokeErrors.push(String(e.message)));window.addEventListener('unhandledrejection',e=>__smokeErrors.push(String(e.reason)));!!document.querySelector('#section-switch button[data-sec="canvas"]')`));
  await check('enter canvas with no ComfyUI server required', async () => {
    await evaluate(`document.querySelector('#section-switch button[data-sec="canvas"]').click()`);
    await sleep(1200);
    return evaluate(`JSON.stringify({section:document.body.classList.contains('sec-canvas'), comfyButtons:!!document.getElementById('btn-cv-comfy'), importButton:!!document.getElementById('btn-cv-comfy-import')})`);
  });
  await check('create canvas', async () => {
    await evaluate(`document.getElementById('btn-new-session').click()`);
    await sleep(500);
    return evaluate(`document.querySelectorAll('#session-list .session-item').length`);
  });
  await check('add text node and persist', async () => {
    await evaluate(`document.getElementById('btn-cv-add').click();document.querySelector('#cv-add-menu button[data-nt="text"]').click()`);
    await sleep(950);
    return evaluate(`JSON.stringify({shell:!!document.querySelector('#drawflow .cv-shell'),head:!!document.querySelector('#drawflow .cv-head'),body:!!document.querySelector('#drawflow .cv-body'),saved:document.getElementById('canvas-save-hint').textContent.includes('已保存')})`);
  });
  await check('reopen saved canvas reconstructs shell', async () => {
    await evaluate(`document.querySelector('#section-switch button[data-sec="code"]').click()`);
    await sleep(250);
    await evaluate(`document.querySelector('#section-switch button[data-sec="canvas"]').click()`);
    await sleep(900);
    const result = await evaluate(`JSON.stringify({nodes:document.querySelectorAll('#drawflow .drawflow-node').length,shells:document.querySelectorAll('#drawflow .cv-shell').length,heads:document.querySelectorAll('#drawflow .cv-head').length,bodies:document.querySelectorAll('#drawflow .cv-body').length,text:!!document.querySelector('#drawflow .cv-txt')})`);
    const parsed = JSON.parse(result);
    if (!parsed.nodes || parsed.nodes !== parsed.shells || parsed.nodes !== parsed.heads || !parsed.text) throw new Error(result);
    return result;
  });
  await check('ComfyUI unavailable state stays safe', () => evaluate(`JSON.stringify({externalMenuItems:document.querySelectorAll('#cv-add-menu [data-comfy-class]').length,errors:window.__smokeErrors})`));
  await check('capture canvas screenshot', async () => {
    const image = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(__dirname, 'smoke-comfy-canvas.png');
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    return file;
  });

  for (const [status, name, detail] of checks) console.log(`${status} | ${name} | ${detail}`);
  const failures = checks.filter(([status]) => status === 'FAIL');
  console.log(failures.length ? `FAILED: ${failures.length}` : 'ALL SMOKE CHECKS PASSED');
  ws.close();
  process.exit(failures.length ? 1 : 0);
})().catch((error) => { console.error('SMOKE DRIVER ERROR:', error.stack || error.message); process.exit(2); });
