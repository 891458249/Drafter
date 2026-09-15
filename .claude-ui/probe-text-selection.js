// 复现「按住鼠标选择文字,一选就把上方所有文字选中」的探针。
// 用 CDP Input.dispatchMouseEvent 在两条 assistant 消息之间做真实拖拽选择,
// 然后读取 window.getSelection() 的锚点/焦点落在哪个 .msg 节点里。
// 预期:anchor 应落在按下的那条消息内;bug 复现时 anchor 会跳到更早的消息。
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules'
require('module').Module._initPaths()

const EXE = process.env.DRAFTER_SEL_DEV === '1'
  ? 'D:/ClaudeUI/node_modules/electron/dist/electron.exe'
  : 'D:/ClaudeUI/dist/win-unpacked/Drafter.exe'
const EXE_ARGS = process.env.DRAFTER_SEL_DEV === '1' ? ['D:/ClaudeUI'] : []
const temp = path.join(os.tmpdir(), `drafter-sel-probe-${process.pid}`)
const userData = path.join(temp, 'userdata')
const port = 9233
// DRAFTER_SEL_NOSTREAM=1: 用「已有内容的消息仍留在原位」的方式追加新消息(对照组)
const NO_STREAM = process.env.DRAFTER_SEL_NOSTREAM === '1'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function connect(url) {
  const ws = new (require('ws').WebSocket)(url)
  const pending = new Map()
  let id = 0
  ws.on('message', raw => {
    const message = JSON.parse(raw)
    const resolve = pending.get(message.id)
    if (resolve) { pending.delete(message.id); resolve(message) }
  })
  return new Promise(resolve => ws.on('open', () => resolve({
    ws,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id
        pending.set(requestId, resolve)
        ws.send(JSON.stringify({ id: requestId, method, params }))
        setTimeout(() => {
          if (!pending.has(requestId)) return
          pending.delete(requestId)
          reject(new Error(`timeout: ${method}`))
        }, 30000)
      })
    },
  })))
}

async function waitForCdp() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return } catch {}
    await wait(500)
  }
  throw new Error('CDP did not start')
}

