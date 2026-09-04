// 桌面悬浮球(v0.13.3)dev 冒烟:隔离 userData 启动 electron,CDP 驱动。
// 断言链:预置 floatBall.enabled → 主窗 minimize → 悬浮窗(overlay.html)出现 →
// 截图验证主球渲染 → 主窗 restore → 悬浮窗隐藏(visibilityState=hidden)。
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = 'D:/ClaudeUI'
process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules'
require('module').Module._initPaths()
const TMP = path.join(os.tmpdir(), 'drafter-overlay-' + process.pid)
const USERDATA = path.join(TMP, 'userdata')
fs.mkdirSync(USERDATA, { recursive: true })
const CDP = 9231 + (process.pid % 500) // 随机化端口,避免与残留进程互抢
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const env = { ...process.env, DRAFTER_USERDATA: USERDATA, DRAFTER_ALLOW_MULTI_INSTANCE: '1' }
delete env.ELECTRON_RUN_AS_NODE
const proc = spawn(process.execPath, [path.join(ROOT, 'node_modules/electron/cli.js'), '.', '--remote-debugging-port=' + CDP], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
proc.stdout.on('data', (d) => { out += d })
proc.stderr.on('data', (d) => { out += d })
process.on('exit', () => { try { proc.kill() } catch {} })

async function waitCdp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) return true } catch {}
    await sleep(500)
  }
  return false
}

// Electron CDP 不开放 Browser 域(getWindowForTarget -32601),改用 user32 ShowWindow
// 对冒烟实例子进程的主窗做最小化(SW_MINIMIZE=2)/恢复(SW_RESTORE=9)
const { execSync } = require('child_process')
function mainElectronPid() {
  const out = execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=''electron.exe''' | Where-Object { $_.ParentProcessId -eq ${proc.pid} } | Select-Object -ExpandProperty ProcessId"`
  ).toString().trim()
  return parseInt(out, 10)
}
function showWindow(pid, cmd, handle) {
  const out = execSync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; if ('${handle || ''}' -eq '') { $p=Get-Process -Id ${pid}; $p.Refresh(); $h=$p.MainWindowHandle } else { $h=New-Object System.IntPtr([long]('${handle}')) }; $sig='[System.Runtime.InteropServices.DllImport(\\"user32.dll\\")] public static extern bool ShowWindow(System.IntPtr h, int c);'; $t=Add-Type -MemberDefinition $sig -Name U32 -Namespace W -PassThru; $t::ShowWindow($h, ${cmd}) | Out-Null; Write-Output ('handle=' + $h)"`
  ).toString().trim()
  return out.replace('handle=', '')
}
let msgId = 0
function connect(wsUrl) {
  const ws = new (require('ws').WebSocket)(wsUrl, { maxPayload: 256 * 1024 * 1024 })
  const pending = new Map()
  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  })
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)) } }, 30000)
  })
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, send })))
}

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${CDP}/json/list`)
  return r.json()
}

async function evalJs(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result && r.result.result ? r.result.result.value : undefined
}

let failed = 0
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra != null ? ' | ' + extra : ''))
  if (!cond) failed++
}

;(async () => {
  if (!(await waitCdp())) { console.error('CDP not ready'); console.error(out.slice(-3000)); process.exit(1) }
  await sleep(2500) // 等主窗加载

  // 1) 主窗预置悬浮球设置(asked+enabled,跳过询问框)
  let main = (await listTargets()).find((t) => t.url.includes('src/index.html'))
  check('主窗 target 存在', !!main)
  let mc = await connect(main.webSocketDebuggerUrl)
  await evalJs(mc, `window.api.setSetting('floatBall', { asked: true, enabled: true, x: null, y: null })`)
  await sleep(300)

  // 2) minimize 主窗 → 悬浮窗应出现
  const ep = mainElectronPid()
  check('找到冒烟实例主进程', Number.isFinite(ep), ep)
  const mainHandle = showWindow(ep, 2) // SW_MINIMIZE;句柄缓存复用(悬浮窗出现后进程主窗句柄会被 .NET 误判)
  await sleep(2500)

  const overlay = (await listTargets()).find((t) => t.url.includes('overlay.html'))
  check('minimize 后悬浮窗 target 出现', !!overlay, overlay && overlay.url)
  if (overlay) {
    const oc = await connect(overlay.webSocketDebuggerUrl)
    await sleep(800)
    const hasBall = await evalJs(oc, `!!document.getElementById('ball')`)
    const vis = await evalJs(oc, `document.visibilityState`)
    const bg = await evalJs(oc, `getComputedStyle(document.body).backgroundColor`)
    check('悬浮窗 DOM 主球存在', !!hasBall)
    check('悬浮窗可见', vis === 'visible', vis)
    check('body 背景透明(像素穿透前提)', bg === 'rgba(0, 0, 0, 0)', bg)
    // getState IPC 往返
    const st = await evalJs(oc, `window.api.overlayGetState()`)
    check('overlay:getState 返回尺寸/工作区', !!st && Array.isArray(st.size) && st.workAreas.length >= 1, st && JSON.stringify(st.size))
    // 截图
    const shot = await oc.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(TMP, 'overlay.png'), Buffer.from(shot.result.data, 'base64'))
    console.log('截图: ' + path.join(TMP, 'overlay.png'))
    // 注:sess:event 广播链路由 test/overlay.test.js 单测覆盖;
    // 此处无 SDK 的隔离环境创建会话不产生事件,不做环境依赖断言

    // 3) restore 主窗 → 悬浮窗应隐藏
    showWindow(ep, 9, mainHandle) // SW_RESTORE
    await sleep(1500)
    const mainVis = await evalJs(mc, `document.visibilityState`)
    check('主窗已恢复可见', mainVis === 'visible', mainVis)
    await sleep(800)
    const vis2 = await evalJs(oc, `document.visibilityState`)
    check('restore 后悬浮窗隐藏', vis2 === 'hidden', vis2)
  }

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
  console.log('---- 主进程日志尾部 ----')
  console.log(out.split('\n').filter((l) => l.includes('[overlay') || l.includes('Error') || l.includes('error')).slice(-10).join('\n'))
  proc.kill()
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('SMOKE ERROR:', e); console.error(out.slice(-3000)); try { proc.kill() } catch {}; process.exit(1) })
