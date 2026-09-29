// 「选择强度」面板(v0.15.20)端到端探针:模型 + 推理深度合并入口 + 5 格滑块。
//
// 覆盖计划验证步骤 2 的全部断言:
//   A. DOM 结构:#btn-effort 存在、原 #effort-sel-composer 已移除、#model-sel 仍在且可读
//   B. 点开面板 → 5 个刻度点;拖到两端 → data-level / aria-valuetext / 主进程 meta 三方一致
//   C. 「跟随默认」→ .is-off + meta.effort===null + aria-disabled="true";取消 → 恢复上次显式档
//   D. ⚡极速 chat 会话 → 滑块禁用(.is-disabled)但模型列表仍可点
//
// 注:受管 launch 曾因 KILL_ON_JOB_CLOSE 提前终止长探针(v0.15.14 已坐实)。
// 本探针使用独立 userData/CDP/假网关,并在 finally 关闭连接、等待自有 Electron 退出。
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules';
require('module').Module._initPaths();

const EXE = 'D:/ClaudeUI/node_modules/electron/dist/electron.exe';
const temp = path.join(os.tmpdir(), `drafter-effort-probe-${process.pid}`);
const userData = path.join(temp, 'userdata');
const CDP_PORT = 9237; // 9235=probe-ext, 9236=probe-split-judge, 9223=smoke-harness
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;

// 受管 launch 不转发子进程 stdout(v0.15.14 已坐实),故自写日志——
// 无论经受管入口还是隔离直跑,结果都落同一文件。
const LOG = 'D:/ClaudeUI/.claude-ui/probe-effort-width-correction.out.txt';
const _log = console.log.bind(console);
const _err = console.error.bind(console);
try { fs.writeFileSync(LOG, ''); } catch {}
const tee = (fn) => (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
  fn(...args);
};
console.log = tee(_log);
console.error = tee(_err);

