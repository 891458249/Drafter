// Reproduce a persisted Harness workspace whose blank session cannot hydrate, and report
// the actual composer attributes before and after starting a workspace session.
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const source = path.join(process.env.APPDATA, 'Drafter', 'harness')
const temp = path.join(os.tmpdir(), `drafter-composer-${process.pid}`)
const userData = path.join(temp, 'userdata')
fs.cpSync(source, path.join(userData, 'harness'), { recursive: true })
app.setPath('userData', userData)
process.env.DSH_HOME = path.join(userData, 'harness')
const bridge = require('../src/main/harness/harness-bridge.js')

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  await app.whenReady()
  bridge.registerHarnessIpc()
  const index = await bridge.renderHarnessIndex()
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'harness', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  await win.webContents.loadFile(index)
  await wait(9000)
  const js = code => win.webContents.executeJavaScript(code)
  await js(`(() => [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '继续')?.click())()`)
  await js(`(() => [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '稍后配置')?.click())()`)
  await wait(2500)
  const report = () => js(`(() => {
    const ta = document.querySelector('textarea')
    const buttons = [...document.querySelectorAll('button')].map((b, i) => ({
      i, text: b.innerText.trim(), label: b.getAttribute('aria-label'), disabled: b.disabled,
    })).filter(b => b.text || b.label)
    return {
      textarea: ta && { disabled: ta.disabled, readOnly: ta.readOnly, placeholder: ta.placeholder, aria: ta.getAttribute('aria-label'), value: ta.value },
      text: document.body.innerText.slice(0, 800),
      buttons,
    }
  })()`)
  console.log('BEFORE', JSON.stringify(await report(), null, 2))
  const beforeType = await js(`(() => {
    const textarea = document.querySelector('textarea')
    if (!textarea || textarea.disabled || textarea.readOnly) return false
    textarea.focus()
    return document.activeElement === textarea
  })()`)
  if (!beforeType) throw new Error('composer is not focusable for native typing')
  win.webContents.insertText('键盘输入验证')
  await wait(200)
  const typed = await js(`document.querySelector('textarea')?.value`)
  if (typed !== '键盘输入验证') throw new Error(`composer did not retain native keyboard text: ${JSON.stringify(typed)}`)
  console.log('TYPED', typed)
  const clicked = await js(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '').includes('新建会话'))
    if (!b) return 'no workspace new-session button'
    b.click()
    return { text: b.innerText.trim(), label: b.getAttribute('aria-label') }
  })()`)
  console.log('CLICKED', JSON.stringify(clicked))
  await wait(5000)
  console.log('AFTER', JSON.stringify(await report(), null, 2))
  await win.close()
  await app.quit()
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }) } catch {}
}
main().catch(error => { console.error(error); app.exit(1) })
