// 探针:win32 盘符层(C:\ 根)经 bridge 的 host.listDirectory 返回盘符 crumbs。
// 用法:env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron .claude-ui/probe-drives.js
process.env.DSH_HOME = require('node:path').join(require('node:os').tmpdir(), 'dsh-drv-' + process.pid, 'harness')
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const bridge = require('../src/main/harness/harness-bridge.js')

app.whenReady().then(async () => {
  let failures = 0
  const check = (name, ok, detail) => {
    console.log(`PROBE ${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : ' — ' + String(detail).slice(0, 200)}`)
    if (!ok) failures++
  }
  await bridge.bootHarness()
  const list = async (p) => {
    const res = await bridge._internal.fetch({
      url: 'http://dsh.internal/api/host.listDirectory', method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'host.listDirectory',
        payload: p === undefined ? {} : { path: p } }),
    })
    return { status: res.status, body: JSON.parse(res.body) }
  }

  // 盘根:crumbs 应为各盘符(C:/D:/...),entries 为空
  const root = await list('C:\\')
  const crumbs = (root.body.result?.value?.crumbs || []).map((c) => c.name)
  const entries = root.body.result?.value?.entries || []
  console.log('PROBE: C:\\ crumbs =', JSON.stringify(crumbs), 'entries =', entries.length)
  check('drive root lists drive letters as crumbs', root.status === 200 && crumbs.includes('C:'), JSON.stringify(crumbs))
  check('drive root has no directory entries', entries.length === 0, `${entries.length} entries`)

  // 盘符下的正常层级不受影响:列 D:\(若存在)或 C:\ 下一级
  const sub = await list('C:\\Users')
  const subEntries = sub.body.result?.value?.entries || []
  const subCrumbs = (sub.body.result?.value?.crumbs || []).map((c) => c.name)
  console.log('PROBE: C:\\Users crumbs =', JSON.stringify(subCrumbs.slice(-3)), 'entries =', subEntries.length)
  check('normal level unaffected (C:\\Users lists dirs)', sub.status === 200 && subEntries.length > 0, `status=${sub.status} entries=${subEntries.length}`)
  check('normal level crumbs end at C:\\Users', subCrumbs[subCrumbs.length - 1] === 'Users', JSON.stringify(subCrumbs))

  try { fs.rmSync(path.dirname(process.env.DSH_HOME), { recursive: true, force: true }) } catch {}
  await bridge.shutdownHarness()
  console.log(failures === 0 ? 'PROBE: ALL PASS' : `PROBE: ${failures} FAILURES`)
  app.exit(failures === 0 ? 0 : 1)
}).catch((e) => { console.error('PROBE FATAL:', e); app.exit(1) })
