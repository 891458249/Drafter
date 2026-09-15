// v0.11.11 打包态端到端:直接跑 dist/win-unpacked/Drafter.exe(CDP 驱动),
// 验证 Harness 板块「选择工作区 → 点选已有工作区 → 会话打开」与「新会话」全链路。
// 用户数据隔离到临时目录,但 DSH_HOME 复制真实 harness home(含 DSH 工作区注册)。
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules'
require('module').Module._initPaths()

const EXE = 'D:/ClaudeUI/dist/win-unpacked/Drafter.exe'
const TMP = path.join(os.tmpdir(), 'dsh-pkg-' + process.pid)
const USERDATA = path.join(TMP, 'userdata')
fs.mkdirSync(path.join(USERDATA, 'harness'), { recursive: true })
fs.cpSync(path.join(process.env.APPDATA, 'Drafter', 'harness'), path.join(USERDATA, 'harness'), { recursive: true })
const CDP = 9226
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const proc = spawn(EXE, ['--remote-debugging-port=' + CDP], {
  env: { ...process.env, DRAFTER_USERDATA: USERDATA, ELECTRON_RUN_AS_NODE: undefined },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
proc.stdout.on('data', (d) => { out += d })
proc.stderr.on('data', (d) => { out += d })

async function waitCdp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) return true } catch {}
    await sleep(500)
  }
  return false
}

let msgId = 0
function connect(wsUrl) {
  const ws = new (require('ws').WebSocket)(wsUrl, { maxPayload: 256 * 1024 * 1024 })
  const pending = new Map()
  const listeners = []
  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    else if (msg.method) for (const fn of listeners) fn(msg)
  })
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)) } }, 30000)
  })
  const onEvent = (fn) => listeners.push(fn)
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, send, onEvent })))
}

;(async () => {
  console.log('launching packaged Drafter...')
  const up = await waitCdp()
  if (!up) { console.log('CDP never came up. stdout tail:', out.slice(-800)); proc.kill(); process.exit(1) }

  // 主窗口:切到 Harness 板块(点顶栏 Harness tab)
  let pages = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  const main = pages.find((p) => p.url.includes('index.html'))
  if (!main) { console.log('pages:', pages.map((p) => p.url)); proc.kill(); process.exit(1) }
  const { send } = await connect(main.webSocketDebuggerUrl)
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    return r.result && r.result.result ? r.result.result.value : undefined
  }
  await sleep(3000)
  // 点 Harness 顶栏 tab
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('button, [role="tab"], *')].find((x) => (x.innerText || '').trim() === 'Harness' && x.getBoundingClientRect().y < 50)
    if (b) b.click()
    return true
  })()`)
  await sleep(9000)

  // Harness 板块是 webview:重新列页面找 harness 的 webview target
  pages = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  const harnessPage = pages.find((p) => p.url.includes('index.electron.html'))
  if (!harnessPage) {
    console.log('no harness webview target. pages:', pages.map((p) => p.url))
    console.log('stdout tail:', out.slice(-600))
    proc.kill(); process.exit(1)
  }
  const h = await connect(harnessPage.webSocketDebuggerUrl)
  // 打开 Runtime/Log 事件流,抓 renderer 的 console.warn/error 与未捕获异常
  await h.send('Runtime.enable')
  await h.send('Log.enable')
  h.onEvent((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ')
      if (['warning', 'error'].includes(msg.params.type)) console.log('H-CONSOLE', msg.params.type + ':', args.slice(0, 400))
    } else if (msg.method === 'Runtime.exceptionThrown') {
      console.log('H-EXCEPTION:', JSON.stringify(msg.params.exceptionDetails).slice(0, 400))
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      console.log('H-LOG-ERR:', String(msg.params.entry.text).slice(0, 300))
    }
  })
  const hjs = async (expr) => {
    const r = await h.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result && r.result.exceptionDetails) return { err: r.result.exceptionDetails.text }
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  // 内测声明/引导
  await hjs(`(function(){ const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='继续'); if(b) b.click() })()`)
  await sleep(1200)
  await hjs(`(function(){ const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='稍后配置'); if(b) b.click() })()`)
  await sleep(1500)

  const snap = `(() => {
    const ta = document.querySelector('textarea, [contenteditable="true"]')
    return JSON.stringify({
      hero: document.body.innerText.includes('探索未至之境'),
      composerEnabled: ta ? !ta.disabled : false,
      buttons: [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 15),
      text: document.body.innerText.slice(0, 200),
    })
  })()`
  const shotDir = path.join(os.tmpdir(), 'drafter-probe-shots')
  fs.mkdirSync(shotDir, { recursive: true })
  const shot = async (name) => {
    try {
      await h.send('Page.enable')
      const r = await h.send('Page.captureScreenshot', { format: 'png' })
      if (r.result && r.result.data) fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64'))
      console.log('shot:', name, path.join(shotDir, name + '.png'))
    } catch (e) { console.log('shot failed:', name, e.message) }
  }
  console.log('INITIAL:', await hjs(snap))
  await shot('1-initial')

  // ① hero 工作区锚点 → 点 DSH 菜单项
  await hjs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => { const t = (x.innerText || '').trim(); return t === '选择工作区' || t === 'DSH' })
    if (b) b.click()
    return !!b
  })()`).then((r) => console.log('anchor click:', r))
  await sleep(1200)
  await shot('2-menu')
  const picked = await hjs(`(() => {
    const c = [...document.querySelectorAll('[role="menuitem"], [role="menu"] *, li, [class*="item"]')].filter((x) => (x.innerText || '').trim() === 'DSH' && x.getBoundingClientRect().height > 0)
    const el = c[c.length - 1]
    if (el) el.click()
    return { found: c.length, clicked: !!el }
  })()`)
  console.log('menu pick:', picked)
  await sleep(6000)
  console.log('AFTER PICK:', await hjs(snap))
  await shot('3-after-pick')

  // ② 工作区行内「新会话」
  const ns = await hjs(`(() => {
    const bs = [...document.querySelectorAll('button')].filter((x) => (x.innerText || '').trim() === '新会话')
    const el = bs[1] || bs[0]
    if (el) el.click()
    return bs.length
  })()`)
  console.log('new session buttons:', ns)
  await sleep(6000)
  console.log('AFTER NEW SESSION:', await hjs(snap))
  await shot('4-after-newsession')

  // ③ 输入框应可用(模型在打包态有真实 Key 同步);发一条消息验证模型链路? 不依赖外部 — 只验证可输入
  const typing = await hjs(`(() => {
    const ta = document.querySelector('textarea, [contenteditable="true"]')
    if (!ta) return 'no-composer'
    return ta.disabled ? 'composer-disabled' : 'composer-ok'
  })()`)
  console.log('COMPOSER:', typing)

  console.log('stdout harness tail:', out.split('\n').filter((l) => l.includes('harness')).slice(-6).join('\n'))
  proc.kill()
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  process.exit(0)
})().catch((e) => { console.error('FATAL:', e); proc.kill(); process.exit(1) })
