// Phase 1 冒烟:在真实 Electron 里 boot harness + 开窗口加载前端 + 驱动一次 RPC。
// 用法:env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron .claude-ui/smoke-harness.js
// 需要 DRAFTER_USERDATA 隔离(避免与运行中的 Drafter 单实例锁冲突)。

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const Module = require('module')

// 让 main.js 的 require 链不跑起来——本冒烟只测 harness 桥,独立装配。
const bridge = require('../src/main/harness/harness-bridge.js')

const CDP_PORT = 9223
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT))

async function main() {
  await app.whenReady()
  bridge.registerHarnessIpc()

  // boot + 渲染 index
  const indexPath = await bridge.renderHarnessIndex()
  console.log('SMOKE: index rendered at', indexPath)

  const win = new BrowserWindow({
    width: 1280, height: 860,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'harness', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 收集渲染进程控制台
  const consoleLogs = []
  win.webContents.on('console-message', (_e, level, message) => {
    consoleLogs.push(`[${level}] ${message}`)
    if (level >= 2) console.log('RENDERER_ERR:', message.slice(0, 200))
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('SMOKE: renderer gone:', JSON.stringify(details))
  })

  await win.webContents.loadFile(indexPath)
  console.log('SMOKE: page loaded')

  // transport 已由 preload 自动安装;这里只读状态,不再手动 install。

  // 给前端几秒完成模块加载与首渲染
  await new Promise((r) => setTimeout(r, 8000))

  const state = await win.webContents.executeJavaScript(`(() => {
    return {
      title: document.title,
      hasRoot: !!document.getElementById('root'),
      rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
      bodyText: document.body ? document.body.innerText.slice(0, 200) : '',
      transport: !!window.__DSH_TRANSPORT__,
      boot: !!window.__DSH_BOOT__,
      bootEntries: window.__DSH_BOOT__ && window.__DSH_BOOT__.entries ? window.__DSH_BOOT__.entries.length : -1,
      // 探查 connection 状态
      hasIpc: !!window.__DRAFTER_IPC_RAW__,
      ipcFetchType: typeof (window.__DRAFTER_IPC_RAW__||{}).fetch,
      ipcOpenSseType: typeof (window.__DRAFTER_IPC_RAW__||{}).openSse,
    }
  })()`)
  console.log('SMOKE: page state:', JSON.stringify(state, null, 2))

  // 主动测一次 IPC fetch(session.list)
  const rpcTest = await win.webContents.executeJavaScript(`(async () => {
    if (!window.__DRAFTER_IPC_RAW__) return { err: 'no __DRAFTER_IPC_RAW__' }
    try {
      const res = await window.__DRAFTER_IPC_RAW__.fetch({
        url: '/api/session.list',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session.list', payload: {} }),
      })
      return { status: res.status, ok: res.ok, body: String(res.body).slice(0, 200) }
    } catch (e) { return { err: String(e).slice(0, 200) } }
  })()`)
  console.log('SMOKE: rpc session.list test:', JSON.stringify(rpcTest))

  const errCount = consoleLogs.filter((l) => l.startsWith('[2]') || l.startsWith('[3]')).length
  console.log('SMOKE: console error count:', errCount)
  console.log('SMOKE: last logs:', JSON.stringify(consoleLogs.slice(-8), null, 2))

  // 不立即退出,留窗口供 CDP 探查;10s 后自己退
  setTimeout(() => { app.exit(0) }, 10000)
}

main().catch((e) => { console.error('SMOKE FATAL:', e); app.exit(1) })
