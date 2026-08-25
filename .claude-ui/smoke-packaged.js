// 打包态冒烟:直接跑 dist/win-unpacked/Drafter.exe,验证 harness 板块在打包后能 boot
// 用 remote-debugging 驱动(CDP),DRAFTER_USERDATA 隔离
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
// ws 从 harness 的 pnpm store 取(它不在 Drafter 的 node_modules)
process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules'
require('module').Module._initPaths()

const EXE = 'D:/ClaudeUI/dist/win-unpacked/Drafter.exe'
const USERDATA = 'D:/ClaudeUI/.claude-ui/smoke-packaged-userdata'
const CDP = 9225

if (fs.existsSync(USERDATA)) fs.rmSync(USERDATA, { recursive: true, force: true })
fs.mkdirSync(USERDATA, { recursive: true })

console.log('SMOKE: launching packaged Drafter...')
const proc = spawn(EXE, [], {
  env: { ...process.env, DRAFTER_USERDATA: USERDATA, ELECTRON_RUN_AS_NODE: undefined },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
proc.stdout.on('data', (d) => { out += d; })
proc.stderr.on('data', (d) => { out += d; })

// 等 CDP 起来
async function waitCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/version`)
      if (r.ok) return true
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

;(async () => {
  // Drafter.exe 是否带 --remote-debugging-port?需要在启动参数里加。重新 spawn:
  proc.kill()
  const proc2 = spawn(EXE, ['--remote-debugging-port=' + CDP], {
    env: { ...process.env, DRAFTER_USERDATA: USERDATA, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc2.stdout.on('data', (d) => { out += d; })
  proc2.stderr.on('data', (d) => { out += d; })

  const cdpUp = await waitCdp()
  console.log('SMOKE: CDP up?', cdpUp)
  if (!cdpUp) { console.log('SMOKE: stdout tail:', out.slice(-500)); process.exit(1) }

  // 列页面
  const pages = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  console.log('SMOKE: pages:', pages.length, pages.map(p => p.title).slice(0, 3))

  // 找到主页面,切到 harness 板块
  const page = pages.find(p => p.url.includes('index.html')) || pages[0]
  const ws = new (require('ws').WebSocket)(page.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  const send = (method, params) => new Promise((res) => {
    const id = Math.floor(Math.random() * 1e6)
    const onMsg = (data) => {
      const m = JSON.parse(data)
      if (m.id === id) { ws.off('message', onMsg); res(m.result) }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.evaluate', { expression: `
    const btn = document.querySelector('#section-switch button[data-sec="harness"]');
    if (btn) btn.click(); 'clicked:' + !!btn
  ` })
  console.log('SMOKE: clicked harness tab')
  await new Promise(r => setTimeout(r, 10000))
  const state = await send('Runtime.evaluate', { expression: `({
    bodyClass: document.body.className,
    frameSrc: (document.getElementById('harness-frame')||{}).src || 'no frame',
    statusText: ((document.getElementById('harness-status')||{}).innerText||'').slice(0,80),
  })`, returnByValue: true })
  console.log('SMOKE: state:', JSON.stringify(state.result && state.result.value, null, 2))
  console.log('SMOKE: app stdout tail:', out.slice(-400))
  proc2.kill()
  process.exit(0)
})().catch(e => { console.log('FATAL:', e.message); proc.kill(); process.exit(1) })
