// v0.11.7 端到端冒烟:完整加载 harness 前端,验证「选择工作区」点击弹出浏览对话框。
// 用法:env -u ELECTRON_RUN_AS_NODE DRAFTER_USERDATA=<隔离目录> node_modules/.bin/electron .claude-ui/smoke-harness-picker-e2e.js
const { app, BrowserWindow } = require('electron')
const path = require('path')

const bridge = require('../src/main/harness/harness-bridge.js')

async function main() {
  await app.whenReady()
  bridge.registerHarnessIpc()
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
  const consoleLogs = []
  win.webContents.on('console-message', (_e, level, message) => {
    consoleLogs.push(`[${level}] ${message}`)
    if (level >= 3) console.log('RENDERER_ERR:', message.slice(0, 200))
  })

  await win.webContents.loadFile(indexPath)
  await new Promise((r) => setTimeout(r, 9000))

  const state = await win.webContents.executeJavaScript(`(() => {
    const entries = (window.__DSH_BOOT__ && window.__DSH_BOOT__.entries || []).map(e => e.id)
    return {
      bootEntries: entries.length,
      hasPickerSurface: entries.some(id => String(id).includes('directory-picker-browse')),
      bodyText: document.body ? document.body.innerText.slice(0, 150) : '',
    }
  })()`)
  console.log('SMOKE: page state:', JSON.stringify(state, null, 2))

  // 找「选择工作区」按钮并点击,看浏览对话框是否出现
  const clickResult = await win.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('button')]
    const target = btns.find(b => b.innerText.includes('选择工作区') || b.getAttribute('aria-label')?.includes('选择工作区'))
    if (!target) return { err: 'no picker button', buttons: btns.slice(0, 12).map(b => b.innerText.slice(0, 20)) }
    target.click()
    return { clicked: target.innerText.slice(0, 30) }
  })()`)
  console.log('SMOKE: click picker:', JSON.stringify(clickResult))

  await new Promise((r) => setTimeout(r, 4000))
  const dialogState = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText
    return {
      dialogVisible: text.includes('选择工作区目录'),
      hasHomeCrumb: text.includes('主目录'),
      hasNewFolder: text.includes('新建文件夹'),
      snippet: text.slice(0, 300),
    }
  })()`)
  console.log('SMOKE: dialog state:', JSON.stringify(dialogState, null, 2))

  const errs = consoleLogs.filter((l) => l.startsWith('[3]'))
  console.log('SMOKE: console errors:', errs.length, JSON.stringify(errs.slice(0, 5), null, 2))

  const pass = state.hasPickerSurface && dialogState.dialogVisible
  console.log(pass ? 'SMOKE: ALL PASS' : 'SMOKE: FAIL')
  setTimeout(() => app.exit(pass ? 0 : 1), 2000)
}

main().catch((e) => { console.error('SMOKE FATAL:', e); app.exit(1) })