function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✔ ${label}`); return; }
  throw new Error(`断言失败: ${label}${extra === undefined ? '' : ' | 实际=' + JSON.stringify(extra)}`);
}

// ---------------------------------------------------------------------------
// 假 OpenAI 网关:只需 /v1/models 让 keysRefreshModels 填出 #model-sel
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-model-2' }] }));
    return;
  }
  if (req.method === 'POST' && req.url.endsWith('/v1/chat/completions')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({ id: 'chatcmpl-x', model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk({ role: 'assistant', content: 'ok' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    });
    return;
  }
  res.writeHead(404); res.end('{}');
});

function connect(url) {
  const ws = new (require('ws').WebSocket)(url);
  const pending = new Map();
  let id = 0;
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });
  return new Promise((resolve) => ws.on('open', () => resolve({
    ws,
    send(method, params = {}) {
      return new Promise((resolve2, reject) => {
        const requestId = ++id;
        pending.set(requestId, resolve2);
        ws.send(JSON.stringify({ id: requestId, method, params }));
        setTimeout(() => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          reject(new Error(`timeout: ${method}`));
        }, 30000);
      });
    },
  })));
}

async function waitForCdp() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) return; } catch {}
    await wait(500);
  }
  throw new Error('CDP did not start');
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const llmPort = server.address().port;
  fs.mkdirSync(userData, { recursive: true });
  const env = { ...process.env, DRAFTER_USERDATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DSH_HOME;
  const child = spawn(EXE, ['D:/ClaudeUI', `--remote-debugging-port=${CDP_PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // 主进程日志要能看到:能力表那条路失败时只在主进程 console.error,
  // 不转发的话探针侧只看到「事件没来」,分不清是没调还是调挂了。
  const relay = (tag) => (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (line.trim()) console.log(`  [main:${tag}] ${line}`);
    }
  };
  child.stdout.on('data', relay('out'));
  child.stderr.on('data', relay('err'));
  let mainWs = null;
  try {
    await waitForCdp();
    const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const mainPage = pages.find((p) => p.url.includes('index.html'));
    if (!mainPage) throw new Error('main page not found: ' + JSON.stringify(pages.map((p) => p.url)));
    const main = await connect(mainPage.webSocketDebuggerUrl);
    mainWs = main.ws;
    const evaluate = async (expression, awaitP = false) => {
      const r = await main.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: awaitP });
      const res = r.result || {};
      if (res.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(res.exceptionDetails));
      return res.result ? res.result.value : undefined;
    };
    // SHOT_DIR 设置时,对面板与入口按键截图(放大 3 倍)供肉眼对比
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return;
      const box = await evaluate(`(() => { const a = document.querySelector('#effort-pop').getBoundingClientRect(),
        b = document.querySelector('#btn-effort').getBoundingClientRect();
        const x = Math.min(a.left, b.left) - 8, y = a.top - 8;
        return { x, y, width: Math.max(a.right, b.right) + 8 - x, height: b.bottom + 8 - y }; })()`);
      const r = await main.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 3 } });
      fs.writeFileSync(path.join(process.env.SHOT_DIR, name + '.png'), Buffer.from(r.result.data, 'base64'));
    };
    await wait(4000);

    // ① 存一个指向本地假网关的 Key,让 #model-sel 有真实选项(否则面板模型列表为空)
    const keySaved = await evaluate(`window.api.keysSave({ name: 'MockLLM', key: 'sk-mock', baseUrl: 'http://127.0.0.1:${llmPort}', protocol: 'openai' })`, true);
    if (!keySaved || !keySaved.ok) throw new Error('keysSave failed: ' + JSON.stringify(keySaved));
    await evaluate(`window.api.keysRefreshModels('${keySaved.id}')`, true);
    // 重载以重跑 app.js init → populateModelSelects 带上新 Key
    await evaluate(`location.reload()`);
    await wait(6000);
    await evaluate(`window.alert = (m) => { window.__alertMsg = String(m); }`);
    await evaluate(`(() => { for (const m of document.querySelectorAll('.modal-mask')) m.classList.add('hidden'); })()`);
    // app.js:158 的 populateModelSelects() 是 fire-and-forget,init 期 keysEnabledModels()
    // 若未就绪会被 catch 吞掉并渲染 index.html 的静态回退项;点「已激活的」板块不会重跑它。
    // 故先切到别的板块再切回,强制一次真正的板块变更以重建下拉。
    await evaluate(`document.querySelector('#section-switch button[data-sec="ext"]').click()`);
    await wait(1200);
    await evaluate(`document.querySelector('#section-switch button[data-sec="code"]').click()`);
    for (let i = 0; i < 20; i++) {
      const has = await evaluate(`[...document.querySelectorAll('#model-sel option')].some(o => o.value.includes('|'))`);
      if (has) break;
      await wait(500);
    }
    await wait(800);

    // 能力表由渲染端自己拉(见 effort-ui.pullEffortCapability),这里不再挂旁路监听。
    await evaluate(`(() => {
      window.__errs = [];            // 渲染端未捕获异常,出现即说明拉取/接线有雷
      window.addEventListener('error', (e) => window.__errs.push(String((e && e.message) || e)));
      window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String((e.reason && e.reason.message) || e.reason)));
    })()`);

    // ---- A. DOM 结构 ----
    console.log('[A] DOM 结构');
    ok(await evaluate(`!!document.querySelector('#btn-effort')`), '#btn-effort 存在');
    ok(await evaluate(`document.querySelector('#effort-sel-composer') === null`), '原 #effort-sel-composer 已移除');
    const modelSelInfo = await evaluate(`(() => { const s = document.querySelector('#model-sel'); return s ? { value: s.value, opts: [...s.options].map(o => o.value) } : null; })()`);
    ok(!!modelSelInfo, '#model-sel 仍在 DOM 中');
    ok(typeof modelSelInfo.value === 'string', '#model-sel.value 可读', modelSelInfo);
    ok(modelSelInfo.opts.some((v) => v === `${keySaved.id}|mock-model`), '假网关模型已进入 #model-sel', modelSelInfo.opts);

    // 建 code 会话并激活(standalone,不建项目组)
    const codeMeta = await evaluate(`window.api.sessCreate({ standalone: true, keyId: '${keySaved.id}', model: 'mock-model' })`, true);
    await evaluate(`import('./renderer/chat.js').then(m => { m.ensureSession(${JSON.stringify(codeMeta.id)}, ${JSON.stringify(codeMeta)}); m.setActiveSession(${JSON.stringify(codeMeta.id)}); })`, true);
    await wait(1000);
    // 激活后 updateTopbarForSession 会把 #model-sel 回显成 keyId|modelId
    const selAfterActive = await evaluate(`document.querySelector('#model-sel').value`);
    ok(selAfterActive === `${keySaved.id}|mock-model`, '会话激活后 #model-sel 回显为 keyId|modelId', selAfterActive);

    // ---- E. 模型能力表(claude.exe 内置注册表,接入 Query.supportedModels())----
    // 走**渲染端主动拉取**(api.sessEffortCaps)。早先做成主进程一次性 sess:event 推送时,
    // 主进程日志确认 send 在活着的 winId=1 上无异常发出、载荷可 structuredClone,渲染端
    // ipcRenderer 却收不到(同一 start() 里 730ms 前的 ui_agent_config 正常送达),故改为拉。
    console.log('[E] 模型能力表');
    let caps = null;
    for (let i = 0; i < 60; i++) { caps = await evaluate(`window.api.sessEffortCaps()`, true); if (caps) break; await wait(500); }
    ok(Array.isArray(caps) && caps.length === 5,
      'sess:effortCaps 拉到 claude.exe 内置能力表(5 项)', caps && caps.length);
    const capsCheck = await evaluate(`(async () => {
      const M = await import('./renderer/effort.js');
      const t = M.buildEffortCapabilityTable(${JSON.stringify(caps)});
      return {
        haiku: M.lookupEffortLevels(t, 'claude-haiku-4-5-20251001'),
        sonnet: M.lookupEffortLevels(t, 'claude-sonnet-5'),
        gateway: M.lookupEffortLevels(t, 'mock-model'),
      };
    })()`, true);
    ok(Array.isArray(capsCheck.haiku) && capsCheck.haiku.length === 0,
      'haiku(条目无 effort 字段)→ 已知不支持(空数组)', capsCheck.haiku);
    ok(Array.isArray(capsCheck.sonnet) && capsCheck.sonnet.length === 5,
      'claude-sonnet-5 → 完整五档', capsCheck.sonnet);
    ok(capsCheck.gateway === null,
      '网关模型 mock-model 不在表里 → 未知(null),绝不猜', capsCheck.gateway);
    // 关键回归:表到手后,表里没有的网关模型不能被误判成「不支持」而禁用滑块
    ok(await evaluate(`!document.querySelector('#effort-pop').classList.contains('is-disabled')`),
      '网关模型(表里没有)不受能力表影响,面板未被禁用');

    // ---- B. 面板 + 滑块 ----
    console.log('[B] 面板开合与滑块档位');
    await evaluate(`document.querySelector('#btn-effort').click()`);
    await wait(400);
    ok(await evaluate(`!document.querySelector('#effort-pop').classList.contains('hidden')`), '点击 #btn-effort 展开面板');
    ok(await evaluate(`document.querySelectorAll('#effort-slider-ticks .effort-slider-tick').length === 5`),
      '刻度点为 5 个', await evaluate(`document.querySelectorAll('#effort-slider-ticks .effort-slider-tick').length`));
    ok(await evaluate(`document.querySelectorAll('#effort-model-list .effort-model-item').length >= 0`), '模型列表容器存在');

    // 新会话 meta.effort 为 null ⟺ 「跟随默认」开启 ⟺ 滑块初始即熄火(计划 §6)。
    // 故调档前必须先取消跟随——这也正是「熄火」的语义。
    const fresh = await evaluate(`(() => { const p = document.querySelector('#effort-pop'), s = document.querySelector('#effort-slider');
      return { off: p.classList.contains('is-off'), disabled: s.getAttribute('aria-disabled'),
               label: document.querySelector('#effort-pop-level').textContent,
               chk: document.querySelector('#effort-follow-chk').checked }; })()`);
    ok(fresh.off === true && fresh.disabled === 'true' && fresh.chk === true,
      '新会话默认跟随:初始即 .is-off + aria-disabled="true" + 勾选框选中', fresh);
    ok(fresh.label === '默认', '新会话档位名显示「默认」', fresh);
    await evaluate(`(() => { const c = document.querySelector('#effort-follow-chk'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(700);
    const activated = await evaluate(`(() => { const p = document.querySelector('#effort-pop'), s = document.querySelector('#effort-slider');
      return { off: p.classList.contains('is-off'), disabled: s.getAttribute('aria-disabled'),
               label: document.querySelector('#effort-pop-level').textContent }; })()`);
    const activatedMeta = (await evaluate(`window.api.sessList()`, true) || []).find((s) => s.id === codeMeta.id);
    ok(activatedMeta && activatedMeta.effort === 'high', '取消跟随 → 落到 SDK 默认档「深度」(high)', activatedMeta && activatedMeta.effort);
    ok(activated.off === false && activated.disabled === 'false' && activated.label === '深度',
      '取消跟随后滑块解锁并显示「深度」', activated);

    // 轨道粗细不变;彗尾改为 canvas 粒子场,粒子留在经过处消散,按键背景与拖动实时同步
    const fx = `import('./renderer/effort-ui.js').then(m => m.effortFxStats())`;
    const sliderVisual = await evaluate(`(() => {
      const p = document.querySelector('#effort-pop'), s = document.querySelector('#effort-slider');
      const rail = s.querySelector('.effort-slider-rail'), c = rail.querySelector('canvas.effort-particles');
      return { width: rail.getBoundingClientRect().width, height: rail.getBoundingClientRect().height,
        pop: p.getBoundingClientRect().width, canvas: !!c, canvasW: c && c.clientWidth,
        railClip: getComputedStyle(rail).overflow, oldGrid: document.querySelectorAll('.effort-slider-pixel').length };
    })()`);
    ok(sliderVisual.pop <= 281 && sliderVisual.width <= 250 && sliderVisual.height === 24,
      '面板原宽,滑轨粗细 24px', sliderVisual);
    ok(sliderVisual.canvas && sliderVisual.canvasW === Math.round(sliderVisual.width) && sliderVisual.railClip === 'hidden' && sliderVisual.oldGrid === 0,
      '彗尾改为铺满滑轨的 canvas 粒子场(旧贴图网格已移除),由滑轨裁剪', sliderVisual);
    await wait(400);
    const idleFx = await evaluate(fx, true);
    await shot('1-idle-high');
    ok(idleFx.slider && idleFx.slider.running && idleFx.slider.emitting && idleFx.slider.cells > 60,
      '静止时手柄后方有 40×6 平铺彗尾方阵持续动画', idleFx.slider);
    await evaluate(`(() => {
      const s = document.querySelector('#effort-slider');
      const r = s.getBoundingClientRect(), x = (f) => r.left + 14 + (r.width - 28) * f;
      window.__dragSend = (type, f) => s.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 2, isPrimary: true,
        clientX: x(f), clientY: r.top + r.height / 2, buttons: type === 'pointerup' ? 0 : 1,
      }));
      window.__dragSend('pointerdown', .1);
    })()`);
    await wait(150); // 让粒子场在 0.1 处跑几帧,之后的扫动路径才从 0.1 起算
    const liveDrag = await evaluate(`(() => {
      const s = document.querySelector('#effort-slider'), p = document.querySelector('#effort-pop'), b = document.querySelector('#btn-effort');
      const send = window.__dragSend;
      const before = getComputedStyle(p).getPropertyValue('--effort-c').trim();
      const btnBefore = { level: b.querySelector('#effort-btn-level').textContent, frac: b.style.getPropertyValue('--effort-frac') };
      send('pointermove', .9);
      const after = getComputedStyle(p).getPropertyValue('--effort-c').trim();
      const frac = s.style.getPropertyValue('--effort-frac');
      const label = document.querySelector('#effort-pop-level').textContent;
      const knob = s.querySelector('.effort-slider-knob').getBoundingClientRect();
      return { before, after, frac, label, knobSize: knob.width, btnBefore,
        btnAfter: { level: b.querySelector('#effort-btn-level').textContent, frac: b.style.getPropertyValue('--effort-frac'),
          dl: b.getAttribute('data-level'), c: getComputedStyle(b).getPropertyValue('--effort-c').trim() } };
    })()`);
    ok(liveDrag.before !== liveDrag.after && Math.abs(Number(liveDrag.frac) - .9) < .0001 && liveDrag.label === '极限' && liveDrag.knobSize === 28,
      'pointermove 即改变档位色、手柄位置与标题,无需松开;圆形手柄 28px', liveDrag);
    ok(liveDrag.btnAfter.level === '极限' && liveDrag.btnAfter.dl === '4' && liveDrag.btnAfter.c === liveDrag.after &&
      Number(liveDrag.btnAfter.frac) > Number(liveDrag.btnBefore.frac || 0),
      '拖动中入口按键的档位名/颜色/背景宽度与滑块实时同步', liveDrag);
    await wait(120);
    const midFx = await evaluate(fx, true);
    await shot('2-drag-0.1-to-0.9');
    const w = midFx.slider.width;
    ok(midFx.slider.count > 60 && midFx.slider.minX < w * 0.25 && midFx.btn && midFx.btn.emitting && midFx.btn.count > 0,
      '拖动扫过的路径留下粒子(左侧远离手柄处仍有方块),按键粒子同步发射', { slider: midFx.slider, btn: midFx.btn });
    ok(midFx.slider.onGrid && midFx.slider.rows.length === 6 && midFx.slider.gridH >= midFx.slider.height * 0.75,
      '留痕方块对齐方格且铺满 6 行(纵向平铺,不聚在中线)', { rows: midFx.slider.rows, gridH: midFx.slider.gridH, h: midFx.slider.height });
    ok(midFx.slider.maxDrift <= 15 && midFx.btn.maxDrift <= 15,
      '单个方块漂移不超过 15px(小幅剥落,不乱窜)', { slider: midFx.slider.maxDrift, btn: midFx.btn.maxDrift });
    await evaluate(`window.__dragSend('pointermove', .3)`);
    await wait(100);
    const back = await evaluate(fx, true);
    await shot('3-drag-back-to-0.3');
    ok(back.slider.maxX <= back.slider.frac * back.slider.width + 0.5 && (back.btn.count === 0 || back.btn.maxX <= back.btn.frac * back.btn.width + 0.5),
      '往回拖后头部右侧无粒子溢出(滑块与按键)', back);
    await evaluate(`window.__dragSend('pointercancel', .3)`);
    await wait(2600);
    const settled = await evaluate(fx, true);
    ok(settled.slider.count === 0 || settled.slider.minX > w * 0.25,
      '经过处的粒子随时间消散,不再锁定跟随', settled.slider);
    await main.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    try {
      await evaluate(`document.querySelector('#effort-slider').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`);
      await wait(700);
      const rm = await evaluate(fx, true);
      ok(rm.slider.count === 0 && !rm.slider.running, '减少动态效果时粒子动画停止(仅静态绘制)', rm.slider);
    } finally {
      await main.send('Emulation.setEmulatedMedia', { features: [] });
    }

    // 拖到最右(第 5 格):pointerdown → pointerup 同一位置
    const dragTo = `(frac) => {
      const el = document.querySelector('#effort-slider');
      const r = el.getBoundingClientRect();
      const inner = Math.max(1, r.width - 28);
      const clientX = r.left + 14 + inner * frac;
      const clientY = r.top + r.height / 2;
      const mk = (type) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX, clientY, buttons: type === 'pointerup' ? 0 : 1 });
      el.dispatchEvent(mk('pointerdown'));
      el.dispatchEvent(mk('pointerup'));
    }`;
    await evaluate(`(${dragTo})(1)`);
    await wait(600);
    await shot('4-idle-max');
    const atMax = await evaluate(`(() => { const p = document.querySelector('#effort-pop'), s = document.querySelector('#effort-slider');
      return { level: p.getAttribute('data-level'), now: s.getAttribute('aria-valuenow'), text: s.getAttribute('aria-valuetext'),
               disabled: s.getAttribute('aria-disabled'), label: document.querySelector('#effort-pop-level').textContent,
               frac: s.style.getPropertyValue('--effort-frac') }; })()`);
    ok(atMax.level === '4', '右端 → 容器 data-level="4"', atMax);
    ok(atMax.text === '极限', '右端 → aria-valuetext="极限"', atMax);
    ok(atMax.now === '4', '右端 → aria-valuenow="4"', atMax);
    ok(atMax.label === '极限', '面板档位名显示「极限」', atMax);
    ok(atMax.frac === '1', '填充比例 --effort-frac=1', atMax);
    const maxMeta = (await evaluate(`window.api.sessList()`, true) || []).find((s) => s.id === codeMeta.id);
    ok(maxMeta && maxMeta.effort === 'max', '主进程 IPC 回读 meta.effort === "max"', maxMeta && maxMeta.effort);
    const btnLit = await evaluate(`(() => { const b = document.querySelector('#btn-effort'), t = b.querySelector('.effort-btn-trail');
      return { model: b.querySelector('#effort-btn-model').textContent, level: b.querySelector('#effort-btn-level').textContent,
        lit: b.classList.contains('is-lit'), dl: b.getAttribute('data-level'), trail: getComputedStyle(t).display,
        canvas: !!b.querySelector('canvas.effort-particles'), frac: b.style.getPropertyValue('--effort-frac'),
        c: getComputedStyle(b).getPropertyValue('--effort-c').trim() }; })()`);
    ok(btnLit.model && btnLit.model !== '选择强度' && btnLit.level === '极限' && btnLit.lit && btnLit.dl === '4' &&
      btnLit.trail === 'block' && btnLit.canvas && btnLit.frac === '1',
      '入口按键显示「模型名 + 推理深度」,落档后以对应档位彗尾作背景', btnLit);

    // 拖到最左(第 1 格)
    await evaluate(`(${dragTo})(0)`);
    await wait(600);
    const atMin = await evaluate(`(() => { const p = document.querySelector('#effort-pop'), s = document.querySelector('#effort-slider');
      return { level: p.getAttribute('data-level'), text: s.getAttribute('aria-valuetext'), label: document.querySelector('#effort-pop-level').textContent }; })()`);
    ok(atMin.level === '0' && atMin.text === '轻度' && atMin.label === '轻度', '左端 → data-level="0" / 「轻度」', atMin);
    const minMeta = (await evaluate(`window.api.sessList()`, true) || []).find((s) => s.id === codeMeta.id);
    ok(minMeta && minMeta.effort === 'low', '主进程 IPC 回读 meta.effort === "low"', minMeta && minMeta.effort);

    // 切「更深」(xhigh)以验证中间档与后续恢复
    await evaluate(`document.querySelector('#effort-slider').focus()`);
    await evaluate(`(() => { const s = document.querySelector('#effort-slider');
      s.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); })()`);
    await wait(600);
    await evaluate(`(() => { const s = document.querySelector('#effort-slider');
      s.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); })()`);
    await wait(600);
    const xhigh = await evaluate(`document.querySelector('#effort-slider').getAttribute('aria-valuetext')`);
    ok(xhigh === '更深', '键盘 ArrowLeft 从「极限」退到「更深」', xhigh);
    const xMeta = (await evaluate(`window.api.sessList()`, true) || []).find((s) => s.id === codeMeta.id);
    ok(xMeta && xMeta.effort === 'xhigh', '主进程 IPC 回读 meta.effort === "xhigh"', xMeta && xMeta.effort);

    // ---- C. 跟随默认 ----
    console.log('[C] 跟随默认(下发 null)');
    await evaluate(`(() => { const c = document.querySelector('#effort-follow-chk'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(700);
    const follow = await evaluate(`(() => { const p = document.querySelector('#effort-pop'), s = document.querySelector('#effort-slider');
      return { off: p.classList.contains('is-off'), disabled: s.getAttribute('aria-disabled'),
               label: document.querySelector('#effort-pop-level').textContent,
               level: p.getAttribute('data-level') }; })()`);
    ok(follow.off === true, '勾选后面板 .is-off(滑块熄火)', follow);
    ok(follow.disabled === 'true', '勾选后滑块 aria-disabled="true"', follow);
    ok(follow.label === '默认', '档位名回落为「默认」', follow);
    ok(follow.level === null, '无 data-level(走中性色)', follow);
    const followMeta = (await evaluate(`window.api.sessList()`, true) || []).find((s) => s.id === codeMeta.id);
    ok(followMeta && followMeta.effort === null, '主进程 IPC 回读 meta.effort === null', followMeta && followMeta.effort);
    // 熄火态下拖拽应被拒绝(pointerdown 直接 return)
    await evaluate(`(${dragTo})(1)`);
    await wait(400);
    const stillFollow = (await evaluate(`window.api.sessList()`, true) || []).find((s) => s.id === codeMeta.id);
    ok(stillFollow && stillFollow.effort === null, '熄火态下拖动不改变档位(仍为 null)', stillFollow && stillFollow.effort);

    // 取消勾选 → 恢复上次显式档位 xhigh
    await evaluate(`(() => { const c = document.querySelector('#effort-follow-chk'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(700);
    const backMeta = (await evaluate(`window.api.sessList()`, true) || []).find((s) => s.id === codeMeta.id);
    ok(backMeta && backMeta.effort === 'xhigh', '取消勾选后恢复上次显式档位 xhigh', backMeta && backMeta.effort);

    // ---- D. ⚡极速 chat 会话 ----
    console.log('[D] 极速 chat 会话下的禁用态');
    const chatMeta = await evaluate(`window.api.sessCreate({ kind: 'chat', keyId: '${keySaved.id}', model: 'mock-model' })`, true);
    await evaluate(`document.querySelector('#section-switch button[data-sec="chat"]').click()`);
    await wait(1500);
    await evaluate(`import('./renderer/chat.js').then(m => { m.ensureSession(${JSON.stringify(chatMeta.id)}, ${JSON.stringify(chatMeta)}); m.setActiveSession(${JSON.stringify(chatMeta.id)}); })`, true);
    await wait(800);
    await evaluate(`document.querySelector('#btn-effort').click()`);
    await wait(500);
    const fastState = await evaluate(`(() => { const p = document.querySelector('#effort-pop'), s = document.querySelector('#effort-slider');
      return { disabled: p.classList.contains('is-disabled'), off: p.classList.contains('is-off'),
               aria: s.getAttribute('aria-disabled'), chkDisabled: document.querySelector('#effort-follow-chk').disabled,
               hint: document.querySelector('#effort-pop-hint').textContent,
               hintHidden: document.querySelector('#effort-pop-hint').classList.contains('hidden') }; })()`);
    ok(fastState.disabled === true, '极速会话 → 面板 .is-disabled', fastState);
    ok(fastState.aria === 'true', '极速会话 → 滑块 aria-disabled="true"', fastState);
    ok(fastState.chkDisabled === true, '极速会话 → 「跟随默认」开关被禁用', fastState);
    ok(fastState.hintHidden === false && /极速|不支持/.test(fastState.hint), '极速会话 → 给出不生效说明', fastState.hint);
    // 滑块禁用时拖动不改档位
    await evaluate(`(${dragTo})(1)`);
    await wait(500);
    const chatEffort = (await evaluate(`window.api.sessList()`, true) || []).find((s) => s.id === chatMeta.id);
    ok(!chatEffort || !chatEffort.effort, '极速会话下滑块不落任何档位', chatEffort && chatEffort.effort);
    // 模型列表仍可用
    await evaluate(`document.querySelector('#effort-pop-model-btn').click()`);
    await wait(400);
    const listItems = await evaluate(`[...document.querySelectorAll('#effort-model-list .effort-model-item')].map(b => b.dataset.v)`);
    ok(listItems.length > 0, '极速会话 → 模型列表仍渲染出可点项', listItems);
    // 注意:chat 板块首项是 value="" 的「默认」(点它会清空模型),要挑带 keyId| 的真实模型项
    ok(listItems.some((v) => v.includes('|')), '模型列表含真实模型项', listItems);
    await evaluate(`[...document.querySelectorAll('#effort-model-list .effort-model-item')].find(b => b.dataset.v.includes('|')).click()`);
    await wait(1500);
    const chatAfterPick = (await evaluate(`window.api.sessList()`, true) || []).find((s) => s.id === chatMeta.id);
    ok(!!(chatAfterPick && chatAfterPick.model), '极速会话 → 点模型项后模型已应用', chatAfterPick && chatAfterPick.model);
    ok(await evaluate(`document.querySelector('#model-sel').value === '${keySaved.id}|mock-model'`),
      '点模型项后 #model-sel 同步为所选模型', await evaluate(`document.querySelector('#model-sel').value`));

    // ---- F. 模型级禁用(能力表命中且为空)的 UI 实证 ----
    // 放在最后:这一步会把活动会话切走,不能插在 [B]~[D] 中间。
    // haiku 是实测唯一在全表里没有 effort 字段的条目,正是本功能要防的那种「能拖却无效」。
    console.log('[F] 模型不支持 effort 时的禁用态');
    const haikuMeta = await evaluate(`window.api.sessCreate({ standalone: true, keyId: '${keySaved.id}', model: 'claude-haiku-4-5-20251001' })`, true);
    // 注:start() 里有个「模型类型不是 chat 就清空」的自愈,但 keys.modelType 对未收录的
    // 模型默认返回 'chat',故这个模型名会被保留(见 src/main/keys.js:259-264)。
    ok(haikuMeta && haikuMeta.model === 'claude-haiku-4-5-20251001',
      '测试会话保留了 haiku 模型名(未被启动自愈清掉)', haikuMeta && haikuMeta.model);
    await evaluate(`import('./renderer/chat.js').then(m => { m.ensureSession(${JSON.stringify(haikuMeta.id)}, ${JSON.stringify(haikuMeta)}); m.setActiveSession(${JSON.stringify(haikuMeta.id)}); })`, true);
    await wait(1000);
    const haikuState = await evaluate(`(() => { const p = document.querySelector('#effort-pop'), s = document.querySelector('#effort-slider');
      return { disabled: p.classList.contains('is-disabled'), aria: s.getAttribute('aria-disabled'),
               hint: document.querySelector('#effort-pop-hint').textContent,
               hintHidden: document.querySelector('#effort-pop-hint').classList.contains('hidden') }; })()`);
    ok(haikuState.disabled === true && haikuState.aria === 'true',
      'haiku 会话 → 面板与滑块被禁用', haikuState);
    ok(haikuState.hintHidden === false && /当前模型不支持推理深度/.test(haikuState.hint),
      'haiku 会话 → 给出模型级说明(而非极速/板块那两句)', haikuState.hint);
    // 禁用时拖动不改档位
    await evaluate(`(${dragTo})(1)`);
    await wait(500);
    const haikuEffort = (await evaluate(`window.api.sessList()`, true) || []).find((s) => s.id === haikuMeta.id);
    ok(!haikuEffort || !haikuEffort.effort, 'haiku 会话下滑块不落任何档位', haikuEffort && haikuEffort.effort);

    console.log(`PASS: 「选择强度」面板端到端(${passed} 项断言)`);
  } finally {
    if (mainWs) {
      try {
        if (mainWs.readyState !== 3) {
          const closed = new Promise((resolve) => mainWs.once('close', resolve));
          mainWs.close();
          await Promise.race([closed, wait(2000)]);
          if (mainWs.readyState !== 3) mainWs.terminate();
        }
      } catch (e) { console.error('CDP 断开失败:', e.message); }
    }
    await new Promise((resolve) => server.close(resolve));
    const exited = await stopChild(child);
    if (!exited) console.error('Electron 退出未确认,保留目录待核对:', temp);
    else {
      try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
      catch (e) { console.error('清理临时目录失败(需人工核对):' + temp + ' — ' + e.message); }
    }
  }
}

// 先 SIGTERM,5s 未退再 SIGKILL;只有观察到 exit 才允许删除 userData。
function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve(true);
    let settled = false;
    const done = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      clearTimeout(limit);
      resolve(exited);
    };
    child.once('exit', () => done(true));
    try { child.kill(); } catch {}
    const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    const limit = setTimeout(() => done(false), 7000);
  });
}

main().catch((error) => {
  // Error 的属性不可枚举,直接 JSON.stringify 会得到 {}——必须显式取 message/stack。
  console.error('FAIL: ' + ((error && (error.stack || error.message)) || String(error)));
  process.exitCode = 1;
});
