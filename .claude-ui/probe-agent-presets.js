// 探针:boot harness → agentPreset.list RPC → 打印花名册;再列 loader 条目里 agent-presets 行状态。
// 用法:env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron .claude-ui/probe-agent-presets.js
process.env.DSH_HOME = require('node:path').join(require('node:os').tmpdir(), 'dsh-ap-' + process.pid, 'harness')
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const bridge = require('../src/main/harness/harness-bridge.js')

async function rpc(method, payload) {
  const res = await bridge._internal.fetch({
    url: 'http://drafter.local/api/' + method,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'probe-' + method, method, payload: payload ?? {} }),
  })
  return res
}

async function main() {
  await app.whenReady()
  const ctx = await bridge.bootHarness()
  // loader 里 agent-presets 行的状态
  try {
    const entries = ctx.loader.entries().filter((e) => String(e.options.id).includes('preset'))
    for (const e of entries) {
      console.log('ENTRY', e.options.id, '| disabled:', !!e.options.disabled, '| fiber:', !!e.fiber)
    }
  } catch (e) { console.log('entries err:', e.message) }
  const svc = ctx.get('agentPresets')
  console.log('agentPresets service:', svc ? 'present' : 'ABSENT', svc ? '| roots: ' + JSON.stringify(svc.roots) : '')
  const list = await rpc('agentPreset.list')
  console.log('agentPreset.list status:', list.status)
  console.log('agentPreset.list body:', (list.body || '').slice(0, 2000))

  // 会话创建冒烟:默认 preset 'standard' 会在 setup 里真实 mount 整个组合,
  // 任一行在我们环境(Electron/Node20)起不来都会让 session.create 失败。
  const wk = await rpc('workspace.create', { path: 'D:\\ClaudeUI' })
  console.log('workspace.create:', (wk.body || '').slice(0, 300))
  let wsId
  try { wsId = JSON.parse(wk.body).result.value.workspace.id } catch {}
  const sc = await rpc('session.create', wsId ? { workspaceId: wsId } : { cwd: 'D:\\ClaudeUI' })
  console.log('session.create status:', sc.status)
  console.log('session.create body:', (sc.body || '').slice(0, 1200))
  // 再验证 preset 切换(recompose)与极简预设 mount
  let sessId
  try { const v = JSON.parse(sc.body).result.value; sessId = v.sessionId || (v.session && v.session.id) } catch {}
  if (sessId) {
    const sel = await rpc('agentPreset.select', { sessionId: sessId, agentPreset: 'minimal' })
    console.log('agentPreset.select(minimal):', (sel.body || '').slice(0, 400))
  }
  // 其余两套预设也各自建会话验证 mount(standard 上面已验证)
  for (const preset of ['code', 'cordis']) {
    const r = await rpc('session.create', { ...(wsId ? { workspaceId: wsId } : { cwd: 'D:\\ClaudeUI' }), agentPreset: preset })
    const ok = (r.body || '').includes('"ok":true')
    console.log(`session.create(${preset}):`, ok ? 'OK' : (r.body || '').slice(0, 600))
  }
  try { fs.rmSync(path.dirname(process.env.DSH_HOME), { recursive: true, force: true }) } catch {}
  setTimeout(() => app.exit(0), 800)
}

main().catch((e) => { console.error('FATAL:', e); app.exit(1) })
