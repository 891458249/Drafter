// 端到端冒烟:真实视频 → extractVideoFrames(Electron Chromium 抽帧)→ aux.analyzeMedia
// 走真 Kuro key + 网关,验证 v0.15.12 生产链路(图像通道)。只打 key 末 4 位。
// 兜底:若 require('electron') 返回字符串(被 ELECTRON_RUN_AS_NODE 污染,electron.exe 当 node 跑)
// 或纯 node 启动,用干净环境显式重启一次 electron 二进制。
// 注意:run-as-node 模式下 process.versions.electron 仍被定义,不能用它判定。
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'probe-extract-e2e.out.txt');
const TAG = process.env._PROBE_CHILD ? '[child]' : '[parent]';
const log = (s) => { const l = TAG + ' ' + s; try { fs.appendFileSync(OUT, l + '\n'); } catch {} try { console.log(l); } catch {} };
if (!process.env._PROBE_CHILD) { try { fs.writeFileSync(OUT, ''); } catch {} }
const _electron = require('electron');
if (typeof _electron === 'string' || !_electron.app) {
  log('respawn: typeof electron=' + typeof _electron + ' RUN_AS_NODE=' + String(process.env.ELECTRON_RUN_AS_NODE));
  const { spawnSync } = require('child_process');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  env._PROBE_CHILD = '1';
  const exe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  const r = spawnSync(exe, [__filename], { env, stdio: 'inherit' });
  log('child exited status=' + r.status + ' signal=' + r.signal + ' error=' + (r.error && r.error.message));
  process.exit(r.status == null ? 1 : r.status);
}
const { app, BrowserWindow } = _electron;
// 关键:抽帧用隐藏窗口销毁后 Electron 默认行为是 window-all-closed→quit,
// 会在 analyzeMedia 的 fetch 途中把进程杀掉(症状:await 处无声退出,EXIT 0)。探针须拦住。
app.on('window-all-closed', () => {});
process.on('uncaughtException', (e) => { log('UNCAUGHT ' + (e && e.stack || e)); process.exit(1); });
process.on('unhandledRejection', (e) => { log('UNHANDLED_REJECTION ' + (e && e.stack || e)); });
process.on('exit', (code) => { log('EXIT code=' + code); });

const aux = require('../src/main/aux-models');
const { extractVideoFrames } = require('../src/main/video-frames');

function loadStore() {
  const base = process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming');
  for (const p of [path.join(base, 'Drafter', 'drafter-store.json'), path.join(base, 'drafter', 'drafter-store.json')]) {
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); const k = j.settings && j.settings.apiKeys; if (Array.isArray(k) && k.length) return { s: j.settings, k }; } catch {}
  }
  return null;
}

const VIDEO = 'C:\\Users\\dingyongzhen\\Desktop\\37440784200-1-192.mp4';

app.whenReady().then(async () => {
  try {
    const f = loadStore();
    if (!f) { log('NO_STORE'); return; }
    const aux0 = f.s.auxModels || {};
    let key, model;
    if (aux0.video && aux0.video.includes('|')) {
      const i = aux0.video.indexOf('|');
      key = f.k.find((x) => x.id === aux0.video.slice(0, i));
      model = aux0.video.slice(i + 1);
    }
    if (!key) { key = f.k.find((x) => /kurogames/i.test(x.baseUrl || '')) || f.k[0]; model = model || 'gpt-6-astra'; }
    log('key ' + key.id + ' ' + key.name + ' …' + (key.key || '').slice(-4) + ' model ' + model);
    log('video ' + VIDEO + ' ' + (fs.existsSync(VIDEO) ? 'exists' : 'MISSING'));

    // 0) 裸 fetch 探活(先验证 Electron 主进程网络栈)
    try {
      const base = (key.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
      const probeRes = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + key.key } });
      log('raw fetch /v1/models -> ' + probeRes.status);
    } catch (e) {
      log('raw fetch threw: ' + (e && e.message));
    }

    // 1) 抽帧
    const t0 = Date.now();
    const ext = await extractVideoFrames(VIDEO, { frames: 4 });
    log('extract ' + (ext.ok ? 'ok' : 'FAIL') + ' ' + (ext.ok ? `frames=${ext.frames.length} dur=${ext.duration}s ${ext.width}x${ext.height}` : ext.error) + ` ${Date.now() - t0}ms`);
    if (!ext.ok) return;

    // 2) 走 analyzeMedia(注入抽帧器)→ 真网关
    log('step2: begin analyzeMedia');
    const deps = { extractFrames: async () => { log('step2: extractFrames injected called'); return ext; } };
    const t1 = Date.now();
    const r = await aux.analyzeMedia(key, model, { name: '37440784200-1-192.mp4', mediaKind: 'video', filePath: VIDEO }, { deps });
    log('analyzeMedia ' + (r.ok ? 'ok' : 'FAIL') + ` ${Date.now() - t1}ms`);
    if (r.ok) log('TEXT>>> ' + r.text.slice(0, 400));
    else log('ERR>>> ' + (r.error || '').slice(0, 400));
  } catch (e) {
    log('FATAL ' + (e && e.message));
  } finally {
    log('DONE');
    app.quit();
  }
});
