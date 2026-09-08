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
const clickPs1 = path.join(TMP, 'click.ps1')
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
// 真实双击(两次左键),用于验证吸附态纯点击不触发拖拽、dblclick 能展开主窗
function dblClick(x, y) {
  fs.writeFileSync(clickPs1, `
$sig=@'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
'@
$t=Add-Type -MemberDefinition $sig -Name Dbl -Namespace W -PassThru
[void]$t::SetCursorPos(${Math.round(x)}, ${Math.round(y)})
Start-Sleep -Milliseconds 120
$t::mouse_event(2,0,0,0,0); $t::mouse_event(4,0,0,0,0)
Start-Sleep -Milliseconds 90
$t::mouse_event(2,0,0,0,0); $t::mouse_event(4,0,0,0,0)
`)
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${clickPs1}"`)
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
    let stHover = await evalJs(oc, `window.api.overlayGetState()`)
    if (!stHover || stHover.interactive !== true) { // 启动期 hover 轮询偶发延迟,重试一次
      setCursor(ballCx + 2, ballCy)
      setCursor(ballCx, ballCy)
      await sleep(800)
      stHover = await evalJs(oc, `window.api.overlayGetState()`)
    }
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
    const waWin = st.workAreas.find((w) => ballCx >= w.x && ballCx <= w.x + w.width) || st.workAreas[0]

    // 场景一:拖放远离边缘(>80px)→ 自由摆放,不吸附
    let dragProc = dragMoves(ballCx, ballCy, ballCx - 500, ballCy + 60)
    let maxFollow = 0
    for (let i = 0; i < 20; i++) {
      await sleep(150)
      const s = await evalJs(oc, `window.api.overlayGetState()`)
      if (s) maxFollow = Math.max(maxFollow, Math.abs(s.x - st.x), Math.abs(s.y - st.y))
    }
    releaseLeft()
    await new Promise((r) => { dragProc.on('exit', r); setTimeout(r, 5000) })
    await sleep(800)
    const floatPos = await evalJs(oc, `window.api.overlayGetState()`)
    const floatFb = await evalJs(mc, `window.api.getStore().then(s => s.settings.floatBall || {})`)
    const floatDropX = ballCx - 500 - 48, floatDropY = ballCy + 60 - 36 // 松手时窗口左上≈光标-grab偏移
    check('拖拽中窗口实时跟随(>300px)', maxFollow > 300, `maxFollow=${maxFollow}px`)
    check('远离边缘松手 → 自由摆放不吸附', !!floatPos && Math.abs(floatPos.x - floatDropX) <= 24 && Math.abs(floatPos.y - floatDropY) <= 24 && !floatFb.edge,
      `落点=(${floatDropX},${floatDropY}) 实际=(${floatPos && floatPos.x},${floatPos && floatPos.y}) edge=${floatFb && floatFb.edge}`)

    // 场景二:再拖到右边缘附近(球心距边缘 ≤80px)松手 → 果冻吸附 + 半圆贴边变形
    const stMid = await evalJs(oc, `window.api.overlayGetState()`)
    const nearCx = waWin.x + waWin.width - 60 // 窗口贴右缘留 60px 拖入 → 球心距边缘 ~68px
    const midBallCx = stMid.x + 48, midBallCy = stMid.y + 36
    setCursor(midBallCx, midBallCy)
    await sleep(400)
    dragProc = dragMoves(midBallCx, midBallCy, nearCx, midBallCy)
    await sleep(1400)
    releaseLeft()
    await new Promise((r) => { dragProc.on('exit', r); setTimeout(r, 5000) })
    await sleep(2200) // 弹簧吸附+变形动画
    const dockPos = await evalJs(oc, `window.api.overlayGetState()`)
    const dockFb = await evalJs(mc, `window.api.getStore().then(s => s.settings.floatBall || {})`)
    const dockCls = await evalJs(oc, `document.getElementById('ball').className`)
    const flushX = waWin.x + waWin.width - 96
    check('靠近边缘松手 → 果冻吸附贴右缘(flush)', !!dockPos && Math.abs(dockPos.x - flushX) <= 2 && dockFb.edge === 'right',
      `吸附后 x=${dockPos && dockPos.x} 期望=${flushX} edge=${dockFb && dockFb.edge}`)
    check('吸附后半圆贴边变形(dock-right 类)', typeof dockCls === 'string' && dockCls.includes('dock-right'), dockCls)

    // 场景三:从右缘拖到屏幕顶部附近(向左下移出右缘阈值)→ 上下边缘识别回归
    const stR = await evalJs(oc, `window.api.overlayGetState()`)
    const rightBallCx = stR.x + 48, rightBallCy = stR.y + 36
    setCursor(rightBallCx, rightBallCy)
    await sleep(400)
    const topTargetCx = waWin.x + 400, topTargetCy = waWin.y + 60 // 球心距顶 60、距右 >200
    dragProc = dragMoves(rightBallCx, rightBallCy, topTargetCx, topTargetCy)
    await sleep(1600)
    releaseLeft()
    await new Promise((r) => { dragProc.on('exit', r); setTimeout(r, 5000) })
    await sleep(2200)
    const topPos = await evalJs(oc, `window.api.overlayGetState()`)
    const topFb = await evalJs(mc, `window.api.getStore().then(s => s.settings.floatBall || {})`)
    const topCls = await evalJs(oc, `document.getElementById('ball').className`)
    check('靠近顶部松手 → 吸附贴顶缘(上下识别回归)', !!topPos && Math.abs(topPos.y - waWin.y) <= 2 && topFb.edge === 'top',
      `吸附后 y=${topPos && topPos.y} 期望=${waWin.y} edge=${topFb && topFb.edge}`)
    check('贴顶后半圆变形(dock-top 类)', typeof topCls === 'string' && topCls.includes('dock-top'), topCls)

    // 场景四:从顶缘拖到屏幕底部附近 → 底边吸附;弹簧期间连续采样,
    // 球体视觉底边(窗口 y + ball rect.bottom)不得瞬移/出屏(历史 bug:首帧上跳 264px)
    const stT = await evalJs(oc, `window.api.overlayGetState()`)
    const topBallCx = stT.x + 48, topBallCy = stT.y + 36
    setCursor(topBallCx, topBallCy)
    await sleep(400)
    const bottomTargetCx = waWin.x + 800
    const bottomTargetCy = waWin.y + waWin.height - 50 // 球心距底 50px ≤ 吸附阈值
    dragProc = dragMoves(topBallCx, topBallCy, bottomTargetCx, bottomTargetCy)
    await sleep(1400)
    releaseLeft()
    await new Promise((r) => { dragProc.on('exit', r); setTimeout(r, 5000) })
    let prevBottom = null, maxJump = 0, maxOvershoot = 0
    for (let i = 0; i < 30; i++) {
      const s = await evalJs(oc, `(() => { const r = document.getElementById('ball').getBoundingClientRect(); return window.api.overlayGetState().then(st => st && (st.y + r.bottom)) })()`)
      if (typeof s === 'number') {
        if (prevBottom != null) maxJump = Math.max(maxJump, Math.abs(s - prevBottom))
        maxOvershoot = Math.max(maxOvershoot, s - (waWin.y + waWin.height))
        prevBottom = s
      }
      await sleep(50)
    }
    await sleep(1800) // 等弹簧收敛+落位
    const botPos = await evalJs(oc, `window.api.overlayGetState()`)
    const botFb = await evalJs(mc, `window.api.getStore().then(s => s.settings.floatBall || {})`)
    const botCls = await evalJs(oc, `document.getElementById('ball').className`)
    const flushY = waWin.y + waWin.height - 340
    check('底边吸附:弹簧期间无瞬移(帧间 ≤24px)', maxJump <= 24, `maxJump=${maxJump.toFixed(1)}px`)
    // 果冻挤压 squash 最高 1.28×,球心不变底边瞬时多出 ~9px;最终落位精确 flush(y=1060)。
    // 这里的 10px 是挤压余量,不是位置错误;真正的回归守卫是上面的「无瞬移」。
    check('底边吸附:出屏不超过果冻挤压余量(≤10px)', maxOvershoot <= 10, `overshoot=${maxOvershoot.toFixed(1)}px`)
    check('靠近底部松手 → 吸附贴底缘(flush)', !!botPos && Math.abs(botPos.y - flushY) <= 2 && botFb.edge === 'bottom',
      `吸附后 y=${botPos && botPos.y} 期望=${flushY} edge=${botFb && botFb.edge}`)
    check('贴底后半圆变形(dock-bottom 类)', typeof botCls === 'string' && botCls.includes('dock-bottom'), botCls)

    // 场景五:最小拖出距离——只拖到刚好越过吸附阈值(球心距底 90px > 80px),
    // 松手后不得回吸、不得瞬移、原地保持
    const dockCx5 = botPos.x + 48, dockCy5 = botPos.y + 36 + 272
    setCursor(dockCx5, dockCy5)
    await sleep(500)
    const minTargetCy = waWin.y + waWin.height - 90 // 球心距底 90px,刚过阈值
    dragProc = dragMoves(dockCx5, dockCy5, dockCx5, minTargetCy)
    let prevMin = null, minJump = 0, minPressJump = null
    for (let i = 0; i < 12; i++) {
      await sleep(120)
      const c = await evalJs(oc, `(() => { const r = document.getElementById('ball').getBoundingClientRect(); return window.api.overlayGetState().then(st => st && (st.y + r.top + r.height / 2)) })()`)
      if (typeof c === 'number') {
        if (minPressJump == null) minPressJump = Math.abs(c - dockCy5)
        if (prevMin != null) minJump = Math.max(minJump, Math.abs(c - prevMin))
        prevMin = c
      }
    }
    releaseLeft()
    await new Promise((r) => { dragProc.on('exit', r); setTimeout(r, 5000) })
    await sleep(1000)
    const minPos1 = await evalJs(oc, `window.api.overlayGetState()`)
    await sleep(800) // 再等一轮:验证不会延迟回吸
    const minPos2 = await evalJs(oc, `window.api.overlayGetState()`)
    const minFb = await evalJs(mc, `window.api.getStore().then(s => s.settings.floatBall || {})`)
    check('最小拖出:脱钩瞬间不起跳(≤48px)', minPressJump != null && minPressJump <= 48, `pressJump=${minPressJump != null && minPressJump.toFixed(1)}px`)
    check('最小拖出:拖拽全程无瞬移(≤40px/采样)', minJump <= 40, `maxJump=${minJump.toFixed(1)}px`)
    // 拖拽期球心=光标;松手归一后窗口 y = 球心 − 36(球心在窗口内偏 36px)
    check('最小拖出刚过阈值 → 自由摆放不回吸', !!minPos1 && !minFb.edge && Math.abs(minPos1.y - (minTargetCy - 36)) <= 24,
      `实际 y=${minPos1 && minPos1.y} 期望≈${minTargetCy - 36} edge=${minFb && minFb.edge}`)
    check('最小拖出后原地保持(无延迟回吸)', !!minPos2 && minPos2.x === minPos1.x && minPos2.y === minPos1.y,
      `(${minPos1 && minPos1.x},${minPos1 && minPos1.y}) → (${minPos2 && minPos2.x},${minPos2 && minPos2.y})`)

    // 场景六:从最小拖出后的自由位继续拖出——球心须全程贴合光标,不得瞬移
    //(历史 bug:拖出瞬间形变偏移消退而抓取点不变,球上跳 272px)
    const dockCx = minPos2.x + 48, dockCy = minPos2.y + 36 // 自由态主球屏幕中心
    setCursor(dockCx, dockCy)
    await sleep(500)
    const outCx = dockCx - 500, outCy = dockCy - 420 // 拖向屏内空位
    dragProc = dragMoves(dockCx, dockCy, outCx, outCy)
    let prevC = null, maxDragJump = 0
    for (let i = 0; i < 16; i++) {
      await sleep(120)
      const c = await evalJs(oc, `(() => { const r = document.getElementById('ball').getBoundingClientRect(); return window.api.overlayGetState().then(st => st && (st.y + r.top + r.height / 2)) })()`)
      if (typeof c === 'number') {
        if (prevC != null) maxDragJump = Math.max(maxDragJump, Math.abs(c - prevC))
        prevC = c
      }
    }
    releaseLeft()
    await new Promise((r) => { dragProc.on('exit', r); setTimeout(r, 5000) })
    await sleep(1000)
    const outPos = await evalJs(oc, `window.api.overlayGetState()`)
    const outFb = await evalJs(mc, `window.api.getStore().then(s => s.settings.floatBall || {})`)
    check('底边脱钩后继续拖拽:全程无瞬移(≤120px/采样)', maxDragJump <= 120, `maxDragJump=${maxDragJump.toFixed(1)}px`)
    check('拖出后自由摆放(不再吸回底边)', !!outPos && !outFb.edge && Math.abs(outPos.x - (outCx - 48)) <= 24 && Math.abs(outPos.y - (outCy - 36)) <= 24,
      `实际=(${outPos && outPos.x},${outPos && outPos.y}) edge=${outFb && outFb.edge}`)

    // 场景七:注入两个任务小球后拖回底边——小球须堆叠在主球上方且不出屏
    //(历史 bug:小球留在原槽位,底边吸附时悬空在上方 200px 外)
    await evalJs(oc, `(() => { const orbs = document.getElementById('orbs'); orbs.innerHTML = ''; for (let i = 0; i < 2; i++) { const o = document.createElement('div'); o.className = 'orb'; o.innerHTML = '<div class="dot"><span></span></div>'; orbs.appendChild(o); } })()`)
    const freeCx = outPos.x + 48, freeCy = outPos.y + 36
    setCursor(freeCx, freeCy)
    await sleep(500)
    dragProc = dragMoves(freeCx, freeCy, waWin.x + 800, waWin.y + waWin.height - 50)
    await sleep(1400)
    releaseLeft()
    await new Promise((r) => { dragProc.on('exit', r); setTimeout(r, 5000) })
    await sleep(2500)
    const rebotPos = await evalJs(oc, `window.api.overlayGetState()`)
    const orbGap = await evalJs(oc, `(() => { const orbs = document.getElementById('orbs').children; if (orbs.length < 2) return null; const o = orbs[1].getBoundingClientRect(); const b = document.getElementById('ball').getBoundingClientRect(); return { orbBottom: o.bottom, orbTop: o.top, ballTop: b.top, ballBottom: b.bottom } })()`)
    check('拖回底边再吸附(flush)', !!rebotPos && Math.abs(rebotPos.y - flushY) <= 2, `y=${rebotPos && rebotPos.y} 期望=${flushY}`)
    check('底边吸附时任务小球紧贴主球上方', !!orbGap && orbGap.orbBottom <= orbGap.ballTop + 2 && orbGap.ballTop - orbGap.orbBottom <= 16,
      orbGap && `小球底=${orbGap.orbBottom.toFixed(1)} 主球顶=${orbGap.ballTop.toFixed(1)}`)
    check('任务小球不出屏', !!orbGap && orbGap.orbTop >= waWin.y && orbGap.orbBottom <= waWin.y + waWin.height + 1,
      orbGap && `top=${orbGap.orbTop.toFixed(1)} bottom=${orbGap.orbBottom.toFixed(1)}`)

    // 场景八:吸附态真实双击主球 → 展开主窗(历史 bug:按下即拖拽,双击永远落空)
    const ballDblCx = rebotPos.x + 48, ballDblCy = rebotPos.y + 36 + 272 // 贴底时主球在窗口内下压 272px
    dblClick(ballDblCx, ballDblCy)
    await sleep(1500)
    const mainVisAfterDbl = await evalJs(mc, `document.visibilityState`)
    check('吸附态双击主球 → 主窗展开', mainVisAfterDbl === 'visible', mainVisAfterDbl)
    showWindow(ep, 2, mainHandle) // 重新最小化,不干扰后续 restore 断言
    await sleep(1200)

    const pdCount = await evalJs(oc, `window.__pd`)
    const pdInfo = await evalJs(oc, `JSON.stringify(window.__pdInfo)`)
    const orbStart = await evalJs(oc, `window.__orbDragStart === true`)
    const orbErr = await evalJs(oc, `window.__orbErr || null`)
    const errMsg = await evalJs(oc, `window.__err`)
    check('pointerdown 到达球体且处理函数执行', pdCount >= 1 && orbStart === true, `pd=${pdCount} info=${pdInfo} handler=${orbStart} captureErr=${orbErr} err=${errMsg}`)

    // 贴边形态截图
    const shot2 = await oc.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(TMP, 'overlay-docked.png'), Buffer.from(shot2.result.data, 'base64'))
    console.log('贴边截图: ' + path.join(TMP, 'overlay-docked.png'))
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
