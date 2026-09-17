// 探针:诊断 temp key(xhspeed.xyz)经 oai-proxy 报「504 上游请求失败:fetch failed」的根因。
// 读取本机 Drafter store 中的 temp key,逐级测试 DNS/TCP/TLS/GET models/POST chat(非流式+流式),
// 每一步记录耗时;错误完整展开 cause 链(code/errno/syscall)。结果增量写 PROBE_OUT。
// 只读 store,不写回;不打印完整 key。
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');

const OUT = path.join(__dirname, 'probe-xhspeed.out.txt');
fs.writeFileSync(OUT, '');
const log = (s) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`; fs.appendFileSync(OUT, line + '\n'); };

function errChain(e) {
  const parts = [];
  let cur = e, depth = 0;
  while (cur && depth < 6) {
    const bits = [cur.name || '?', cur.message || ''];
    for (const k of ['code', 'errno', 'syscall', 'address', 'port', 'hostname']) if (cur[k] !== undefined) bits.push(`${k}=${cur[k]}`);
    parts.push(bits.join(' '));
    cur = cur.cause; depth++;
  }
  return parts.join('  <=  ');
}

function timeit(fn) {
  const t0 = Date.now();
  return Promise.resolve().then(fn).then(
    (v) => ({ ok: true, ms: Date.now() - t0, v }),
    (e) => ({ ok: false, ms: Date.now() - t0, e }));
}

function tcpConnect(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const kill = setTimeout(() => { s.destroy(); reject(new Error('tcp connect probe-timeout 15s')); }, 15000);
    s.once('connect', () => { clearTimeout(kill); s.end(); resolve(); });
    s.once('error', (e) => { clearTimeout(kill); reject(e); });
  });
}

function tlsHandshake(host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true });
    const kill = setTimeout(() => { s.destroy(); reject(new Error('tls handshake probe-timeout 15s')); }, 15000);
    s.once('secureConnect', () => {
      clearTimeout(kill);
      const cert = s.getPeerCertificate();
      const info = { protocol: s.getProtocol(), alpn: s.alpnProtocol, subject: cert && cert.subject && cert.subject.CN, issuer: cert && cert.issuer && cert.issuer.CN, validTo: cert && cert.valid_to };
      s.end(); resolve(info);
    });
    s.once('error', (e) => { clearTimeout(kill); reject(e); });
  });
}

async function fetchStep(label, url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`probe abort after ${timeoutMs}ms`)), timeoutMs);
  const r = await timeit(async () => {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, ct: res.headers.get('content-type'), body: text.slice(0, 400) };
  });
  clearTimeout(timer);
  if (r.ok) log(`${label}: HTTP ${r.v.status} (${r.ms}ms) ct=${r.v.ct} body=${JSON.stringify(r.v.body.slice(0, 300))}`);
  else log(`${label}: FAIL (${r.ms}ms) ${errChain(r.e)}`);
  return r;
}

async function fetchStreamStep(label, url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`probe abort after ${timeoutMs}ms`)), timeoutMs);
  const r = await timeit(async () => {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return { status: res.status, body: (await res.text()).slice(0, 300), chunks: 0 };
    let chunks = 0, bytes = 0, first = '';
    for await (const c of res.body) {
      chunks++; bytes += c.length;
      if (first.length < 200) first += Buffer.from(c).toString('utf8');
      if (bytes > 4000) break; // 够看了,主动中止
    }
    return { status: res.status, chunks, bytes, first: first.slice(0, 200) };
  });
  clearTimeout(timer);
  if (r.ok) log(`${label}: HTTP ${r.v.status} chunks=${r.v.chunks} bytes=${r.v.bytes} (${r.ms}ms) first=${JSON.stringify((r.v.first || r.v.body || '').slice(0, 180))}`);
  else log(`${label}: FAIL (${r.ms}ms) ${errChain(r.e)}`);
  return r;
}

// 全局看门狗:任何阶段卡死最多 300s 强制收尾,保证进程自行退出(自清理)
const watchdog = setTimeout(() => { log('WATCHDOG: forced exit after 300s'); log('PROBE-DONE'); process.exit(3); }, 300000);
watchdog.unref();

(async () => {
  const storePath = path.join(process.env.APPDATA, 'Drafter', 'drafter-store.json');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const entry = (store.settings.apiKeys || []).find((k) => k.id === 'k_c23c0517');
  if (!entry) { log('FATAL: temp key not found'); return; }
  const key = entry.key;
  log(`key: name=${entry.name} kind=${entry.kind} protocol=${entry.protocol} baseUrl=${entry.baseUrl} tail=…${key.slice(-6)} len=${key.length} prefix=${key.slice(0, 7)}…`);
  log(`models cache: ${JSON.stringify(entry.models)} at ${new Date(entry.modelsAt).toISOString()}`);

  const host = 'xhspeed.xyz';
  let r;
  r = await timeit(() => dns.lookup(host, { all: true }));
  log(r.ok ? `DNS: ${JSON.stringify(r.v)} (${r.ms}ms)` : `DNS FAIL (${r.ms}ms) ${errChain(r.e)}`);

  r = await timeit(() => tcpConnect(host, 443));
  log(r.ok ? `TCP 443: ok (${r.ms}ms)` : `TCP 443 FAIL (${r.ms}ms) ${errChain(r.e)}`);

  r = await timeit(() => tlsHandshake(host));
  log(r.ok ? `TLS: ok (${r.ms}ms) ${JSON.stringify(r.v)}` : `TLS FAIL (${r.ms}ms) ${errChain(r.e)}`);

  const hApiKey = { 'content-type': 'application/json', 'x-api-key': key };
  const hBearer = { 'content-type': 'application/json', authorization: `Bearer ${key}` };

  // 1) GET /v1/models —— 两种认证头都试
  await fetchStep('GET models [x-api-key]', 'https://xhspeed.xyz/v1/models', { headers: hApiKey }, 20000);
  await fetchStep('GET models [Bearer]  ', 'https://xhspeed.xyz/v1/models', { headers: hBearer }, 20000);

  // 2) POST chat/completions 非流式(与 oai-proxy 完全同构:x-api-key)
  const chatBody = (stream) => JSON.stringify({
    model: 'gpt-6-astra',
    messages: [{ role: 'user', content: '用一句话回答:1+1=?' }],
    max_completion_tokens: 32,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  });
  await fetchStep('POST chat non-stream [x-api-key]', 'https://xhspeed.xyz/v1/chat/completions', { method: 'POST', headers: hApiKey, body: chatBody(false) }, 120000);
  await fetchStep('POST chat non-stream [Bearer]  ', 'https://xhspeed.xyz/v1/chat/completions', { method: 'POST', headers: hBearer, body: chatBody(false) }, 120000);

  // 3) POST 流式(oai-proxy 在 body.stream 时的真实路径)
  await fetchStreamStep('POST chat stream [x-api-key]', 'https://xhspeed.xyz/v1/chat/completions', { method: 'POST', headers: hApiKey, body: chatBody(true) }, 120000);

  // 4) 对照组:Kuro 网关 GET models(证明本机网络栈没问题)
  const kuro = (store.settings.apiKeys || []).find((k) => k.id === 'k_626eb34c');
  if (kuro) {
    await fetchStep('CTRL GET Kuro models', 'https://ai-gateway.kurogames.com/v1/models?limit=1', { headers: { authorization: `Bearer ${kuro.key}`, 'anthropic-version': '2023-06-01' } }, 15000);
  }

  log('PROBE-DONE');
})().catch((e) => { log('FATAL ' + errChain(e)); log('PROBE-DONE'); });
