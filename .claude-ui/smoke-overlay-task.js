// 悬浮球任务态端到端冒烟(v0.13.6):真实会话回合驱动。
// 链路:复制真实 Key 到隔离 userData → dev 启动 → 建会话发极短 prompt(会产生
// 极少 token 消耗)→ 等 busy → minimize → 断言小球出现/进度爬升 → 等完成变绿 →
// 真实点击绿球 → 断言主窗恢复+悬浮窗隐藏+小球清除。
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
process.env.NODE_PATH = 'D:/ClaudeUI/vendor/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules'
require('module').Module._initPaths()

const ROOT = 'D:/ClaudeUI'
const TMP = path.join(os.tmpdir(), 'drafter-ovltask-' + process.pid)
const USERDATA = path.join(TMP, 'userdata')
fs.mkdirSync(USERDATA, { recursive: true })
// 复制真实 Key 体系(隔离副本,测完删;会产生一次极短真实请求)
fs.copyFileSync(path.join(process.env.APPDATA, 'Drafter', 'drafter-store.json'), path.join(USERDATA, 'drafter-store.json'))
const CDP = 9300 + (process.pid % 400)
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)) } }, 60000)
  })
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, send })))
}
async function evalJs(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result && r.result.result ? r.result.result.value : undefined
}
async function listTargets() { return (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() }
function setCursor(x, y) {
  execSync(`powershell -NoProfile -Command "$sig='[System.Runtime.InteropServices.DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x, int y);'; $t=Add-Type -MemberDefinition $sig -Name C -Namespace W -PassThru; [void]$t::SetCursorPos(${Math.round(x)}, ${Math.round(y)})"`)
}
function clickAt(x, y) {
  execSync(`powershell -NoProfile -Command "$sig='[System.Runtime.InteropServices.DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x, int y);[System.Runtime.InteropServices.DllImport(\\"user32.dll\\")] public static extern void mouse_event(int f, int x, int y, int d, int e);'; $t=Add-Type -MemberDefinition $sig -Name K -Namespace W -PassThru; [void]$t::SetCursorPos(${Math.round(x)}, ${Math.round(y)}); Start-Sleep -Milliseconds 300; $t::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 60; $t::mouse_event(4,0,0,0,0)"`)
}
function mainElectronPid() {
  return parseInt(execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=''electron.exe''' | Where-Object { $_.ParentProcessId -eq ${proc.pid} } | Select-Object -ExpandProperty ProcessId"`).toString().trim(), 10)
}
function showWindow(pid, cmd, handle) {
  const h = execSync(`powershell -NoProfile -Command "if ('${handle || ''}' -eq '') { $p=Get-Process -Id ${pid}; $p.Refresh(); $p.MainWindowHandle } else { New-Object System.IntPtr([long]('${handle}')) }"`).toString().trim()
  execSync(`powershell -NoProfile -Command "$sig='[System.Runtime.InteropServices.DllImport(\\"user32.dll\\")] public static extern bool ShowWindow(System.IntPtr h, int c);'; $t=Add-Type -MemberDefinition $sig -Name U32 -Namespace W -PassThru; $t::ShowWindow((New-Object System.IntPtr([long]('${h}'))), ${cmd}) | Out-Null"`)
  return h
}

let failed = 0
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra != null ? ' | ' + extra : ''))
  if (!cond) failed++
}

;(async () => {
  if (!(await waitCdp())) { console.error('CDP not ready'); console.error(out.slice(-2000)); process.exit(1) }
  await sleep(3000)
  const main = (await listTargets()).find((t) => t.url.includes('src/index.html'))
  check('主窗 target 存在', !!main)
  const mc = await connect(main.webSocketDebuggerUrl)

  // SDK 可用性
  const sdk = await evalJs(mc, `window.api.sdkStatus()`)
  check('Agent SDK 可用', !!(sdk && sdk.ok), sdk && sdk.error)

  // 预置悬浮球设置并建会话、发一个短回合(有流式过程便于观察进度)
  await evalJs(mc, `window.api.setSetting('floatBall', { asked: true, enabled: true })`)
  const sid = await evalJs(mc, `window.api.sessCreate({ cwd: 'C:\\\\Windows\\\\Temp', title: '悬浮球冒烟' }).then(m => m && m.id)`)
  check('会话已创建', !!sid, sid)
  await evalJs(mc, `window.api.sessSend('${sid}', '从1数到100,每行一个数字,不要其他内容')`)
  console.log('  已发送短回合,等待 busy…')

  // 等 busy(最长 30s)
  let busy = false
  for (let i = 0; i < 60; i++) {
    const b = await evalJs(mc, `window.api.sessList().then(l => l.find(s => s.id === '${sid}'))`)
    if (b && b.busy) { busy = true; break }
    await sleep(500)
  }
  check('会话进入 busy', busy)

  // minimize 主窗 → 悬浮窗应出现并快照到 busy 会话
  const ep = mainElectronPid()
  const h = showWindow(ep, 2)
  await sleep(2500)
  const overlay = (await listTargets()).find((t) => t.url.includes('overlay.html'))
  check('minimize 后悬浮窗出现', !!overlay)
  const oc = await connect(overlay.webSocketDebuggerUrl)

  // 小球出现且非 done,busy 态带斑马纹旋转环
  await sleep(1000)
  const orbInfo1 = await evalJs(oc, `(() => { const o = document.querySelector('.orb'); if (!o) return null; const cs = getComputedStyle(o, '::before'); return { n: document.querySelectorAll('.orb').length, done: o.classList.contains('done'), error: o.classList.contains('error'), busy: o.classList.contains('busy'), spin: cs.animationName, title: o.title } })()`)
  check('任务小球出现(1个,busy 斑马环旋转)', !!orbInfo1 && orbInfo1.n === 1 && !orbInfo1.done && !orbInfo1.error && orbInfo1.busy === true && orbInfo1.spin === 'orb-spin', JSON.stringify(orbInfo1))
  const shot1 = await oc.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(TMP, 'task-busy.png'), Buffer.from(shot1.result.data, 'base64'))
  console.log('进行中截图: ' + path.join(TMP, 'task-busy.png'))

  // 斑马环持续旋转(动画 1.1s/圈,采样间隔内应推进)
  await sleep(4000)
  const orbInfo2 = await evalJs(oc, `(() => { const o = document.querySelector('.orb'); return o ? { busy: o.classList.contains('busy'), done: o.classList.contains('done'), spin: getComputedStyle(o, '::before').animationName } : null })()`)
  check('加载环持续或任务已完成', !!orbInfo2 && ((orbInfo2.busy && orbInfo2.spin === 'orb-spin') || orbInfo2.done), JSON.stringify(orbInfo2))

  // 等回合完成(最长 180s)→ 变绿
  let doneOrb = null
  for (let i = 0; i < 90; i++) {
    doneOrb = await evalJs(oc, `(() => { const o = document.querySelector('.orb'); return o ? { done: o.classList.contains('done'), error: o.classList.contains('error') } : null })()`)
    if (doneOrb && doneOrb.done) break
    await sleep(2000)
  }
  check('完成后小球变绿', !!doneOrb && doneOrb.done === true && doneOrb.error === false, JSON.stringify(doneOrb))
  const shot2 = await oc.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(TMP, 'task-done.png'), Buffer.from(shot2.result.data, 'base64'))
  console.log('完成截图: ' + path.join(TMP, 'task-done.png'))

  // 点击绿球 → 主窗恢复 + 悬浮窗隐藏 + 小球清除(真实输入;先轮询确认悬停已切可交互)
  const st = await evalJs(oc, `window.api.overlayGetState()`)
  const orbCx = st.x + 48, orbCy = st.y + 96 // 首个小球中心(28..68, 76..116)
  async function tryClickOrb() {
    setCursor(orbCx, orbCy)
    for (let i = 0; i < 10; i++) {
      await sleep(200)
      const s = await evalJs(oc, `window.api.overlayGetState()`)
      if (s && s.interactive) break
    }
    clickAt(orbCx, orbCy)
    await sleep(2500)
    return {
      mainVis: await evalJs(mc, `document.visibilityState`),
      overlayVis: await evalJs(oc, `document.visibilityState`),
      orbs: await evalJs(oc, `document.querySelectorAll('.orb').length`),
      st: await evalJs(oc, `window.api.overlayGetState()`),
    }
  }
  let r = await tryClickOrb()
  if (!(r.mainVis === 'visible' && r.overlayVis === 'hidden' && r.orbs === 0)) {
    console.log('  首次点击未生效,重试一次;诊断 interactive=' + (r.st && r.st.interactive) + ' orbs=' + r.orbs)
    r = await tryClickOrb()
  }
  check('点击绿球后主窗恢复', r.mainVis === 'visible', r.mainVis)
  check('点击绿球后悬浮窗隐藏', r.overlayVis === 'hidden', r.overlayVis)
  check('点击后绿球已清除', r.orbs === 0, `剩余小球=${r.orbs}`)

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
  proc.kill()
  // 截图留档到仓库,便于人工查看
  try {
    const keep = path.join(ROOT, '.claude-ui', 'smoke-out')
    fs.mkdirSync(keep, { recursive: true })
    for (const f of ['task-busy.png', 'task-done.png']) {
      const p = path.join(TMP, f)
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(keep, 'overlay-' + f))
    }
    console.log('截图留档: ' + keep)
  } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('SMOKE ERROR:', e.message)
  console.error(out.split('\n').filter((l) => l.includes('[overlay') || l.includes('Error')).slice(-8).join('\n'))
  try { proc.kill() } catch {}
  process.exit(1)
})
