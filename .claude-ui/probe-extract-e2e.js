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
// 受管启动环境没有 TTY,子进程 stdout 不可见;且父进程 respawn 用 spawnSync 会阻塞等待。
// 所以只要不是真 Electron(无论是否 RUN_AS_NODE),都直接重启为干净环境的 electron 子进程。
if (typeof _electron === 'string' || !_electron.app) {
  log('respawn: typeof electron=' + typeof _electron + ' RUN_AS_NODE=' + String(process.env.ELECTRON_RUN_AS_NODE) + ' _PROBE_CHILD=' + String(process.env._PROBE_CHILD));
  const { spawn } = require('child_process');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  env._PROBE_CHILD = '1';
  const exe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  // 子进程 stderr 并入日志文件:Electron 早期崩溃(缺 DLL/沙箱等)只写 stderr,
  // stdio:'ignore' 会让死因完全不可见(本轮两次静默死亡的教训)。
  let fd = null;
  try { fd = fs.openSync(OUT, 'a'); } catch {}
  const stdio = fd == null ? 'ignore' : ['ignore', fd, fd];
  let child = null;
  try {
    child = spawn(exe, [__filename], { env, stdio, detached: false });
    log('spawned child pid=' + child.pid);
  } catch (e) {
    log('spawn threw: ' + (e && e.message));
    process.exit(1);
  }
  child.on('exit', (code, sig) => { log('child exited status=' + code + ' signal=' + sig); process.exit(code == null ? 1 : code); });
  child.on('error', (e) => { log('child spawn error: ' + (e && e.message)); process.exit(1); });
  // 父进程保持存活直到子进程结束(不退出,避免受管 scope 误判提前结束)
} else {
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

    // 0) 裸 fetch 探活(先验证 Electron 主进程网络栈)——20s 超时,并与 Node https 栈对照
    const base = (key.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
    try {
      const tF = Date.now();
      const probeRes = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + key.key }, signal: AbortSignal.timeout(20000) });
      log('raw fetch /v1/models -> ' + probeRes.status + ' ' + (Date.now() - tF) + 'ms');
    } catch (e) {
      log('raw fetch threw: ' + (e && e.message));
    }
    try {
      const tH = Date.now();
      await new Promise((resolve, reject) => {
        const req = require('https').get(base + '/v1/models', { headers: { Authorization: 'Bearer ' + key.key }, timeout: 20000 }, (res) => {
          log('node https /v1/models -> ' + res.statusCode + ' ' + (Date.now() - tH) + 'ms');
          res.resume(); resolve();
        });
        req.on('timeout', () => { req.destroy(new Error('https timeout')); });
        req.on('error', reject);
      });
    } catch (e) {
      log('node https threw: ' + (e && e.message));
    }

    // 1) 抽帧(不传 frames → auto 时长分档;79.5s 应取 6)
    const t0 = Date.now();
    const ext = await extractVideoFrames(VIDEO);
    log('extract ' + (ext.ok ? 'ok' : 'FAIL') + ' ' + (ext.ok
      ? `frames=${ext.frames.length} dur=${ext.duration}s ${ext.width}x${ext.height} scenes=${ext.scenes} scanned=${ext.scanned} t=[${ext.frames.map((f) => f.t).join(',')}]`
      : ext.error) + ` ${Date.now() - t0}ms`);
    if (!ext.ok) return;

    // 2) 走生产注入链 injectMedia(媒体块 → resolveMediaRef → analyzeMedia,
    //    配置 key 429 时应自动兜底到其他 key 的模型,v0.15.15)
    log('step2: begin injectMedia (production path, cross-key fallback)');
    const t1 = Date.now();
    const out = await aux.injectMedia([
      { type: 'media_ref', mediaKind: 'video', name: '37440784200-1-192.mp4', path: VIDEO, size: fs.statSync(VIDEO).size },
      { type: 'text', text: '测试一下,描述视频内容' },
    ], {
      auxModels: aux0,
      keysById: (id) => f.k.find((x) => x.id === id) || null,
      listKeys: () => f.k,
      onStatus: (m) => log('status: ' + m),
    });
    log('injectMedia done ' + (Date.now() - t1) + 'ms');
    const t0txt = out && out[0] && out[0].text || '';
    log('block0 ' + (t0txt.startsWith('<附件分析') ? 'ANALYSIS-OK' : 'META-FALLBACK'));
    log('TEXT>>> ' + t0txt.slice(0, 500));
  } catch (e) {
    log('FATAL ' + (e && e.message));
  } finally {
    log('DONE');
    app.quit();
  }
});
}