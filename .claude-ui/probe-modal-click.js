// 冒烟:设置面板(及所有 .modal-mask 弹窗)只在「按下+弹起都落在蒙层空白」的完整点击时关闭。
// v0.15.15 修复前用 click 事件:面板内按下→蒙层弹起(拖选文字/拖滑块松手)会误关,
// 蒙层按下→面板内弹起同样误关。本探针用 CDP Input.dispatchMouseEvent 走真实输入管线
// (click 由 Chromium 按最近公共祖先真实合成,合成 Event 复现不了这个行为)。
// 用法:直接 node 跑(脚本自行 spawn dev electron + 干净 userData,结束 kill+清理)。
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules';
require('module').Module._initPaths();

const EXE = 'D:/ClaudeUI/node_modules/electron/dist/electron.exe';
const temp = path.join(os.tmpdir(), `drafter-modal-probe-${process.pid}`);
const userData = path.join(temp, 'userdata');
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), `drafter-modal-probe-${process.pid}.log`);
const port = 9237 + (process.pid % 50);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); flush(); try { console.log(s); } catch {} };
const flush = () => { if (OUT) { try { fs.writeFileSync(OUT, lines.join('\n'), 'utf8'); } catch {} } };

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
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        pending.set(requestId, resolve);
        ws.send(JSON.stringify({ id: requestId, method, params }));
        setTimeout(() => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          reject(new Error(`timeout: ${method}`));
        }, 30000);
      });
    },
    close: () => ws.close(),
  })));
}

async function waitForCdp() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch {}
    await wait(500);
  }
  throw new Error('CDP did not start');
}

async function main() {
  fs.mkdirSync(userData, { recursive: true });
  const env = { ...process.env, DRAFTER_USERDATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DSH_HOME;
  const child = spawn(EXE, ['D:/ClaudeUI', `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForCdp();
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const mainPage = pages.find((p) => p.url.includes('index.html'));
    if (!mainPage) throw new Error('main page not found');
    const main = await connect(mainPage.webSocketDebuggerUrl);
    const evaluate = async (expression) => {
      const r = await main.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || r.result.exceptionDetails));
      return r.result?.result?.value;
    };
    await wait(3000);

    // 打开设置面板,取两个坐标:蒙层空白点(elementFromPoint 必须是 mask 本身)与面板内点
    const geo = await evaluate(`(() => {
      for (const m of document.querySelectorAll('.modal-mask')) m.classList.add('hidden');
      const mask = document.querySelector('#settings-modal');
      mask.classList.remove('hidden');
      const box = mask.querySelector('.modal');
      const r = box.getBoundingClientRect();
      let maskPt = null;
      for (const [x, y] of [[12, 12], [12, innerHeight - 12], [innerWidth - 12, 12], [innerWidth - 12, innerHeight - 12]]) {
        if (document.elementFromPoint(x, y) === mask) { maskPt = { x, y }; break; }
      }
      const innerPt = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      return { maskPt, innerPt, innerHitsMask: document.elementFromPoint(innerPt.x, innerPt.y) === mask, visible: !mask.classList.contains('hidden') };
    })()`);
    log('geo:', JSON.stringify(geo));
    if (!geo.visible || !geo.maskPt) throw new Error('settings modal not open or no blank mask point found');
    if (geo.innerHitsMask) throw new Error('inner point unexpectedly hits mask');

    const mouse = async (type, pt) => {
      await main.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    };
    const visible = () => evaluate(`!document.querySelector('#settings-modal').classList.contains('hidden')`);
    const reopen = async () => {
      await evaluate(`document.querySelector('#settings-modal').classList.remove('hidden')`);
      await wait(150);
    };
    const results = {};

    // A: 面板内按下 → 蒙层弹起(拖选文字松手场景)——不得关闭
    await mouse('mousePressed', geo.innerPt); await wait(120); await mouse('mouseReleased', geo.maskPt); await wait(200);
    results.A_pressInside_releaseOnMask = await visible();

    // B: 蒙层按下 → 面板内弹起——不得关闭
    await mouse('mousePressed', geo.maskPt); await wait(120); await mouse('mouseReleased', geo.innerPt); await wait(200);
    results.B_pressOnMask_releaseInside = await visible();

    // C: 蒙层上完整点击(按下+弹起都在蒙层)——应关闭
    await mouse('mousePressed', geo.maskPt); await wait(120); await mouse('mouseReleased', geo.maskPt); await wait(200);
    results.C_fullClickOnMask_closes = !(await visible());

    // D: 重新打开后 Esc 仍应关闭(既有行为回归)
    await reopen();
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    await wait(200);
    results.D_esc_closes = !(await visible());

    log('results:', JSON.stringify(results));
    const pass = results.A_pressInside_releaseOnMask === true
      && results.B_pressOnMask_releaseInside === true
      && results.C_fullClickOnMask_closes === true
      && results.D_esc_closes === true;
    log(pass ? 'PASS: 面板内按下/蒙层按下均不误关,完整点击蒙层与 Esc 正常关闭' : 'FAIL');
    if (!pass) process.exitCode = 2;
    log('PROBE_LOG_AT:' + OUT);
    main.close();
  } finally {
    child.kill();
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch {}
    flush();
    process.exit(process.exitCode || 0);
  }
}

main().catch((error) => { log('FAIL:', String(error && error.stack || error)); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch {} flush(); process.exit(process.exitCode || 1); });
