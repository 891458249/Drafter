// 拆分子任务端到端冒烟:本地假 OpenAI 服务 + 真 Key,让真实 sess:splitSubtasks
// 走通 llmtext.complete → HTTP → 返回固定子任务 JSON;UI 确认后验证真实
// sess:spawnSubtasks 批量建出并行 code 会话。
// v0.15.10:按钮改为发送框旁的激活/关闭开关,激活时发送被拦截去拆分。
const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules'
require('module').Module._initPaths()

const EXE = 'D:/ClaudeUI/node_modules/electron/dist/electron.exe'
const temp = path.join(os.tmpdir(), `drafter-split-smoke-${process.pid}`)
const userData = path.join(temp, 'userdata')
const port = 9234
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// 假 OpenAI chat/completions 服务:返回固定拆分结果
const SUBTASKS = [
  { title: '搭建前端页面', detail: '实现博客首页与文章详情页的静态结构' },
  { title: '实现用户系统', detail: '注册/登录/鉴权接口与前端对接' },
]
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(SUBTASKS) } }] }))
    })
    return
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
    return
  }
  res.writeHead(404); res.end('{}')
})

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
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const llmPort = server.address().port
  fs.mkdirSync(userData, { recursive: true })
  const env = { ...process.env, DRAFTER_USERDATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DSH_HOME
  const child = spawn(EXE, ['D:/ClaudeUI', `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await waitForCdp()
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const mainPage = pages.find(page => page.url.includes('index.html'))
    const main = await connect(mainPage.webSocketDebuggerUrl)
    const evaluate = async (expression, awaitP = false) => {
      const r = await main.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: awaitP })
      const res = r.result || {}
      if (res.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(res.exceptionDetails))
      return res.result ? res.result.value : undefined
    }
    await wait(3500)
    await evaluate(`window.alert = (m) => { window.__alertMsg = String(m); }`)
    await evaluate(`(() => { for (const m of document.querySelectorAll('.modal-mask')) m.classList.add('hidden'); })()`)

    // 建真 Key 指向本地假服务并启用
    const keySaved = await evaluate(`window.api.keysSave({ name: 'MockLLM', key: 'sk-mock', baseUrl: 'http://127.0.0.1:${llmPort}/v1' })`, true)
    console.log('key saved raw:', JSON.stringify(keySaved), 'type:', typeof keySaved)
    const keysNow = await evaluate(`window.api.keysList()`, true)
    console.log('keys list:', JSON.stringify(keysNow))
    if (!keySaved || !keySaved.ok) throw new Error('keysSave failed: ' + JSON.stringify(keySaved))
    // 让模型列表可解析(split 需要 model):直接刷新模型缓存
    await evaluate(`window.api.keysRefresh && window.api.keysRefresh('${keySaved.id}')`, true)
    await wait(500)

    // 新建一个 code 会话作为「当前会话」(spawn 需要 sid 继承 cwd/model/key)
    const meta = await evaluate(`window.api.sessCreate({ standalone: true, keyId: '${keySaved.id}', model: 'mock-model' })`, true)
    console.log('session created:', JSON.stringify(meta && { id: meta.id, keyId: meta.keyId, model: meta.model }))
    // 通过动态 import 调用渲染端 chat 模块,登记并激活该会话(模拟 createSession 流程)
    await evaluate(`import('./renderer/chat.js').then(m => { m.ensureSession('${meta.id}', ${JSON.stringify(meta)}); m.setActiveSession('${meta.id}'); })`, true)
    await wait(300)
    await evaluate(`(() => { document.querySelector('#input').value = '做一个带用户系统的博客'; })()`)

    // 激活拆任务开关 → 点发送 → 真实 HTTP 拆分 → 弹卡片
    await evaluate(`(() => { document.querySelector('#btn-split-subtasks').click(); })()`)
    await wait(200)
    const armedOn = await evaluate(`document.querySelector('#btn-split-subtasks').classList.contains('split-on')`)
    if (!armedOn) throw new Error('split toggle did not arm')
    await evaluate(`(() => { document.querySelector('#btn-send').click(); })()`)
    await wait(1500)
    const modalShown = await evaluate(`!document.querySelector('#split-modal').classList.contains('hidden')`)
    const rows = await evaluate(`[...document.querySelectorAll('#split-list .split-row')].map(r => r.querySelector('.split-title').value)`)
    console.log('modal shown:', modalShown, 'rows:', JSON.stringify(rows))
    if (!modalShown) throw new Error('split modal did not open; alert=' + (await evaluate('window.__alertMsg')))
    if (rows.length !== 2) throw new Error('expected 2 rows, got ' + JSON.stringify(rows))

    // 确认 → 真实 spawnSubtasks → 建出并行会话
    await evaluate(`(() => { document.querySelector('#split-confirm').click(); })()`)
    await wait(1500)
    const modalHidden = await evaluate(`document.querySelector('#split-modal').classList.contains('hidden')`)
    const sessList = await evaluate(`window.api.sessList()`, true)
    const spawned = (sessList || []).filter(s => (s.title || '').startsWith('⧉'))
    console.log('modal hidden:', modalHidden, 'spawned sessions:', JSON.stringify(spawned.map(s => ({ title: s.title, cwd: s.cwd, model: s.model }))))
    if (!modalHidden) throw new Error('modal did not close after confirm')
    if (spawned.length !== 2) throw new Error('expected 2 spawned sessions, got ' + spawned.length)
    console.log('PASS: split-subtasks end-to-end (real HTTP split → editable card → parallel code sessions spawned)')
  } finally {
    child.kill()
    server.close()
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }) } catch {}
  }
}

main().catch(error => { console.error('FAIL:', error); process.exitCode = 1 })
