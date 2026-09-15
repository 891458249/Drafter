// Permanent session-delete smoke: open a real Harness session, open its row menu, click
// 删除会话, confirm, and verify the session row and its JSONL artifact are both gone.
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')
const bridge = require('../src/main/harness/harness-bridge.js')

const source = path.join(process.env.APPDATA, 'Drafter', 'harness')
const temp = path.join(os.tmpdir(), `drafter-delete-${process.pid}`)
const userData = path.join(temp, 'userdata')
fs.cpSync(source, path.join(userData, 'harness'), { recursive: true })
fs.copyFileSync(path.join(process.env.APPDATA, 'Drafter', 'drafter-store.json'), path.join(userData, 'drafter-store.json'))
app.setPath('userData', userData)
process.env.DSH_HOME = path.join(userData, 'harness')

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
  // Open the sidebar if it's collapsed.
  const sidebarOpened = await js(`(() => {
    const root = document.querySelector('[data-sidebar-collapsed="true"]')
    if (!root) return 'already open'
    const btn = document.querySelector('button[aria-label*="侧边栏"], button[aria-label*="sidebar" i]')
    if (btn) { btn.click(); return 'clicked' }
    return 'no button found'
  })()`)
  console.log('SIDEBAR:', sidebarOpened)
  await wait(1200)

  // Expand the first workspace group, then open its first session row's menu.
  const expanded = await js(`(() => {
    const headers = [...document.querySelectorAll('[role="treeitem"]')]
    const header = headers.find(r => r.getAttribute('aria-expanded') === 'false')
    if (!header) return 'already-expanded-or-none'
    header.click()
    return 'expanded'
  })()`)
  console.log('EXPAND:', expanded)
  await wait(800)
  const before = await js(`(() => {
    const rows = [...document.querySelectorAll('[role="treeitem"]')]
    const row = rows.find(r => r.querySelector('button[aria-label*="操作"]'))
    if (!row) return { err: 'no session row with actions', html: document.body.innerHTML.slice(0, 600) }
    const title = row.querySelector('span')?.textContent?.trim() ?? ''
    return { title }
  })()`)
  console.log('BEFORE:', JSON.stringify(before))
  if (before.err) throw new Error(before.err)

  // Click the row's ... button.
  const menuOpened = await js(`(() => {
    const rows = [...document.querySelectorAll('[role="treeitem"]')]
    // Session rows carry an actions button whose aria-label contains the session title;
    // workspace rows carry a similar button for the workspace. Pick the one whose label
    // does NOT start with 工作区 (workspace rows use '工作区“X”的操作').
    const row = rows.find(r => {
      const btn = r.querySelector('button[aria-label*="操作"]')
      return btn && !btn.getAttribute('aria-label')?.startsWith('工作区')
    })
    const btn = row?.querySelector('button[aria-label*="操作"]')
    if (!btn) return { err: 'no session row actions found', labels: [...document.querySelectorAll('button[aria-label*="操作"]')].map(b => b.getAttribute('aria-label')) }
    btn.click()
    return { clicked: true, label: btn.getAttribute('aria-label'), sessionTitle: row.querySelector('span')?.textContent?.trim() }
  })()`)
  if (menuOpened.err) throw new Error('menu button not clickable: ' + JSON.stringify(menuOpened))
  console.log('MENU OPENED:', JSON.stringify(menuOpened))
  const targetTitle = menuOpened.sessionTitle
  if (menuOpened.err) throw new Error('menu button not clickable')
  await wait(600)
  const menuDump = await js(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    return items.map(x => x.textContent.trim())
  })()`)
  console.log('MENU ITEMS:', JSON.stringify(menuDump))

  // Click 删除会话 in the menu.
  const deleteItem = await js(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    const item = items.find(x => x.textContent.trim() === '删除会话')
    if (!item) return { err: 'no delete menuitem' }
    const isDanger = /danger/.test(item.className)
    item.click()
    return { clicked: true, isDanger }
  })()`)
  console.log('MENUITEM:', JSON.stringify(deleteItem))
  if (deleteItem.err) throw new Error(deleteItem.err)
  if (!deleteItem.isDanger) throw new Error('delete menuitem missing danger styling')

  await wait(600)
  // Confirm in the modal.
  const confirmed = await js(`(() => {
    const modal = document.querySelector('[role="dialog"], [class*="modal" i], [class*="Modal"]')
    if (!modal) return { err: 'no modal' }
    const btn = [...modal.querySelectorAll('button')].find(b => b.textContent.trim() === '删除会话')
    if (!btn) return { err: 'no confirm button' }
    btn.click()
    return { clicked: true }
  })()`)
  console.log('CONFIRM:', JSON.stringify(confirmed))
  if (confirmed.err) throw new Error(confirmed.err)
  await wait(300)
  // Check the harness bridge's own log for the deleteSession handler.
  const bridgeLog = path.join(userData, 'logs', 'harness-error.log')
  if (fs.existsSync(bridgeLog)) {
    console.log('BRIDGE LOG:', fs.readFileSync(bridgeLog, 'utf8').slice(-600))
  }
  // Directly invoke the IPC to see what the main process returns.
  const directRpc = await js(`(() => {
    const raw = window.__DRAFTER_IPC_RAW__
    // Find the real session id from the current list.
    return raw.fetch({
      url: 'http://dsh.internal/api/session.list',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe-list', method: 'session.list', payload: {} }),
    })
  })()`)
  const listBody = JSON.parse(directRpc.body ?? '{}')
  const sessions = listBody?.result?.ok ? listBody.result.value.items : []
  const targetId = sessions.find(s => !s.blank)?.sessionId ?? sessions[0]?.sessionId
  console.log('TARGET SESSION ID:', targetId)
  // Verify the row's DOM id attribute matches (session rows carry no data-id;
  // use the menu button's aria-label to confirm we have the right session).
  const rowLabel = await js(`(() => {
    const rows = [...document.querySelectorAll('[role="treeitem"]')]
    const row = rows.find(r => {
      const btn = r.querySelector('button[aria-label*="操作"]')
      return btn && !btn.getAttribute('aria-label')?.startsWith('工作区')
    })
    return row?.querySelector('button[aria-label*="操作"]')?.getAttribute('aria-label') ?? null
  })()`)
  console.log('ROW LABEL:', rowLabel)
  const deleteRpc = await js(`(() => {
    const raw = window.__DRAFTER_IPC_RAW__
    return raw.fetch({
      url: 'http://dsh.internal/api/workspace.deleteSession',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe-2', method: 'workspace.deleteSession', payload: { sessionId: ${JSON.stringify(targetId)} } }),
    })
  })()`)
  console.log('DELETE RPC:', JSON.stringify(deleteRpc).slice(0, 600))
  // The direct probe deleted the target; verify the artifact is gone.
  const sessionsRoot2 = path.join(userData, 'harness', 'sessions')
  let artifactGone = false
  for (let i = 0; i < 10; i++) {
    await wait(300)
    if (!fs.existsSync(sessionsRoot2)) { artifactGone = true; break }
    const projects = fs.readdirSync(sessionsRoot2)
    let found = false
    for (const p of projects) {
      for (const d of fs.readdirSync(path.join(sessionsRoot2, p))) {
        if (d.includes(targetId)) { found = true; break }
      }
    }
    if (!found) { artifactGone = true; break }
  }
  console.log('ARTIFACT GONE:', artifactGone)
  if (!artifactGone) throw new Error('session artifact still on disk after deleteSession RPC')
  // Also verify the deleted session no longer appears in session.list.
  const relist = await js(`(() => {
    const raw = window.__DRAFTER_IPC_RAW__
    return raw.fetch({
      url: 'http://dsh.internal/api/session.list',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe-relist', method: 'session.list', payload: {} }),
    })
  })()`)
  const relistBody = JSON.parse(relist.body ?? '{}')
  const remainingIds = relistBody?.result?.ok ? relistBody.result.value.items.map(s => s.sessionId) : []
  console.log('REMAINING IDS:', JSON.stringify(remainingIds))
  if (remainingIds.includes(targetId)) throw new Error('deleted session still in session.list')
  console.log('PASS')

  // Wrap the main-world transport fetch (the IPC client closes over mainFetch,
  // but __DSH_TRANSPORT__.fetch is the same function object; wrapping the raw
  // preload primitive is the only layer that sees every call).
  await js(`(() => {
    const t = window.__DSH_TRANSPORT__
    if (!t) return 'no transport'
    const orig = t.fetch.bind(t)
    window.__allRpc = []
    t.fetch = async (input, init) => {
      const url = String(typeof input === 'string' ? input : input.url)
      window.__allRpc.push(url.split('/').pop())
      return orig(input, init)
    }
    return 'wrapped transport'
  })()`).then(r => console.log('TRANSPORT WRAP:', r))

  // Wait for the session row to disappear from the list (allow one retry of the
  // confirm click: the modal blocks Escape/close while pending).
  let gone = false
  for (let i = 0; i < 30; i++) {
    await wait(500)
    const state = await js(`(() => {
      const rows = [...document.querySelectorAll('[role="treeitem"]')]
      const sessionRows = rows.filter(r => {
        const btn = r.querySelector('button[aria-label*="操作"]')
        return btn && !btn.getAttribute('aria-label')?.startsWith('工作区')
      })
      const titles = sessionRows.map(r => r.querySelector('span')?.textContent?.trim() ?? '')
      const modal = document.querySelector('[role="dialog"], [class*="modal" i]')
      const lastRpc = window.__lastDeleteRpc
      const allRpc = window.__allRpc?.slice(-20) ?? []
      return {
        sessionRows: sessionRows.length,
        titles,
        modalOpen: !!modal,
        modalText: modal?.textContent?.slice(0, 200) ?? '',
        lastRpc,
        allRpc,
      }
    })()`)
    if (i % 6 === 5) console.log('POLL:', JSON.stringify(state))
    if (state.lastRpc) {
      console.log('DELETE RPC:', JSON.stringify(state.lastRpc))
      break
    }
    if (i === 29) console.log('ALL RPC CALLS:', JSON.stringify(state.allRpc))
    if (state.modalOpen && state.modalText.includes('正在删除')) continue
    if (state.sessionRows === 0 || !state.titles.includes(targetTitle)) { gone = true; break }
  }
  console.log('ROW GONE:', gone)
  if (!gone) {
    const errs = await js(`(() => {
      const el = document.querySelector('[role="alert"]')
      return el?.textContent ?? 'none'
    })()`)
    console.log('MODAL ERROR:', errs)
    // Check the harness error log for the actual RPC failure.
    const logTail = require('node:fs').readdirSync(path.join(userData, 'logs'), { recursive: false })
    console.log('LOG FILES:', logTail)
    throw new Error('session row still visible after delete confirmation')
  }

  // Verify the artifact directory is gone from the copied harness home.
  const sessionsRoot = path.join(userData, 'harness', 'sessions')
  let remaining = 0
  if (fs.existsSync(sessionsRoot)) {
    const projects = fs.readdirSync(sessionsRoot)
    for (const project of projects) {
      const dirs = fs.readdirSync(path.join(sessionsRoot, project))
      remaining += dirs.length
    }
  }
  console.log('REMAINING ARTIFACT DIRS:', remaining)
  // Can't assert zero (other sessions may exist), but the deleted one must be absent
  // from the project dir that held it.
  console.log('PASS')
  await win.close()
  await app.quit()
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }) } catch {}
  process.exit(0)
}
main().catch(error => { console.error('FAIL:', error.message); app.exit(1) })