async function main() {
  fs.mkdirSync(userData, { recursive: true })
  // 不复制真实 store,用干净的 userData(需要默认页面能打开即可)
  const env = { ...process.env, DRAFTER_USERDATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DSH_HOME
  const child = spawn(EXE, [...EXE_ARGS, `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await waitForCdp()
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const mainPage = pages.find(page => page.url.includes('index.html'))
    if (!mainPage) throw new Error('main page not found: ' + JSON.stringify(pages.map(p => p.url)))
    const main = await connect(mainPage.webSocketDebuggerUrl)
    const evaluate = async (expression) => {
      const r = await main.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.result?.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails))
      return r.result?.result?.value
    }
    await wait(3000)

    // 往 #messages 里注入与真实用户消息结构一致的消息(表格/代码块/中文长段落)
    const setup = await evaluate(`(() => {
      // 干净 userData 下可能有可见的引导/弹窗 mask,全部隐藏
      for (const m of document.querySelectorAll('.modal-mask')) m.classList.add('hidden');
      const host = document.querySelector('#messages') || document.querySelector('.messages');
      if (!host) return { ok: false, reason: 'no #messages/.messages', html: document.body.innerHTML.slice(0, 400) };
      host.innerHTML = '';
      const mk = (html) => {
        const m = document.createElement('div');
        m.className = 'msg assistant';
        m.innerHTML = '<div class="msg-role">Assistant</div><div class="bubble">' + html + '</div>';
        host.appendChild(m);
        return m;
      };
      mk('<p>第一条:侧别只认 <code>L</code> / <code>R</code>;脊柱/骨盆在 CSV 里标的是 <code>C</code>。</p>');
      mk('<h3>二、输出骨骼</h3><p>2a. Twist 骨(挂接检查的对象,canonical 名)</p>' +
         '<table><thead><tr><th>语义</th><th>canonical 名</th><th>别名</th></tr></thead>' +
         '<tbody><tr><td>大臂 Twist 根/1/2</td><td><code>Bip001_L_UpArmTwist</code> / <code>..Twist1</code></td><td><code>{root}LUpArmTwist</code></td></tr>' +
         '<tr><td>小臂 Twist 根/1/2</td><td><code>Bip001_L_ForeTwist[1][2]</code></td><td>同上模式</td></tr></tbody></table>');
      mk('<p>第三条:右侧全部换成 <code>_R_</code>。编号规则:根骨无编号,从 1 开始递增。</p>' +
         '<pre><code class="language-js">const re = /^Bip001_(?<side>[LR])_UpArmTwist(?<index>\\d+)$/;</code></pre>');
      host.scrollTop = 0;
      const msgs = [...host.querySelectorAll('.msg')];
      // 重新测量:隐藏 mask 后布局可能上移
      const n0 = msgs[0].getBoundingClientRect();
      const n1 = msgs[1].getBoundingClientRect();
      const n2 = msgs[2].getBoundingClientRect();
      return { ok: true, r0: { x: n0.x, y: n0.y, w: n0.width, h: n0.height }, r1: { x: n1.x, y: n1.y, w: n1.width, h: n1.height }, r2: { x: n2.x, y: n2.y, w: n2.width, h: n2.height } };
    })()`)
    console.log('setup:', JSON.stringify(setup))
    if (!setup.ok) throw new Error('setup failed')

    // 向上拖,但只越过 #messages 上边界一点点(不触发自动滚动)
    const x1 = setup.r2.x + 30
    const y1 = setup.r2.y + 20
    const hostTop = await evaluate(`(() => { const r = (document.querySelector('#messages')).getBoundingClientRect(); return r.top; })()`)
    const x2 = setup.r2.x + 60
    const y2 = 30 // 拖进顶栏区域

    const mouse = async (type, x, y, opts = {}) => {
      await main.send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : (type === 'mouseReleased' ? 0 : 1),
        clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0, ...opts,
      })
    }
    const hit = await evaluate(`(() => {
      const el = document.elementFromPoint(${x1}, ${y1});
      if (!el) return null;
      const msgs = [...document.querySelectorAll('.msg')];
      const msg = el.closest('.msg');
      return { tag: el.tagName, cls: el.className, msgIndex: msg ? msgs.indexOf(msg) : -1 };
    })()`)
    console.log('hit-test at press point:', JSON.stringify(hit))
    // 开始模拟流式:每 100ms 向 #messages 末尾 append 一段(期间不滚动、不改已有消息)
    await evaluate(`(() => {
      const host = document.querySelector('#messages');
      window.__streamTimer = setInterval(() => {
        const d = document.createElement('div');
        d.className = 'msg assistant';
        d.innerHTML = '<div class="msg-role">Assistant</div><div class="bubble"><p>流式token ' + Date.now() + '</p></div>';
        host.appendChild(d);
      }, 100);
    })()`)
    await mouse('mousePressed', x1, y1)
    for (let i = 1; i <= 8; i++) {
      await mouse('mouseMoved', x1 + (x2 - x1) * i / 8, y1 + (y2 - y1) * i / 8)
      await wait(120)
    }
    await mouse('mouseReleased', x2, y2)
    await evaluate(`clearInterval(window.__streamTimer)`)
    await wait(300)

    const sel = await evaluate(`(() => {
      const s = window.getSelection();
      if (!s || s.rangeCount === 0) return { empty: true };
      const locate = (node) => {
        if (!node) return null;
        const el = node.nodeType === 1 ? node : node.parentElement;
        const msg = el && el.closest('.msg');
        const msgs = [...document.querySelectorAll('.msg')];
        return { text: (node.textContent || '').slice(0, 30), msgIndex: msg ? msgs.indexOf(msg) : -1,
                 path: (() => { let p = [], n = el; while (n && p.length < 6) { p.push(n.tagName + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ').join('.') : '')); n = n.parentElement; } return p.join(' < '); })() };
      };
      return {
        text: s.toString(),
        anchor: locate(s.anchorNode), anchorOffset: s.anchorOffset,
        focus: locate(s.focusNode), focusOffset: s.focusOffset,
      };
    })()`)
    console.log('selection:', JSON.stringify(sel, null, 2))
    // 诊断:关键元素的选择相关计算样式
    const diag = await evaluate(`(() => {
      const probe = (sel) => { const el = document.querySelector(sel); if (!el) return [sel, null]; const cs = getComputedStyle(el); return [sel, { us: cs.userSelect, ws: cs.whiteSpace, pe: cs.pointerEvents, o: cs.overflow, pos: cs.position }]; };
      return Object.fromEntries([
        probe('body'), probe('.topbar'), probe('.topbar-left'), probe('.section-switch'), probe('.section-switch button'),
        probe('.messages'), probe('.messages-wrap'), probe('.msg.assistant .bubble'), probe('.msg.assistant .bubble p'),
        probe('.msg-nav'), probe('.msg-nav-list'), probe('.sidebar'), probe('.session-list'), probe('.chat-col'),
      ]);
    })()`)
    console.log('computed styles:', JSON.stringify(diag, null, 2))
    // 诊断打印焦点位置:修复后焦点不应逃逸到非消息元素
    if (!sel.empty && sel.focus && sel.focus.msgIndex === -1) {
      console.log('BUG: focus escaped to a non-message UI element above the scroll container')
      process.exitCode = 2
    } else if (!sel.empty) {
      console.log('PASS: selection focus stayed inside message content (focus msgIndex=' + (sel.focus && sel.focus.msgIndex) + ')')
    } else {
      console.log('NOTE: empty selection')
    }
  } finally {
    child.kill()
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }) } catch {}
  }
}

main().catch(error => { console.error('FAIL:', error); process.exitCode = 1 })
