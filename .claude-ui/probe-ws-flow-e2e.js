// v0.11.10 端到端复现:真实 harness 前端,重放用户两个失败操作——
// ① hero「选择工作区」下拉点选已有工作区 ② 侧栏「新会话」。
// 用复制的真实 DSH_HOME(含 DSH 工作区注册),观察 console 与 DOM 变化。
// 用法:env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron .claude-ui/probe-ws-flow-e2e.js
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const SRC = path.join(process.env.APPDATA, 'Drafter', 'harness')
const TMP = path.join(os.tmpdir(), 'dsh-flow-' + process.pid)
fs.cpSync(SRC, path.join(TMP, 'harness'), { recursive: true })
process.env.DSH_HOME = path.join(TMP, 'harness')
const { app, BrowserWindow, ipcMain } = require('electron')
const bridge = require('../src/main/harness/harness-bridge.js')

// 主进程侧拦截 harness:fetch,记录每次 unary RPC(渲染侧 IpcApiClient 闭包捕获 mainFetch,页面侧包不住)
const origHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => {
  if (channel === 'harness:fetch') {
    return origHandle(channel, async (event, reqDesc) => {
      const m = String(reqDesc && reqDesc.url || '')
      if (!m.includes('events.')) console.log('IPC>>>', (reqDesc && reqDesc.method) || 'GET', m)
      const res = await handler(event, reqDesc)
      if (!m.includes('events.')) {
        let detail = ''
        const body = String(res && res.body || '')
        if (res && res.ok === false) detail = String(res.error).slice(0, 150)
        else if (body.includes('"ok":false')) detail = body.slice(0, 500)
        else if (m.includes('session.create')) detail = body.slice(0, 300)
        console.log('IPC<<<', m, '→', res && res.status, detail)
      }
      return res
    })
  }
  return origHandle(channel, handler)
}
const origOn = ipcMain.on.bind(ipcMain)
ipcMain.on = (channel, handler) => {
  if (channel === 'harness:openSse') {
    return origOn(channel, (event, reqDesc) => {
      console.log('SSE>>> open', String(reqDesc && reqDesc.url || ''), 'ch=' + (reqDesc && reqDesc.channelId))
      const sender = event.sender
      const origSend = sender.send.bind(sender)
      let frames = 0
      sender.send = (ch, msg) => {
        if (ch.includes('harness:sse:')) {
          frames++
          if (msg.type === 'chunk') {
            if (frames <= 12) console.log('SSE-FRAME', ch.slice(-8), String(msg.chunk || '').slice(0, 400).replace(/\n/g, '⏎'))
          } else if (frames <= 3 || msg.type === 'error' || msg.type === 'end') {
            console.log('SSE<<<', ch.slice(-8), msg.type, msg.status || '', String(msg.error || '').slice(0, 120))
          }
        }
        return origSend(ch, msg)
      }
      return handler(event, reqDesc)
    })
  }
  return origOn(channel, handler)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await app.whenReady()
  bridge.registerHarnessIpc()
  const indexPath = await bridge.renderHarnessIndex()

  const win = new BrowserWindow({
    width: 1280, height: 860,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'harness', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  })
  win.webContents.on('console-message', (_e, level, message) => {
    const m = String(message)
    if (m.includes('Electron Security Warning') || m.includes('consult https://')) return
    console.log(`CONSOLE[${level}]:`, m.slice(0, 400))
  })
  await win.webContents.loadFile(indexPath)
  await sleep(9000)
  const js = (code) => win.webContents.executeJavaScript(code)

  // 关掉内测声明(若出现)
  await js(`(function(){ const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='继续'); if(b) b.click() })()`)
  await sleep(1500)
  // 首次引导:API Key 对话框「稍后配置」
  await js(`(function(){ const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='稍后配置'); if(b) b.click() })()`)
  await sleep(1500)

  const snap = () => js(`(() => {
    const ta = document.querySelector('textarea, [contenteditable="true"]')
    return {
      hero: document.body.innerText.includes('探索未至之境') || document.body.innerText.includes('选择一个工作区开始'),
      hasComposer: !!ta,
      composerEnabled: ta ? !ta.disabled : false,
      sidebarText: (document.querySelector('aside, nav, [class*="sidebar"], [class*="Sidebar"]') || document.body).innerText.slice(0, 220),
      text: document.body.innerText.slice(0, 200),
    }
  })()`)

  // 包一层 transport 记录 RPC 流水
  await js(`(() => {
    const t = window.__DSH_TRANSPORT__
    if (!t || t.__wrapped) return 'no-transport'
    const orig = t.fetch.bind(t)
    window.__rpcLog = []
    t.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      const rec = { url, t: Date.now() }
      window.__rpcLog.push(rec)
      try {
        const res = await orig(input, init)
        rec.status = res.status
        if (res.status !== 200 && res.headers.get('content-type')?.includes('json')) {
          rec.body = (await res.clone().text()).slice(0, 300)
        }
        return res
      } catch (e) { rec.error = String(e && e.message || e); throw e }
    }
    t.__wrapped = true
    return 'wrapped'
  })()`).then((r) => console.log('--- transport wrap:', r))

  // 页面内错误/警告捕获(console-message 事件在新 Electron 已改版,双保险)
  await js(`(() => {
    window.__errs = []
    window.addEventListener('error', (e) => window.__errs.push('err: ' + e.message))
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej: ' + String(e.reason && (e.reason.stack || e.reason.message) || e.reason).slice(0, 400)))
    const ow = console.warn.bind(console)
    console.warn = (...a) => { window.__errs.push('warn: ' + a.map((x) => String(x && (x.stack || x.message) || x).slice(0, 300)).join(' ')); ow(...a) }
    const oe = console.error.bind(console)
    console.error = (...a) => { window.__errs.push('cerr: ' + a.map((x) => String(x && (x.stack || x.message) || x).slice(0, 300)).join(' ')); oe(...a) }
    // fetch 兜底拦截:React 组件持有的连接句柄若绕过了 __DSH_TRANSPORT__ 包装,这里也能看见
    const of = window.fetch.bind(window)
    window.__fetchLog = []
    window.fetch = (...a) => {
      window.__fetchLog.push(String(typeof a[0] === 'string' ? a[0] : a[0] && a[0].url).slice(0, 120))
      return of(...a)
    }
    return 'errhook ok'
  })()`).then((r) => console.log('--- errhook:', r))

  console.log('--- INITIAL:', JSON.stringify(await snap()))

  // 列出全部按钮,定位目标
  const btns = await js(`(() => [...document.querySelectorAll('button')].map((b, i) => ({
    i, text: (b.innerText || '').trim().slice(0, 24), disabled: b.disabled,
    rect: (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }))(b.getBoundingClientRect()),
  })).filter(b => b.text))()`)
  console.log('--- BUTTONS:', JSON.stringify(btns, null, 1))

  const clickDef = `function clickEl(el) {
    if (!el) return { err: 'not found' }
    el.scrollIntoView()
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    el.click()
    return { clicked: (el.innerText || '').trim().slice(0, 24) }
  }`

  // ① 侧栏顶部「新会话」(第一个)
  const c1 = await js(`(() => { ${clickDef}; const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim() === '新会话');
    if (b) b.addEventListener('click', () => window.__errs.push('native-click: 新会话 reached button'))
    return clickEl(b) })()`)
  console.log('--- click sidebar 新会话:', JSON.stringify(c1))
  await sleep(5000)
  console.log('--- AFTER ①:', JSON.stringify(await snap()))
  console.log('--- RPC ①:', JSON.stringify(await js('window.__rpcLog || []')))
  console.log('--- FETCH ①:', JSON.stringify(await js('window.__fetchLog || []')))
  console.log('--- ERRS ①:', JSON.stringify(await js('window.__errs || []')))
  await js('window.__rpcLog = []; window.__errs = []; window.__fetchLog = []')

  // ② hero 工作区锚点(显示 DSH 或 选择工作区)→ 打开菜单点 DSH
  const c2 = await js(`(() => { ${clickDef};
    const b = [...document.querySelectorAll('button, [role="button"]')].find(x => {
      const t = (x.innerText || '').trim()
      return (t === '选择工作区' || t === 'DSH') && x.getBoundingClientRect().x > 300
    })
    return clickEl(b)
  })()`)
  console.log('--- click hero anchor:', JSON.stringify(c2))
  await sleep(1500)
  const menuDump = await js(`(() => {
    const menus = [...document.querySelectorAll('[role="menu"], [class*="menu"], [class*="Menu"], [class*="popover"]')].filter(m => m.getBoundingClientRect().height > 0)
    return menus.map(m => (m.innerText || '').slice(0, 100))
  })()`)
  console.log('--- menus open:', JSON.stringify(menuDump))
  const c3 = await js(`(() => { ${clickDef};
    const cand = [...document.querySelectorAll('[role="menuitem"], [role="menu"] *, li, [class*="item"]')].filter(x => (x.innerText||'').trim() === 'DSH' && x.getBoundingClientRect().height > 0)
    return clickEl(cand[cand.length - 1])
  })()`)
  console.log('--- pick DSH item:', JSON.stringify(c3))
  await sleep(6000)
  console.log('--- AFTER ②:', JSON.stringify(await snap()))
  console.log('--- RPC ②:', JSON.stringify(await js('window.__rpcLog || []')))
  console.log('--- FETCH ②:', JSON.stringify(await js('window.__fetchLog || []')))
  console.log('--- ERRS ②:', JSON.stringify(await js('window.__errs || []')))
  await js('window.__rpcLog = []; window.__errs = []; window.__fetchLog = []')

  // ③ 工作区行内「新会话」(DSH 下的那个,用户的第一个抱怨)
  const c4 = await js(`(() => { ${clickDef};
    const bs = [...document.querySelectorAll('button')].filter(x => (x.innerText||'').trim() === '新会话')
    return clickEl(bs[1] || bs[0])
  })()`)
  console.log('--- click workspace 新会话:', JSON.stringify(c4))
  await sleep(6000)
  console.log('--- AFTER ③:', JSON.stringify(await snap()))
  console.log('--- RPC ③:', JSON.stringify(await js('window.__rpcLog || []')))
  console.log('--- FETCH ③:', JSON.stringify(await js('window.__fetchLog || []')))
  console.log('--- ERRS ③:', JSON.stringify(await js('window.__errs || []')))

  // 截图 + 会话区详情
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(TMP, '..', 'probe-ws-flow.png'), img.toPNG())
  console.log('--- screenshot:', path.join(TMP, '..', 'probe-ws-flow.png'))
  const detail = await js(`(() => {
    const rows = [...document.querySelectorAll('[class*="session"], [class*="Session"], li')].filter((r) => r.getBoundingClientRect().height > 0 && r.getBoundingClientRect().x < 300).map((r) => (r.innerText || '').trim().slice(0, 40)).filter(Boolean)
    return { sidebarRows: rows.slice(0, 12) }
  })()`)
  console.log('--- SIDEBAR ROWS:', JSON.stringify(detail, null, 1))

  // 会话列表状态
  const list = await js(`(() => {
    const text = document.body.innerText
    return { hasUntitled: text.includes('新会话') || text.includes('Untitled'), len: text.length }
  })()`)
  console.log('--- LIST:', JSON.stringify(list))

  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  setTimeout(() => app.exit(0), 1500)
}

main().catch((e) => { console.error('FATAL:', e); try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}; app.exit(1) })
