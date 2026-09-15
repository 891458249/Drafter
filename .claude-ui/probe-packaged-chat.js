// v0.11.13 打包态真实模型往返:dist/win-unpacked + 隔离 userData(复制真实 store 的 Key
// 与 harness home),Harness 板块发一条最小消息,断言出现助手回复且无 PI_AI_ERROR。
// 注意:会用用户的 Key 发一次真实请求(极短 prompt)。
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules'
require('module').Module._initPaths()

const EXE = 'D:/ClaudeUI/dist/win-unpacked/Drafter.exe'
const TMP = path.join(os.tmpdir(), 'dsh-chat-' + process.pid)
const USERDATA = path.join(TMP, 'userdata')
fs.mkdirSync(path.join(USERDATA, 'harness'), { recursive: true })
// 复制真实 Key 体系(drafter-store.json)与 harness home(工作区注册/模型设置)
fs.copyFileSync(path.join(process.env.APPDATA, 'Drafter', 'drafter-store.json'), path.join(USERDATA, 'drafter-store.json'))
fs.cpSync(path.join(process.env.APPDATA, 'Drafter', 'harness'), path.join(USERDATA, 'harness'), { recursive: true })
const CDP = 9227
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const env = { ...process.env, DRAFTER_USERDATA: USERDATA }
delete env.ELECTRON_RUN_AS_NODE
delete env.DSH_HOME // 本机 shell 环境漏了 DSH_HOME(指向 Roaming\drafter\harness),不删会让被测进程共用真实数据
const proc = spawn(EXE, ['--remote-debugging-port=' + CDP], {
  env,
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
  console.log('launching packaged Drafter (real keys, isolated data)...')
  if (!await waitCdp()) { console.log('CDP never up:', out.slice(-500)); proc.kill(); process.exit(1) }

  let pages = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  const main = pages.find((p) => p.url.includes('index.html'))
  const m = await connect(main.webSocketDebuggerUrl)
  const mjs = async (expr) => (await m.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
  await sleep(2500)
  await mjs(`(() => { const b = [...document.querySelectorAll('button, [role="tab"], *')].find((x) => (x.innerText || '').trim() === 'Harness' && x.getBoundingClientRect().y < 50); if (b) b.click(); return true })()`)
  await sleep(10000)

  pages = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  const harnessPage = pages.find((p) => p.url.includes('index.electron.html'))
  if (!harnessPage) { console.log('no harness webview; tail:', out.slice(-600)); proc.kill(); process.exit(1) }
  const h = await connect(harnessPage.webSocketDebuggerUrl)
  await h.send('Runtime.enable')
  h.onEvent((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(msg.params.type)) {
      console.log('H-CONSOLE:', (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300))
    } else if (msg.method === 'Runtime.exceptionThrown') {
      console.log('H-EXCEPTION:', JSON.stringify(msg.params.exceptionDetails).slice(0, 300))
    }
  })
  const hjs = async (expr) => {
    const r = await h.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { err: r.result.exceptionDetails.text }
    return r.result?.result?.value
  }

  // 引导弹窗
  await hjs(`(function(){ const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='继续'); if(b) b.click() })()`)
  await sleep(1000)
  await hjs(`(function(){ const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='稍后配置'); if(b) b.click() })()`)
  await sleep(2000)

  // 已有工作区?选 DSH;否则报告
  const state0 = await hjs(`(() => JSON.stringify({ buttons: [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 12), text: document.body.innerText.slice(0, 150) }))()`)
  console.log('STATE:', state0)
  await hjs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => { const t = (x.innerText || '').trim(); return t === '选择工作区' || t === 'DSH' }); if (b) b.click(); return true })()`)
  await sleep(1000)
  await hjs(`(() => { const c = [...document.querySelectorAll('[role="menuitem"], [role="menu"] *, li')].filter((x) => (x.innerText || '').trim() === 'DSH' && x.getBoundingClientRect().height > 0); const el = c[c.length - 1]; if (el) el.click(); return !!el })()`)
  await sleep(5000)

  // 发消息:在 composer 输入并回车
  const typed = await hjs(`(() => {
    const ta = document.querySelector('textarea')
    if (!ta || ta.disabled) return 'composer-not-ready'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '回复ok两个字即可')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus()
    return 'typed'
  })()`)
  console.log('TYPE:', typed)
  await sleep(500)
  await hjs(`(() => {
    const ta = document.querySelector('textarea')
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    return true
  })()`)

  // 等待助手回复(最多 90s)
  let final = null
  for (let i = 0; i < 45; i++) {
    await sleep(2000)
    const s = await hjs(`(() => {
      const t = document.body.innerText
      const ei = t.indexOf('本轮运行失败')
      return JSON.stringify({
        piError: ei >= 0 || t.includes('PI_AI_ERROR'),
        errText: ei >= 0 ? t.slice(ei, ei + 500) : '',
        hasOk: /\\bok\\b/i.test(t),
        text: t.slice(0, 300),
      })
    })()`)
    const st = JSON.parse(s)
    if (st.piError) { console.log('TURN FAILED. errText:', st.errText); final = 'pi-error'; break }
    if (st.hasOk) { console.log('ASSISTANT REPLIED. text:', st.text); final = 'ok'; break }
    if (i === 44) { console.log('TIMEOUT. text:', st.text); final = 'timeout' }
  }
  console.log('RESULT:', final)
  console.log('harness log tail:', out.split('\n').filter((l) => l.includes('harness') || l.includes('error')).slice(-8).join('\n'))
  proc.kill()
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  process.exit(final === 'ok' ? 0 : 1)
})().catch((e) => { console.error('FATAL:', e); proc.kill(); process.exit(1) })
