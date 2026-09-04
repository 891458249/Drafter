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

// 两段式真实拖拽:先按住移动(不松手),node 侧断言窗口跟随后,再发 LEFTUP,
// 观察果冻弹簧回吸到边缘。CDP 注入会绕过 OS 命中测试,必须用真实光标。
const ps1 = path.join(TMP, 'drag.ps1')
function setCursor(x, y) {
  execSync(`powershell -NoProfile -Command "$sig='[System.Runtime.InteropServices.DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x, int y);'; $t=Add-Type -MemberDefinition $sig -Name C -Namespace W -PassThru; [void]$t::SetCursorPos(${Math.round(x)}, ${Math.round(y)})"`)
}
function dragMoves(x1, y1, x2, y2) {
  fs.writeFileSync(ps1, `
$sig=@'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
'@
$t=Add-Type -MemberDefinition $sig -Name M -Namespace W -PassThru
[void]$t::SetCursorPos(${Math.round(x1)}, ${Math.round(y1)})
Start-Sleep -Milliseconds 300
$t::mouse_event(2,0,0,0,0)   # LEFTDOWN
for ($i=1; $i -le 20; $i++) {
  $x = ${Math.round(x1)} + [int]((${Math.round(x2)} - ${Math.round(x1)}) * $i / 20)
  $y = ${Math.round(y1)} + [int]((${Math.round(y2)} - ${Math.round(y1)}) * $i / 20)
  [void]$t::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 40
}
`)
  return spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'ignore' })
}
function releaseLeft() {
  execSync(`powershell -NoProfile -Command "$sig='[System.Runtime.InteropServices.DllImport(\\"user32.dll\\")] public static extern void mouse_event(int f, int x, int y, int d, int e);'; $t=Add-Type -MemberDefinition $sig -Name M2 -Namespace W -PassThru; $t::mouse_event(4,0,0,0,0)"`)
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
  const events = []
  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    else if (msg.method) events.push(msg)
  })
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)) } }, 30000)
  })
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, send, events })))
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
    // 模块求值诊断:捕获异常后重载页面,拿到 overlay.js 模块加载失败的真实原因
    await oc.send('Runtime.enable', {})
    await oc.send('Page.enable', {})
    const excBefore = oc.events.length
    await oc.send('Page.reload', {})
    await sleep(1800)
    const exc = oc.events.slice(excBefore)
      .filter((m) => m.method === 'Runtime.exceptionThrown')
      .map((m) => JSON.stringify(m.params.exceptionDetails.exception || m.params.exceptionDetails).slice(0, 600))
    console.log('  overlay 模块异常: ' + (exc.join(' | ') || '(无,重载后求值成功?)'))
    await sleep(500)
    const hasBall = await evalJs(oc, `!!document.getElementById('ball')`)
    const vis = await evalJs(oc, `document.visibilityState`)
    const bg = await evalJs(oc, `getComputedStyle(document.body).backgroundColor`)
    check('悬浮窗 DOM 主球存在', !!hasBall)
    check('悬浮窗可见', vis === 'visible', vis)
    check('body 背景透明(像素穿透前提)', bg === 'rgba(0, 0, 0, 0)', bg)
    // getState IPC 往返
    const st = await evalJs(oc, `window.api.overlayGetState()`)
    check('overlay:getState 返回尺寸/工作区', !!st && Array.isArray(st.size) && st.workAreas.length >= 1, st && JSON.stringify(st.size))

    // 2a) 悬停切换(主进程光标轮询命中):真实光标移到主球中心 → 窗口应变可交互;移出 → 切回穿透
    const ballCx = st.x + 48, ballCy = st.y + 36 // dock padding-top 4 + 半径 32
    setCursor(ballCx, ballCy)
    await sleep(600)
    const stHover = await evalJs(oc, `window.api.overlayGetState()`)
    check('悬停在主球上 → 窗口可交互', stHover && stHover.interactive === true, `interactive=${stHover && stHover.interactive}`)
    const wa0 = st.workAreas[0]
    setCursor(wa0.x + wa0.width / 2, wa0.y + wa0.height / 2) // 移出窗口范围
    await sleep(600)
    const stAway = await evalJs(oc, `window.api.overlayGetState()`)
    check('移出窗口 → 切回穿透', stAway && stAway.interactive === false, `interactive=${stAway && stAway.interactive}`)

    // 2b) 真实拖拽:按住主球向左拖 500px 松手 → 窗口应跟随并果冻吸附到边缘,
    // 位置持久化到 settings.floatBall
    await evalJs(oc, `window.__pd = 0; window.__err = null; window.__pdInfo = null; document.addEventListener('pointerdown', (e) => { window.__pd++; const el = document.elementFromPoint(e.clientX, e.clientY); window.__pdInfo = { target: e.target.id || e.target.className || e.target.tagName, hit: el ? (el.id || el.className || el.tagName) : null, x: e.clientX, y: e.clientY } }, true); window.addEventListener('error', (e) => window.__err = e.message)`)
    const probe2 = await evalJs(oc, `window.__probe2 = 0; const b = document.getElementById('ball'); b.addEventListener('pointerdown', () => window.__probe2++); b.addEventListener('mousedown', () => window.__md2 = (window.__md2||0)+1); 'same=' + (b === document.elementFromPoint(48,36)) + ' moduleOK=' + (window.__orbModuleOK === true)`)
    console.log('  probe2 挂载: ' + probe2)
    setCursor(ballCx, ballCy) // 先回悬停态
    await sleep(600)
    const preDrag = await evalJs(oc, `window.api.overlayGetState()`)
    console.log('  拖拽前 interactive=' + (preDrag && preDrag.interactive) + ' 窗口=(' + (preDrag && preDrag.x) + ',' + (preDrag && preDrag.y) + ') 球心=(' + ballCx + ',' + ballCy + ')')
    // 按住移动(不松手)→ 窗口应实时跟手
    const dragProc = dragMoves(ballCx, ballCy, ballCx - 500, ballCy + 60)
    let maxFollow = 0, dragPos = null
    for (let i = 0; i < 20; i++) {
      await sleep(150)
      const s = await evalJs(oc, `window.api.overlayGetState()`)
      if (s) { maxFollow = Math.max(maxFollow, Math.abs(s.x - st.x), Math.abs(s.y - st.y)); dragPos = s }
    }
    check('拖拽中窗口实时跟随(>300px)', maxFollow > 300, `maxFollow=${maxFollow}px 末位=(${dragPos && dragPos.x},${dragPos && dragPos.y})`)
    releaseLeft() // 松手 → 果冻弹簧应回吸到最近边缘
    await new Promise((r) => { dragProc.on('exit', r); setTimeout(r, 5000) })
    await sleep(2000) // 弹簧收敛
    const pdCount = await evalJs(oc, `window.__pd`)
    const pdInfo = await evalJs(oc, `JSON.stringify(window.__pdInfo)`)
    const p2 = await evalJs(oc, `'probe2(pd)=' + window.__probe2 + ' mousedown=' + (window.__md2||0)`)
    const orbStart = await evalJs(oc, `window.__orbDragStart === true`)
    const orbErr = await evalJs(oc, `window.__orbErr || null`)
    const errMsg = await evalJs(oc, `window.__err`)
    check('pointerdown 到达球体且处理函数执行', pdCount >= 1 && orbStart === true, `pd=${pdCount} info=${pdInfo} ${p2} handler=${orbStart} captureErr=${orbErr} err=${errMsg}`)
    const stAfter = await evalJs(oc, `window.api.overlayGetState()`)
    const fb = await evalJs(mc, `window.api.getStore().then(s => s.settings.floatBall || {})`)
    check('松手后果冻吸附回边缘并持久化', !!stAfter && !!fb && fb.x != null && ['left', 'right', 'top', 'bottom'].includes(fb.edge) && Math.abs(stAfter.x - fb.x) <= 2 && Math.abs(stAfter.y - fb.y) <= 2,
      `落点≈(${dragPos && dragPos.x},${dragPos && dragPos.y}) 吸附后=(${stAfter && stAfter.x},${stAfter && stAfter.y}) edge=${fb && fb.edge}`)
    setCursor(wa0.x + wa0.width / 2, wa0.y + wa0.height / 2) // 光标归位,避免影响后续检查
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
  try {
    const errLog = fs.readFileSync(path.join(USERDATA, 'logs', 'renderer-errors.log'), 'utf8').split('\n').filter((l) => l.includes('overlay')).slice(-5).join('\n')
    if (errLog) console.log('---- overlay 渲染错误日志 ----\n' + errLog)
  } catch {}
  proc.kill()
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('SMOKE ERROR:', e); console.error(out.slice(-3000)); try { proc.kill() } catch {}; process.exit(1) })
