// 复现探针:复制真实 DSH_HOME(含 DSH 工作区注册/模型配置/凭据)到临时目录,
// boot harness,按用户真实状态重放 workspace.list → session.create(workspaceId)。
// 用法:env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron .claude-ui/probe-ws-session.js
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const SRC = path.join(process.env.APPDATA, 'Drafter', 'harness')
const TMP = path.join(os.tmpdir(), 'dsh-ws-' + process.pid)
fs.cpSync(SRC, path.join(TMP, 'harness'), { recursive: true })
process.env.DSH_HOME = path.join(TMP, 'harness')
const { app } = require('electron')
const bridge = require('../src/main/harness/harness-bridge.js')

async function rpc(method, payload) {
  return bridge._internal.fetch({
    url: 'http://drafter.local/api/' + method,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'probe-' + method + '-' + Date.now(), method, payload: payload ?? {} }),
  })
}

async function main() {
  await app.whenReady()
  await bridge.bootHarness()

  const wl = await rpc('workspace.list', {})
  console.log('workspace.list:', (wl.body || '').slice(0, 800))
  let wsId
  try { wsId = JSON.parse(wl.body).result.value.items[0].workspaceId } catch (e) { console.log('parse ws fail', e.message) }
  console.log('wsId =', wsId)

  if (wsId) {
    const sc = await rpc('session.create', { workspaceId: wsId })
    console.log('session.create status:', sc.status)
    console.log('session.create body:', (sc.body || '').slice(0, 1500))
    const v = JSON.parse(sc.body).result.value
    const sid = v && (v.sessionId || (v.session && v.session.id))
    if (sid) {
      const sl = await rpc('session.list', {})
      console.log('session.list ok:', (sl.body || '').includes('"ok":true'))
      // 清理:把刚建的空白会话删掉,避免污染拷贝(反正是临时目录,可省)
    }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  setTimeout(() => app.exit(0), 800)
}

main().catch((e) => { console.error('FATAL:', e); try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}; app.exit(1) })
