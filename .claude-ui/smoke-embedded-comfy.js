const CDP = 'http://127.0.0.1:9240';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws, seq = 0; const pending = new Map();
async function connect() {
  for (let i = 0; i < 40; i++) {
    try { const pages = await (await fetch(CDP + '/json/list')).json(); const page = pages.find(x => x.type === 'page' && x.url.includes('index.html')); if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } }; return; } } catch {}
    await sleep(500);
  }
  throw new Error('Drafter CDP page unavailable');
}
function call(method, params = {}) { return new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result && r.result.value; }
(async () => {
  await connect();
  await evaluate(`document.querySelector('#section-switch button[data-sec="canvas"]').click()`);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const ready = await evaluate(`(() => { const w=document.getElementById('comfy-canvas-webview'); return w && !w.classList.contains('hidden') && w.getWebContentsId && w.getWebContentsId() > 0; })()`);
    if (ready) break;
  }
  const summary = await evaluate(`(() => { const w=document.getElementById('comfy-canvas-webview'); return JSON.stringify({ visible:!!w&&!w.classList.contains('hidden'), src:w&&w.src, webContentsId:w&&w.getWebContentsId&&w.getWebContentsId(), drawflowHidden:document.getElementById('drawflow').classList.contains('hidden') }); })()`);
  console.log('DRAFTER', summary);
  const pages = await (await fetch(CDP + '/json/list')).json();
  const comfy = pages.find(x => x.type === 'page' && x.url.startsWith('http://127.0.0.1:8188'));
  if (!comfy) throw new Error('Embedded ComfyUI DevTools target unavailable');
  const cws = new WebSocket(comfy.webSocketDebuggerUrl); await new Promise((r,j)=>{cws.onopen=r;cws.onerror=j});
  let id=0; const wait=new Map(); cws.onmessage=({data})=>{const m=JSON.parse(data);if(m.id&&wait.has(m.id)){wait.get(m.id)(m.result);wait.delete(m.id)}};
  const ev=(expression)=>new Promise(resolve=>{const n=++id;wait.set(n,resolve);cws.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression,returnByValue:true}}))});
  await sleep(1500);
  const ui = await ev(`JSON.stringify({title:document.title, nodeText:document.body.innerText.includes('节点'), hasCanvas:!!document.querySelector('canvas'), body:document.body.innerText.slice(0,300)})`);
  console.log('COMFYUI', ui.result && ui.result.value);
  ws.close(); cws.close();
})().catch(e => { console.error('SMOKE_FAIL', e.stack || e.message); process.exit(1); });
