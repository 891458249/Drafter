// Packaged Harness keyboard smoke: verifies real CDP text insertion updates the controlled composer.
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules'
require('module').Module._initPaths()

const EXE = 'D:/ClaudeUI/dist/win-unpacked/Drafter.exe'
const temp = path.join(os.tmpdir(), `drafter-composer-keyboard-${process.pid}`)
const userData = path.join(temp, 'userdata')
const port = 9231
const typedText = '键盘输入验证'
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
  fs.mkdirSync(path.join(userData, 'harness'), { recursive: true })
  fs.copyFileSync(path.join(process.env.APPDATA, 'Drafter', 'drafter-store.json'), path.join(userData, 'drafter-store.json'))
  fs.cpSync(path.join(process.env.APPDATA, 'Drafter', 'harness'), path.join(userData, 'harness'), { recursive: true })
  const env = { ...process.env, DRAFTER_USERDATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DSH_HOME
  const child = spawn(EXE, [`--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await waitForCdp()
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const mainPage = pages.find(page => page.url.includes('index.html'))
    const main = await connect(mainPage.webSocketDebuggerUrl)
    const evaluateMain = async expression => (await main.send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value
    await evaluateMain(`(() => [...document.querySelectorAll('button, [role="tab"]')].find(x => x.textContent.trim() === 'Harness')?.click())()`)
    await wait(10000)
    let harnessPage
    for (let i = 0; i < 40; i++) {
      const harnessPages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      harnessPage = harnessPages.find(page => page.url.includes('index.electron.html'))
      if (harnessPage) break
      await wait(500)
    }
    if (!harnessPage) throw new Error('Harness webview did not open')
    const harness = await connect(harnessPage.webSocketDebuggerUrl)
    const evaluateHarness = async expression => (await harness.send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value
    await evaluateHarness(`(() => [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '继续')?.click())()`)
    await evaluateHarness(`(() => [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '稍后配置')?.click())()`)
    await wait(2500)
    const state = await evaluateHarness(`(() => { const t = document.querySelector('textarea'); return t && { disabled: t.disabled, readOnly: t.readOnly, placeholder: t.placeholder } })()`)
    if (!state || state.disabled || state.readOnly) throw new Error(`composer is unavailable: ${JSON.stringify(state)}`)
    const node = await harness.send('Runtime.evaluate', { expression: 'document.querySelector("textarea")', returnByValue: false })
    const objectId = node.result?.result?.objectId
    if (!objectId) throw new Error('composer element not found')
    await harness.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { this.focus() }' })
    await harness.send('Input.insertText', { text: typedText })
    await wait(250)
    const value = await evaluateHarness('document.querySelector("textarea")?.value')
    if (value !== typedText) throw new Error(`composer did not retain keyboard text: ${JSON.stringify(value)}`)
    console.log('PASS: composer accepted real keyboard text', JSON.stringify({ state, value }))
  } finally {
    child.kill()
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }) } catch {}
  }
}

main().catch(error => { console.error('FAIL:', error); process.exitCode = 1 })
