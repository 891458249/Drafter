// node test/packaged-smoke.js dist/release-X.Y.Z
// Own process and temporary userData only; no API keys or real provider requests.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const dist = path.resolve(process.argv[2] || 'dist');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-packaged-smoke-'));
fs.writeFileSync(path.join(userData, 'drafter-store.json'), JSON.stringify({ settings: { updateCheck: false, floatBall: false }, sessions: [], cronJobs: [] }));
let proc;
const sockets = [];
let output = '';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < ms) {
    try { const result = await fn(); if (result) return result; } catch (e) { lastError = e; }
    if (proc && proc.exitCode !== null) throw new Error('Drafter exited early: ' + proc.exitCode);
    await delay(250);
  }
  throw new Error('Smoke timeout: ' + (lastError?.message || 'condition not reached'));
}
async function connect(url) {
  const ws = new WebSocket(url);
  sockets.push(ws);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const item = pending.get(message.id);
    if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout: ' + method)); }, 30000);
    pending.set(key, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: key, method, params }));
  });
  return async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
}
(async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const env = { ...process.env, DRAFTER_USERDATA: userData, DRAFTER_ALLOW_MULTI_INSTANCE: '1',
    DSH_HOME: path.join(userData, 'harness'), CLAUDE_CONFIG_DIR: path.join(userData, 'claude-config') };
  delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(path.join(dist, 'win-unpacked/Drafter.exe'), ['--remote-debugging-port=' + port], {
    cwd: userData, windowsHide: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });
  proc.on('error', (e) => { output += e.message; });
  const pages = () => fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = await until(async () => (await pages()).find((p) => p.url.endsWith('/src/index.html')));
  const evaluate = await connect(page.webSocketDebuggerUrl);
  await until(() => evaluate('!!window.api && !!window.safeMarkdown && !!document.querySelector("#input")'));
  assert.equal(await evaluate('(async()=>{await window.api.setSetting("smokeMarker", "persisted");return (await window.api.getStore()).settings.smokeMarker})()'), 'persisted');
  const markdown = await evaluate(`(() => {
    const host = document.createElement('div');
    host.innerHTML = window.safeMarkdown.render(window.marked, '<style>body{display:none}</style>\\n\\n[x](javascript:alert%281%29)\\n\\n**safe**');
    return { styles: host.querySelectorAll('style').length, links: host.querySelectorAll('a[href]').length, bold: !!host.querySelector('strong') };
  })()`);
  assert.deepEqual(markdown, { styles: 0, links: 0, bold: true });
  const term = await evaluate('window.api.termOpen({})');
  assert.ok(term.ok, term.error);
  await evaluate(`window.api.termClose(${JSON.stringify(term.id)})`);
  // Actual packaged bridge + packaged frontend, loaded by the app's own section navigation.
  assert.equal(await evaluate(`(() => { const b = document.querySelector('#section-switch button[data-sec="harness"]'); if (!b) return false; b.click(); return true; })()`), true);
  const harness = await until(async () => (await pages()).find((p) => p.url.includes('index.electron.html')), 45000);
  const harnessEvaluate = await connect(harness.webSocketDebuggerUrl);
  await until(() => harnessEvaluate('!!window.__DSH_TRANSPORT__ && !!window.__DSH_BOOT__ && document.body.innerText.length > 30'), 45000);
  assert.equal(await evaluate('document.querySelector("#harness-status").classList.contains("hidden")'), true);
  console.log(JSON.stringify({ packagedUi: true, storeIpc: true, safeMarkdown: true, terminal: true, harnessUi: true, userData }));
})().catch((e) => { console.error(e.stack); console.error(output.slice(-6000)); process.exitCode = 1; })
  .finally(async () => {
    for (const socket of sockets) socket.close();
    if (proc && proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await Promise.race([exited, delay(3000)]);
    }
    // Preserve isolated logs for diagnosis; never touch the user's real profile.
  });
