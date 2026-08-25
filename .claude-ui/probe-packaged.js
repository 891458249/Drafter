// 打包态 harness boot 探查:启动 Drafter.exe,CDP 点击 Harness 板块,读 harness-error.log
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules'
require('module').Module._initPaths()
const WebSocket = require('ws').WebSocket
const EXE = 'D:/ClaudeUI/dist/win-unpacked/Drafter.exe'
const USERDATA = 'D:/ClaudeUI/.claude-ui/smoke-packaged-userdata'
const CDP = 9234
fs.rmSync(USERDATA, { recursive: true, force: true })

const proc = spawn(EXE, ['--remote-debugging-port=' + CDP], {
  env: { ...process.env, DRAFTER_USERDATA: USERDATA, DRAFTER_ALLOW_MULTI_INSTANCE: '1', ELECTRON_RUN_AS_NODE: undefined },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
proc.stdout.on('data', d => { out += d }); proc.stderr.on('data', d => { out += d })

async function waitCdp() { for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) return true } catch {} await new Promise(r => setTimeout(r, 500)) } return false }

;(async () => {
  if (!await waitCdp()) { console.log('no CDP; stdout:', out.slice(-500)); proc.kill(); process.exit(1) }
  const pages = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  const page = pages.find(p => p.url.includes('index.html')) || pages[0]
  if (!page) { console.log('no page'); proc.kill(); process.exit(1) }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  const send = (method, params) => new Promise((res) => {
    const id = Math.floor(Math.random() * 1e6)
    const onMsg = (data) => { const m = JSON.parse(data); if (m.id === id) { ws.off('message', onMsg); res(m.result) } }
    ws.on('message', onMsg); ws.send(JSON.stringify({ id, method, params }))
  })
  await new Promise(r => setTimeout(r, 3000))
  // 点击 harness 板块
  await send('Runtime.evaluate', { expression: `const b=document.querySelector('#section-switch button[data-sec="harness"]'); if(b) b.click(); 'clicked:'+!!b`, returnByValue: true })
  console.log('clicked harness tab, waiting 15s for boot...')
  await new Promise(r => setTimeout(r, 15000))
  // 读状态
  const state = await send('Runtime.evaluate', { expression: `({
    bodyClass: document.body.className,
    frameSrc: (document.getElementById('harness-frame')||{}).src,
    harnessStatus: ((document.getElementById('harness-status')||{}).innerText||'').trim().slice(0,100),
  })`, returnByValue: true })
  console.log('STATE:', JSON.stringify(state.result && state.result.value, null, 2))
  // 读 harness 错误日志
  const logPath = path.join(USERDATA, 'logs', 'harness-error.log')
  if (fs.existsSync(logPath)) {
    console.log('=== harness-error.log ===')
    console.log(fs.readFileSync(logPath, 'utf8').slice(0, 3500))
  } else {
    console.log('no harness-error.log (boot may have succeeded)')
  }
  proc.kill(); process.exit(0)
})().catch(e => { console.log('FATAL:', e.message); proc.kill(); process.exit(1) })
