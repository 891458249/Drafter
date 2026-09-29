// 端到端:同一 model-guard 会话,对真实 Kuro 网关先 anthropic 后 openai(经 oai-proxy 翻译)各发一次流式请求。
// 用隔离 userData(临时目录),只把 Kuro Key 复制进去;不打印 Key;max_tokens 16。
const fs = require('fs'); const os = require('os'); const path = require('path');
const real = JSON.parse(fs.readFileSync(process.env.APPDATA + '/Drafter/drafter-store.json', 'utf8'));
const kuro = (real.settings.apiKeys || []).find((x) => x.name === 'Kuro');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-protocol-'));
const { installElectronStub } = require('../test/helpers/electron-stub');
installElectronStub(tmp);
const store = require('../src/main/store');
const guard = require('../src/main/model-guard-proxy');
const oai = require('../src/main/oai-proxy');
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['claude-sonnet-5'];
(async () => {
  let protocol = 'anthropic';
  try {
    store.setSetting('apiKeys', [{ ...kuro, id: 'k_probe', enabled: true, modelsEnabled: null, models }]);
    await guard.start(); await oai.start();
    guard.register({ sid: 'p1', keyId: 'k_probe', getAllowedModels: () => models, getProtocol: () => protocol });
    for (const model of models) for (const p of ['anthropic', 'openai']) {
      protocol = p;
      const t0 = Date.now();
      const r = await fetch(guard.baseUrlFor('p1') + '/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(90000),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + kuro.key },
        body: JSON.stringify({ model, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'reply with: ok' }] }),
      });
      const text = await r.text();
      const deltas = [...text.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1]).join('');
      console.log(`${model} ${p} status=${r.status} ${Date.now() - t0}ms stop=${/message_stop/.test(text)} text=${JSON.stringify(deltas || text.slice(0, 200))}`);
    }
  } catch (e) { console.log('ERR', e.message); }
  finally {
    await guard.stop(); await oai.stop();
    try { store.flush && store.flush(); } catch {}
    setTimeout(() => { fs.rmSync(tmp, { recursive: true, force: true }); console.log('tmp removed', !fs.existsSync(tmp)); }, 300);
  }
})();
