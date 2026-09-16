// 冒烟:会话右键菜单「重命名」应弹出行内 input,Enter 提交后标题更新。
// 修复前 renameSession 用 window.prompt(Electron 渲染进程不弹窗、静默返回 null),点击无反应。
// 走 CDP 真实派发:contextmenu → 点菜单「重命名」→ input.value 赋值 → Enter,校验 store 标题已改。
// 用法:受管启动本脚本(electron dev 实例由脚本自行 spawn 干净 userData,结束时 kill+清理)。
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules';
require('module').Module._initPaths();

const EXE = 'D:/ClaudeUI/node_modules/electron/dist/electron.exe';
const temp = path.join(os.tmpdir(), `drafter-rename-probe-${process.pid}`);
const userData = path.join(temp, 'userdata');
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), `drafter-rename-probe-${process.pid}.log`); // 受管启动拿不到子进程 stdout,结果写文件
const port = 9237 + (process.pid % 50); // 避免与残留探针撞端口
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
    await evaluate(`(window.__errs = window.__errs || [], window.addEventListener('error', (e) => window.__errs.push(String(e.message || e))), window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason && e.reason.message || e.reason))), true)`);
    await wait(3000);

    // 干净 userData 下造一个 code 会话,让侧栏出现会话项(sessCreate 不采纳 title,创建后用 sessRename 打上唯一名)
    // api 直调不发出任何渲染事件,refreshList 不会自动重跑 → 派生 input 事件强制重绘(sessions-ui.js 绑定 #session-filter.oninput)
    const sid = await evaluate(`(async () => {
      for (const m of document.querySelectorAll('.modal-mask')) m.classList.add('hidden');
      const s = await api.sessCreate({ cwd: ${JSON.stringify(temp)}, permissionMode: 'default', kind: 'code', standalone: true });
      await api.sessRename(s.id, 'RENAME-PROBE');
      document.querySelector('#session-filter').dispatchEvent(new Event('input'));
      return s.id;
    })()`);
    log('session:', sid);
    // refreshList 里还有 api 往返,轮询等列表真出现再右键
    const appeared = await evaluate(`(async () => {
      for (let i = 0; i < 40; i++) {
        const li = [...document.querySelectorAll('li.session-item')].find((x) => x.textContent.includes('RENAME-PROBE'));
        if (li) return true;
        document.querySelector('#session-filter').dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    })()`);
    log('item appeared:', appeared);
    if (!appeared) {
      const diag = await evaluate(`(async () => ({
        sessCount: (await api.sessList()).length,
        titles: JSON.stringify((await api.sessList()).map((m) => m.title)),
        anySessionItem: document.querySelectorAll('li.session-item').length,
        itemTexts: JSON.stringify([...document.querySelectorAll('li.session-item')].map((x) => x.textContent.trim())),
        errs: (window.__errs || []).slice(0, 5),
      }))()`);
      log('diag:', JSON.stringify(diag));
      throw new Error('session item never rendered in sidebar');
    }

    // 右键该会话项 → 弹出 ctx-menu
    const opened = await evaluate(`(() => {
      const li = [...document.querySelectorAll('li.session-item')].find((x) => x.textContent.includes('RENAME-PROBE'));
      if (!li) return { ok: false, reason: 'no session item' };
      const r = li.getBoundingClientRect();
      li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 10 }));
      const menu = document.querySelector('.ctx-menu');
      return { ok: !!menu, labels: menu ? [...menu.querySelectorAll('button')].map((b) => b.textContent) : [] };
    })()`);
    log('ctx-menu:', JSON.stringify(opened));
    if (!opened.ok) throw new Error('context menu did not open');

    // 点击「重命名」
    const editing = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('.ctx-menu button')].find((b) => b.textContent === '重命名');
      if (!btn) return { ok: false, reason: 'no 重命名 button' };
      btn.click();
      const input = document.querySelector('li.session-item input.sess-rename');
      if (!input) return { ok: false, reason: 'no inline input appeared (prompt() path still broken?)' };
      return { ok: true, value: input.value, focused: document.activeElement === input, menuGone: !document.querySelector('.ctx-menu') };
    })()`);
    log('after click 重命名:', JSON.stringify(editing));
    if (!editing.ok) throw new Error('inline rename input did not appear: ' + editing.reason);
    if (!editing.focused) throw new Error('rename input not focused');
    if (!editing.menuGone) throw new Error('ctx menu still open');

    // 输入新名 + Enter 提交
    await evaluate(`(() => {
      const input = document.querySelector('li.session-item input.sess-rename');
      input.value = 'RENAME-PROBE-OK';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await wait(800);
    const after = await evaluate(`(async () => ({
      itemGone: !document.querySelector('li.session-item input.sess-rename'),
      storeTitle: (await api.sessList()).find((m) => m.id === ${JSON.stringify(sid)}).title,
      domShows: [...document.querySelectorAll('li.session-item')].some((x) => x.textContent.includes('RENAME-PROBE-OK')),
    }))()`);
    log('after Enter:', JSON.stringify(after));

    // Escape 路径:再次重命名,按 Esc 应取消且标题不变
    await evaluate(`(() => {
      const li = [...document.querySelectorAll('li.session-item')].find((x) => x.textContent.includes('RENAME-PROBE-OK'));
      li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
      [...document.querySelectorAll('.ctx-menu button')].find((b) => b.textContent === '重命名').click();
      const input = document.querySelector('li.session-item input.sess-rename');
      input.value = 'SHOULD-NOT-SAVE';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    })()`);
    await wait(800);
    const esc = await evaluate(`(async () => ({
      storeTitle: (await api.sessList()).find((m) => m.id === ${JSON.stringify(sid)}).title,
      editingGone: !document.querySelector('li.session-item input.sess-rename'),
    }))()`);
    log('after Escape:', JSON.stringify(esc));

    const pass = after.storeTitle === 'RENAME-PROBE-OK' && after.domShows && after.itemGone
      && esc.storeTitle === 'RENAME-PROBE-OK' && esc.editingGone;
    log(pass ? 'PASS: 右键重命名行内编辑、Enter 提交、Esc 取消全部正常' : 'FAIL');
    if (!pass) process.exitCode = 2;
    log('PROBE_LOG_AT:' + OUT); // 受管运行时供外层按此路径回收结果
    main.close();
  } finally {
    child.kill();
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch {}
    flush();
    process.exit(process.exitCode || 0); // 立即退出:受管启动靠进程结束判定,不拖 WebSocket/句柄
  }
}

main().catch((error) => { log('FAIL:', String(error && error.stack || error)); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch {} flush(); process.exit(process.exitCode || 1); });
