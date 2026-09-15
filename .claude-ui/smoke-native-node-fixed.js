const CDP = 'http://127.0.0.1:9244';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws; let seq = 0; const pending = new Map();
async function connect() {
  for (let i = 0; i < 40; i++) {
    try { const list = await (await fetch(CDP + '/json/list')).json(); const page = list.find(x => x.type === 'page' && x.url.includes('index.html')); if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); return; } } catch {}
    await sleep(500);
  }
  throw new Error('CDP page unavailable');
}
function evalCdp(expression) { return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); }); }
async function run(expression) { const msg = await evalCdp(expression); if (msg.error) throw new Error(msg.error.message); const r = msg.result; if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed'); return r.result ? r.result.value : undefined; }
(async () => {
  await connect();
  ws.onmessage = ({ data }) => { const msg = JSON.parse(data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); } };
  await run(`document.querySelector('#section-switch button[data-sec="canvas"]').click()`); await sleep(1800);
  await run(`document.getElementById('btn-new-session').click()`); await sleep(800);
  await run(`document.getElementById('cv-node-search').value='CLIPTextEncode'; document.getElementById('cv-node-search').dispatchEvent(new Event('input',{bubbles:true}))`); await sleep(400);
  const before = await run(`document.querySelectorAll('#drawflow .drawflow-node').length`);
  await run(`document.querySelector('#cv-node-categories .cv-cat-node').click()`); await sleep(500);
  const summary = await run(`JSON.stringify({before,nodes:document.querySelectorAll('#drawflow .drawflow-node').length,external:!!document.querySelector('#drawflow .cv-nt-external'),inspector:document.getElementById('cv-inspector-title')?.textContent||'',multiline:!!document.querySelector('#drawflow textarea'),minimap:document.querySelectorAll('#cv-minimap .cv-minimap-node').length,categories:document.querySelectorAll('#cv-node-categories .cv-cat').length})`);
  console.log(summary);
  if (!JSON.parse(summary).external) throw new Error('external node missing');
  ws.close();
})().catch(error => { console.error('SMOKE_FAIL', error.stack || error.message); process.exit(1); });
