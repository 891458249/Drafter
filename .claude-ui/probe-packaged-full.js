// 打包态完整验证:boot + 点击 harness 板块 + 读 webview 内部状态
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules'
require('module').Module._initPaths()
const WebSocket = require('ws').WebSocket
const EXE = 'D:/ClaudeUI/dist/win-unpacked/Drafter.exe'
const USERDATA = 'D:/ClaudeUI/.claude-ui/smoke-packaged-userdata'
const CDP = 9235
fs.rmSync(USERDATA, { recursive: true, force: true })

const proc = spawn(EXE, ['--remote-debugging-port=' + CDP], {
  env: { ...process.env, DRAFTER_USERDATA: USERDATA, DRAFTER_ALLOW_MULTI_INSTANCE: '1', ELECTRON_RUN_AS_NODE: undefined },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
proc.stdout.on('data', d => { out += d }); proc.stderr.on('data', d => { out += d })

async function waitCdp() { for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) return true } catch {} await new Promise(r => setTimeout(r, 500)) } return false }

;(async () => {
  if (!await waitCdp()) { console.log('no CDP'); proc.kill(); process.exit(1) }
  const pages = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  const page = pages.find(p => p.url.includes('index.html')) || pages[0]
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  const send = (method, params) => new Promise((res) => {
    const id = Math.floor(Math.random() * 1e6)
    const onMsg = (data) => { const m = JSON.parse(data); if (m.id === id) { ws.off('message', onMsg); res(m.result) } }
    ws.on('message', onMsg); ws.send(JSON.stringify({ id, method, params }))
  })
  await new Promise(r => setTimeout(r, 3000))
  await send('Runtime.evaluate', { expression: `document.querySelector('#section-switch button[data-sec="harness"]').click(); 'ok'`, returnByValue: true })
  console.log('clicked, waiting 20s...')
  await new Promise(r => setTimeout(r, 20000))
  // 主窗口状态
  const state = await send('Runtime.evaluate', { expression: `({
    bodyClass: document.body.className,
    frameSrc: (document.getElementById('harness-frame')||{}).src,
    statusHidden: (document.getElementById('harness-status')||{classList:{contains:()=>false}}).classList.contains('hidden'),
  })`, returnByValue: true })
  console.log('MAIN STATE:', JSON.stringify(state.result && state.result.value, null, 2))
  // webview 内部状态
  const guests = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).filter(p => p.url.includes('index.electron.html'))
  console.log('webview pages found:', guests.length)
  if (guests.length) {
    const g = guests[0]
    const gws = new WebSocket(g.webSocketDebuggerUrl)
    await new Promise(r => gws.on('open', r))
    const gsend = (method, params) => new Promise((res) => {
      const id = Math.floor(Math.random() * 1e6)
      const onMsg = (data) => { const m = JSON.parse(data); if (m.id === id) { gws.off('message', onMsg); res(m.result) } }
      gws.on('message', onMsg); gws.send(JSON.stringify({ id, method, params }))
    })
    const gstate = await gsend('Runtime.evaluate', { expression: `({
      transport: !!window.__DSH_TRANSPORT__,
      boot: !!window.__DSH_BOOT__,
      title: document.title,
      bodyText: document.body ? document.body.innerText.slice(0, 150) : '',
      ipcRaw: !!window.__DRAFTER_IPC_RAW__,
    })`, returnByValue: true })
    console.log('WEBVIEW STATE:', JSON.stringify(gstate.result && gstate.result.value, null, 2))
    // 测一次真 RPC
    const rpc = await gsend('Runtime.evaluate', { expression: `(async () => {
      if (!window.__DSH_TRANSPORT__) return { err: 'no transport' }
      try {
        const client = window.__DSH_TRANSPORT__.createApiClient()
        const r = await client.sessions.list({})
        return { ok: r.result.ok, count: r.result.ok ? r.result.value.items.length : -1 }
      } catch (e) { return { err: String(e).slice(0, 200) } }
    })()`, returnByValue: true, awaitPromise: true })
    console.log('RPC session.list:', JSON.stringify(rpc.result && rpc.result.value))
  }
  proc.kill(); process.exit(0)
})().catch(e => { console.log('FATAL:', e.message); proc.kill(); process.exit(1) })
