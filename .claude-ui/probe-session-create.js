// 端到端:盘符导航(主目录 → C:\ → D:)→ 建工作区 → 新会话建会话。
// 用法:env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron .claude-ui/probe-session-create.js
process.env.DSH_HOME = require('node:path').join(require('node:os').tmpdir(), 'dsh-sc-' + process.pid, 'harness')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const bridge = require('../src/main/harness/harness-bridge.js')

async function main() {
  await app.whenReady()
  bridge.registerHarnessIpc()
  const indexPath = await bridge.renderHarnessIndex()
  const win = new BrowserWindow({
    width: 1280, height: 860,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'harness', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) console.log('RENDERER_ERR:', String(message).slice(0, 200))
  })
  await win.webContents.loadFile(indexPath)
  await new Promise((r) => setTimeout(r, 9000))

  let failures = 0
  const check = (name, ok, detail) => {
    console.log(`E2E ${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : ' — ' + String(detail).slice(0, 200)}`)
    if (!ok) failures++
  }
  const js = (code) => win.webContents.executeJavaScript(code)
  const dlgBtn = (name) => `(function(){
    const dlg=[...document.querySelectorAll('[role="dialog"]')].find(d=>d.getBoundingClientRect().height>100)
    if(!dlg) return 'no-dialog'
    const b=[...dlg.querySelectorAll('button')].find(x=>String(x.innerText||'').trim()===${JSON.stringify(name)})
    if(!b) return 'not-found'
    b.click(); return 'clicked'
  })()`

  // 关两层 onboarding:内测声明「继续」→ 设置向导「稍后配置」
  await js(`(function(){const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='继续');if(b)b.click()})()`)
  await new Promise((r) => setTimeout(r, 1000))
  await js(`(function(){const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='稍后配置');if(b)b.click()})()`)
  await new Promise((r) => setTimeout(r, 1000))

  // 1. 打开「选择工作区」
  await js(`(function(){const b=[...document.querySelectorAll('button,[role="button"]')].find(x=>String(x.innerText||'').includes('选择工作区'));if(b)b.click()})()`)
  await new Promise((r) => setTimeout(r, 2500))
  check('browse dialog opens', await js(`(function(){return String(document.body.innerText).indexOf('选择工作区目录')>=0})()`) === true)

  // 2. home 的面包屑应含盘符根 C:\(client 补丁)
  const homeCrumbs = await js(`(function(){
    const dlg=[...document.querySelectorAll('[role="dialog"]')].find(d=>d.getBoundingClientRect().height>100)
    if(!dlg) return 'no-dialog'
    return JSON.stringify([...dlg.querySelectorAll('nav button, [class*="crumb"] button')].map(b=>String(b.innerText||'').trim()))
  })()`)
  console.log('E2E: home crumbs =', homeCrumbs)
  check('home crumb bar shows drive root C:\\', String(homeCrumbs).includes('C:\\'), homeCrumbs)

  // 3. 点 C:\ crumb → 盘符切换条出现(C:/D:)+ C 盘子目录正常列出(非空)
  console.log('E2E: click C:\\ →', await js(dlgBtn('C:\\')))
  await new Promise((r) => setTimeout(r, 3000))
  const atRoot = await js(`(function(){
    const dlg=[...document.querySelectorAll('[role="dialog"]')].find(d=>d.getBoundingClientRect().height>100)
    if(!dlg) return 'no-dialog'
    const btns=[...dlg.querySelectorAll('button')].map(b=>String(b.innerText||'').trim())
    return JSON.stringify({ drives: btns.filter(t=>/^[A-Z]:$/.test(t)), dirs: btns.filter(t=>['Windows','Users','Program Files'].includes(t)) })
  })()`)
  console.log('E2E: at C:\\ root =', atRoot)
  check('drive root shows drive letters C: D:', String(atRoot).includes('"D:"'), atRoot)
  check('drive root still lists C: subdirectories', String(atRoot).includes('"Users"'), atRoot)

  // 4. 点 D: → D 盘根目录(应看到 ClaudeUI)
  console.log('E2E: click D: →', await js(dlgBtn('D:')))
  await new Promise((r) => setTimeout(r, 3500))
  const inD = await js(`(function(){
    const dlg=[...document.querySelectorAll('[role="dialog"]')].find(d=>d.getBoundingClientRect().height>100)
    if(!dlg) return 'no-dialog'
    return String(dlg.innerText).indexOf('ClaudeUI') >= 0
  })()`)
  check('navigated into D: (sees ClaudeUI)', inD === true)

  // 5. 点 ClaudeUI 行 → 「打开」完成注册
  console.log('E2E: click ClaudeUI row →', await js(dlgBtn('ClaudeUI')))
  await new Promise((r) => setTimeout(r, 3000))
  console.log('E2E: click 打开 →', await js(dlgBtn('打开')))
  await new Promise((r) => setTimeout(r, 5000))
  check('workspace ClaudeUI registered', await js(`(function(){return String(document.body.innerText).indexOf('ClaudeUI')>=0})()`) === true)

  // 6. 点「新会话」→ 会话应建出(侧栏出现会话条目)
  await js(`(function(){const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='新会话');if(b)b.click()})()`)
  await new Promise((r) => setTimeout(r, 6000))
  const sessionState = await js(`(function(){
    const text = String(document.body.innerText)
    return JSON.stringify({ noEmpty: text.indexOf('暂无会话') < 0, hero: text.indexOf('选择一个工作区开始') >= 0 })
  })()`)
  console.log('E2E: session state:', sessionState)
  check('new session created after workspace picked', String(sessionState).includes('"noEmpty":true'), sessionState)

  try { fs.rmSync(path.dirname(process.env.DSH_HOME), { recursive: true, force: true }) } catch {}
  console.log(failures === 0 ? 'E2E: ALL PASS' : `E2E: ${failures} FAILURES`)
  setTimeout(() => app.exit(failures === 0 ? 0 : 1), 1000)
}
main().catch((e) => { console.error('FATAL:', e); app.exit(1) })
