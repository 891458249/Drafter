// Phase 5 冒烟:启动完整 Drafter app,切到 Harness 板块,验证 harness 前端在 webview 里加载
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
app.commandLine.appendSwitch('remote-debugging-port', '9224')
app.whenReady().then(async () => {
  const bridge = require('D:/ClaudeUI/src/main/harness/harness-bridge.js')
  bridge.registerHarnessIpc()
  await bridge.bootHarness()
  console.log('SMOKE: harness booted')
  const win = new BrowserWindow({
    width: 1440, height: 900,
    webPreferences: { preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true },
  })
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) console.log('C[' + l + ']:', m.slice(0, 150)) })
  await win.webContents.loadFile(path.join(__dirname, '../src/index.html'))
  console.log('SMOKE: Drafter loaded')
  await new Promise(r => setTimeout(r, 2000))
  // 切到 harness 板块
  await win.webContents.executeJavaScript(`
    const btn = document.querySelector('#section-switch button[data-sec="harness"]');
    if (btn) { btn.click(); 'clicked' } else { 'no harness button' }
  `).then(r => console.log('SMOKE: click harness tab:', r))
  await new Promise(r => setTimeout(r, 8000))
  const state = await win.webContents.executeJavaScript(`(() => {
    const frame = document.getElementById('harness-frame');
    const status = document.getElementById('harness-status');
    return {
      bodyClass: document.body.className,
      frameSrc: frame ? frame.src : 'no frame',
      statusText: status ? status.innerText.slice(0, 80) : 'no status',
      statusHidden: status ? status.classList.contains('hidden') : null,
    }
  })()`)
  console.log('SMOKE: harness section state:', JSON.stringify(state, null, 2))
  // webview 内部状态
  try {
    const wc = win.webContents
    const guests = require('electron').webContents.getAllWebContents().filter(w => w.getType && w.getType() === 'webview')
    if (guests.length) {
      const g = guests[0]
      const gstate = await g.executeJavaScript(`({ transport: !!window.__DSH_TRANSPORT__, boot: !!window.__DSH_BOOT__, title: document.title, bodyText: document.body ? document.body.innerText.slice(0,120) : '' })`)
      console.log('SMOKE: webview inner state:', JSON.stringify(gstate, null, 2))
    } else { console.log('SMOKE: no webview found') }
  } catch (e) { console.log('SMOKE: webview probe err:', e.message.slice(0, 150)) }
  setTimeout(() => app.exit(0), 6000)
}).catch(e => { console.error('FATAL:', e); app.exit(1) })
