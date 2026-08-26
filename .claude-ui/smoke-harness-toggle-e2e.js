// v0.11.8 端到端冒烟:设置→插件列表→展开卡片→点「停用/启用」,验证开关真实生效。
// 用法:env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron .claude-ui/smoke-harness-toggle-e2e.js
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const bridge = require('../src/main/harness/harness-bridge.js')

const ENTRY_ID = 'include:session-stats'

async function main() {
  await app.whenReady()
  bridge.registerHarnessIpc()
  const indexPath = await bridge.renderHarnessIndex()

  const win = new BrowserWindow({
    width: 1280, height: 860,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'harness', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) console.log('RENDERER_ERR:', message.slice(0, 200))
  })
  await win.webContents.loadFile(indexPath)
  await new Promise((r) => setTimeout(r, 9000))

  let failures = 0
  const check = (name, ok, detail) => {
    console.log(`SMOKE ${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : ' — ' + String(detail).slice(0, 200)}`)
    if (!ok) failures++
  }

  // 打开设置 → 插件 → 插件列表
  const nav = await win.webContents.executeJavaScript(`(async () => {
    const click = (pred, root = document) => {
      const el = [...root.querySelectorAll('button, [role="tab"], [role="link"], a')].find(pred)
      if (el) { el.click(); return true }
      return false
    }
    if (!click(b => (b.innerText || '').trim() === '设置' || (b.getAttribute('aria-label') || '').includes('设置'))) return { err: 'no settings button' }
    await new Promise(r => setTimeout(r, 1500))
    if (!click(b => (b.innerText || '').trim() === '插件')) return { err: 'no plugins nav' }
    await new Promise(r => setTimeout(r, 1500))
    click(b => (b.innerText || '').trim() === '插件列表')
    await new Promise(r => setTimeout(r, 2500))
    return { ok: true, hasCard: !!document.querySelector('[data-plugin-entry="${ENTRY_ID}"]') }
  })()`)
  console.log('SMOKE: nav result:', JSON.stringify(nav))
  check('navigate to settings → plugins → inventory', nav && nav.ok && nav.hasCard, JSON.stringify(nav))

  // 展开目标卡片并点「停用」
  const toggleOff = await win.webContents.executeJavaScript(`(async () => {
    const card = document.querySelector('[data-plugin-entry="${ENTRY_ID}"]')
    if (!card) return { err: 'card not found' }
    card.querySelector('button').click() // 展开
    await new Promise(r => setTimeout(r, 500))
    const toggleBtn = [...card.querySelectorAll('button')].find(b => ['停用', '启用'].includes((b.innerText || '').trim()))
    if (!toggleBtn) return { err: 'no toggle button', html: card.innerHTML.slice(0, 300) }
    const before = (toggleBtn.innerText || '').trim()
    toggleBtn.click()
    return { before }
  })()`)
  console.log('SMOKE: toggle off:', JSON.stringify(toggleOff))
  check('toggle button rendered with 停用', toggleOff && toggleOff.before === '停用', JSON.stringify(toggleOff))

  await new Promise((r) => setTimeout(r, 5000))
  const offState = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('[data-plugin-entry="${ENTRY_ID}"]')
    return { text: card ? card.innerText.replace(/\\n/g, '|').slice(0, 200) : 'card gone' }
  })()`)
  console.log('SMOKE: card after off:', JSON.stringify(offState))
  check('card shows 已停用 after toggle', /已停用/.test(offState.text), offState.text)

  // 补丁层落盘
  const patchFile = path.join(process.env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
  const patchText = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : ''
  check('patch layer file has disabled row', /session-stats[\s\S]*?disabled:\s*true|disabled:\s*true/.test(patchText) && patchText.includes('session-stats'), patchText.slice(0, 200))

  // 恢复:再点「启用」
  const toggleOn = await win.webContents.executeJavaScript(`(async () => {
    const card = document.querySelector('[data-plugin-entry="${ENTRY_ID}"]')
    if (!card) return { err: 'card not found' }
    const expandBtn = card.querySelector('button')
    if (![...card.querySelectorAll('button')].some(b => (b.innerText || '').trim() === '启用')) expandBtn.click()
    await new Promise(r => setTimeout(r, 500))
    const toggleBtn = [...card.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '启用')
    if (!toggleBtn) return { err: 'no enable button', html: card.innerHTML.slice(0, 300) }
    toggleBtn.click()
    return { clicked: true }
  })()`)
  check('enable button clicked', toggleOn && toggleOn.clicked === true, JSON.stringify(toggleOn))
  await new Promise((r) => setTimeout(r, 5000))
  const onState = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('[data-plugin-entry="${ENTRY_ID}"]')
    return { text: card ? card.innerText.replace(/\\n/g, '|').slice(0, 200) : 'card gone' }
  })()`)
  console.log('SMOKE: card after on:', JSON.stringify(onState))
  check('card shows 已启用 after re-enable', /已启用/.test(onState.text), onState.text)

  // 清理补丁层文件(冒烟环境专用 profile)
  try { fs.unlinkSync(patchFile) } catch {}

  console.log(failures === 0 ? 'SMOKE: ALL PASS' : `SMOKE: ${failures} FAILURES`)
  setTimeout(() => app.exit(failures === 0 ? 0 : 1), 2000)
}

main().catch((e) => { console.error('SMOKE FATAL:', e); app.exit(1) })
