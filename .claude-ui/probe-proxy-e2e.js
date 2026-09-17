// 端到端验证:用真实 temp key(xhspeed.xyz,当前被 SNI 阻断)打修复后的 oai-proxy,
// 复现用户报错路径,确认 504 错误信息现在包含网关 host + 底层 ECONNRESET + 人话提示。
// store 只复制只读,不写回真实配置;key 不出本机。结果写 PROBE_OUT。
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, 'probe-proxy-e2e.out.txt');
fs.writeFileSync(OUT, '');
const log = (s) => fs.appendFileSync(OUT, `[${new Date().toISOString().slice(11, 19)}] ${s}\n`);

const watchdog = setTimeout(() => { log('WATCHDOG exit'); log('PROBE-DONE'); process.exit(3); }, 90000);
watchdog.unref();

(async () => {
  // 1) 复制真实 store 到临时 userData,装 electron stub
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-proxy-e2e-'));
  const realStore = path.join(process.env.APPDATA, 'Drafter', 'drafter-store.json');
  fs.copyFileSync(realStore, path.join(tmp, 'drafter-store.json'));
  const { installElectronStub } = require('../test/helpers/electron-stub');
  installElectronStub(tmp);

  const keys = require('../src/main/keys');
  const proxy = require('../src/main/oai-proxy');
  const entry = keys.byId('k_c23c0517');
  if (!entry) { log('FATAL: temp key not found'); return; }
  log(`key: ${entry.name} baseUrl=${entry.baseUrl} protocol=${entry.protocol}`);

  await proxy.start();
  const t0 = Date.now();
  try {
    const res = await fetch(proxy.baseUrlFor('k_c23c0517') + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + entry.key },
      body: JSON.stringify({ model: 'gpt-6-astra', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const ms = Date.now() - t0;
    const json = await res.json();
    log(`HTTP ${res.status} (${ms}ms)`);
    log(`error.message = ${json.error && json.error.message}`);
    const m = (json.error && json.error.message) || '';
    const ok = res.status === 504 && m.includes('xhspeed.xyz') && /ECONNRESET/.test(m) && m.includes('连接被重置');
    log(ok ? 'E2E-OK: 504 且信息完整(host+cause+人话)' : 'E2E-MISMATCH: 内容不符合预期');
  } finally {
    await proxy.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  log('PROBE-DONE');
})().catch((e) => { log('FATAL ' + (e && e.stack || e)); log('PROBE-DONE'); });
