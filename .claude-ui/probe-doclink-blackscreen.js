// 复现「点击聊天里的文件链接(.file-link)打开文档 → App 黑屏」。
// dev 态 electron . + 隔离 userData(复制真实 store),CDP 激活 HARU 会话后点击首个 .file-link,
// 监听渲染进程崩溃 / 未捕获异常 / console error。
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules'
require('module').Module._initPaths()

const TMP = path.join(os.tmpdir(), 'dsh-doclink-' + process.pid)
const USERDATA = path.join(TMP, 'userdata')
fs.mkdirSync(USERDATA, { recursive: true })
fs.copyFileSync(path.join(process.env.APPDATA, 'Drafter', 'drafter-store.json'), path.join(USERDATA, 'drafter-store.json'))
fs.cpSync(path.join(process.env.APPDATA, 'Drafter', 'sessions'), path.join(USERDATA, 'sessions'), { recursive: true })
const CDP = 9231
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const env = { ...process.env, DRAFTER_USERDATA: USERDATA }
delete env.ELECTRON_RUN_AS_NODE
delete env.DSH_HOME
const EXE = process.env.PROBE_EXE || 'node_modules/electron/dist/electron.exe'
const EXE_ARGS = process.env.PROBE_EXE ? [] : ['.']
const proc = spawn(EXE, [...EXE_ARGS, '--remote-debugging-port=' + CDP], {
  env, cwd: 'D:/ClaudeUI', stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
proc.stdout.on('data', (d) => { out += d })
proc.stderr.on('data', (d) => { out += d })

async function waitCdp() {
  for (let i = 0; i < 60; i++) {
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)) } }, 15000)
  })
  const onEvent = (fn) => listeners.push(fn)
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, send, onEvent })))
}

;(async () => {
  console.log('launching dev electron...')
  if (!await waitCdp()) { console.log('CDP never up:', out.slice(-800)); proc.kill(); process.exit(1) }
  const pages = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  const main = pages.find((p) => p.url.includes('index.html'))
  if (!main) { console.log('no main page:', JSON.stringify(pages.map((p) => p.url))); proc.kill(); process.exit(1) }
  const m = await connect(main.webSocketDebuggerUrl)
  await m.send('Runtime.enable')
  await m.send('Log.enable')
  let crashed = false
  m.onEvent((msg) => {
    if (msg.method === 'Inspector.targetCrashed') { crashed = true; console.log('!!! RENDERER CRASHED') }
    if (msg.method === 'Runtime.exceptionThrown') console.log('EXCEPTION:', JSON.stringify(msg.params.exceptionDetails).slice(0, 600))
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      console.log('CONSOLE-ERR:', (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 400))
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      console.log('LOG-ERR:', JSON.stringify(msg.params.entry).slice(0, 400))
    }
  })
  const mjs = async (expr) => {
    const r = await m.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300) }
    return r.result?.result?.value
  }
  await sleep(3000)

  // 激活 HARU 项目下含文件链接的会话
  const clicked = await mjs(`(() => {
    const items = [...document.querySelectorAll('.session-item, .sess-item, [data-session-id], .session')]
    const t = items.find((x) => (x.innerText || '').includes('HARU'))
    if (t) { t.click(); return 'clicked:' + (t.innerText || '').slice(0, 40) }
    return 'no-haru-session; items=' + items.length
  })()`)
  console.log('SESSION:', JSON.stringify(clicked))
  await sleep(4000)
  const dbg = await mjs(`(() => {
    const sb = document.getElementById('session-list') || document.querySelector('.session-list') || document.getElementById('sessions')
    return JSON.stringify({
      sbId: sb ? sb.id : null,
      active: (document.querySelector('.session-item.active, .sess-item.active, .session.active') || {}).className,
      composerPlaceholder: (document.querySelector('#input, textarea') || {}).placeholder,
    })
  })()`)
  console.log('DBG:', dbg)
  await sleep(4000)

  const linkInfo = await mjs(`(() => {
    const links = [...document.querySelectorAll('#messages .file-link')]
    return JSON.stringify({
      links: links.map((l) => (l.textContent || '').slice(0, 80)),
      msgLen: (document.getElementById('messages') || {}).innerText?.length,
      msgHead: (document.getElementById('messages') || {}).innerText?.slice(0, 200),
      codes: document.querySelectorAll('#messages code').length,
    })
  })()`)
  console.log('FILE LINKS:', linkInfo)

  const r = await mjs(`(() => {
    const links = [...document.querySelectorAll('#messages .file-link')]
    const l = links.filter((x) => (x.textContent || '').includes('一键绑定插件需求文档.md')).pop() || links[0]
    if (!l) return 'no-link'
    l.click()
    return 'clicked: ' + (l.textContent || '').slice(0, 80)
  })()`)
  console.log('CLICK:', JSON.stringify(r))
  await sleep(4000)

  const after = await mjs(`(() => JSON.stringify({
    crashedProbe: !!document.querySelector('#right-panel:not(.hidden)'),
    panelVisible: !document.getElementById('right-panel').classList.contains('hidden'),
    editorPath: (document.getElementById('editor-path') || {}).textContent,
    previewLen: (document.querySelector('#editor-preview code') || {}).innerHTML?.length,
  }))()`)
  console.log('AFTER:', after, '| crashed:', crashed)
  console.log('MAIN LOG TAIL:', out.split('\n').slice(-25).join('\n'))
  proc.kill()
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  process.exit(0)
})().catch((e) => { console.error('FATAL:', e); proc.kill(); process.exit(1) })
