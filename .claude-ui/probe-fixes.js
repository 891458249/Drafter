// 验证:目录选择器 + 设置可用性(打包态)
const { spawn } = require('child_process')
const fs = require('fs')
process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules'
require('module').Module._initPaths()
const WebSocket = require('ws').WebSocket
const EXE = 'D:/ClaudeUI/dist/win-unpacked/Drafter.exe'
const USERDATA = 'D:/ClaudeUI/.claude-ui/smoke-fixes'
const CDP = 9236
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
  await new Promise(r => setTimeout(r, 18000))
  // 检查 webview 里的设置状态(经 RPC 读 settings.describe)
  const guests = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).filter(p => p.url.includes('index.electron.html'))
  if (guests.length) {
    const g = guests[0]
    const gws = new WebSocket(g.webSocketDebuggerUrl)
    await new Promise(r => gws.on('open', r))
    const gsend = (method, params) => new Promise((res) => {
      const id = Math.floor(Math.random() * 1e6)
      const onMsg = (data) => { const m = JSON.parse(data); if (m.id === id) { gws.off('message', onMsg); res(m.result) } }
      gws.on('message', onMsg); gws.send(JSON.stringify({ id, method, params }))
    })
    // 测 settings.describe(走 IPC → apiproxy → settings 服务)
    const settings = await gsend('Runtime.evaluate', { expression: `(async () => {
      if (!window.__DSH_TRANSPORT__) return { err: 'no transport' }
      try {
        const client = window.__DSH_TRANSPORT__.createApiClient()
        const r = await client.settings.describe({})
        return { ok: r.result.ok, namespaces: r.result.ok ? r.result.value.namespaces.length : -1, writable: r.result.ok ? r.result.value.writable : null }
      } catch (e) { return { err: String(e).slice(0, 200) } }
    })()`, returnByValue: true, awaitPromise: true })
    console.log('SETTINGS:', JSON.stringify(settings.result && settings.result.value))
    // 测 isLoopback(读 connection handle)
    const loopback = await gsend('Runtime.evaluate', { expression: `(() => {
      // connection 插件把 isLoopback 挂在 ctx 上;从全局读不到,但我们可以从 UI 状态推
      return { hostname: window.location.hostname, isLoopbackByHostname: window.location.hostname === '' || window.location.hostname === 'localhost' }
    })()`, returnByValue: true })
    console.log('LOOPBACK:', JSON.stringify(loopback.result && loopback.result.value))
  }
  proc.kill(); process.exit(0)
})().catch(e => { console.log('FATAL:', e.message); proc.kill(); process.exit(1) })
