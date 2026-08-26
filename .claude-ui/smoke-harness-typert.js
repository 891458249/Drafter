// v0.11.7 冒烟:验证 Typert 桥 + 目录选择器 browse 双面板。
// 用法:env -u ELECTRON_RUN_AS_NODE DRAFTER_USERDATA=<隔离目录> node_modules/.bin/electron .claude-ui/smoke-harness-typert.js
//
// 断言:
//  1. Typert RPC:POST /api/pluginInventory/list(无参 Remote endpoint)经复合 handler 拿到 entries
//  2. browse capability:POST /api/host.listDirectory(apiproxy 回落 + directoryPicker browse)
//  3. loader 树里有两行 browse 面板;clientModules 能解析 client 表面包
//  4. 未认领的 /api 路径仍 404(复合 handler 回落语义没破)

const { app } = require('electron')

const bridge = require('../src/main/harness/harness-bridge.js')

function rpc(handler, path, method, payload) {
  return bridge._internal.fetch({
    url: 'http://dsh.internal' + path,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
}

async function main() {
  await app.whenReady()
  const ctx = await bridge.bootHarness()
  console.log('SMOKE: harness booted')

  let failures = 0
  const check = (name, ok, detail) => {
    console.log(`SMOKE ${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : ' — ' + detail}`)
    if (!ok) failures++
  }

  // 1. Typert RPC(pluginInventory/list 无参,直接 Remote)
  const typert = await rpc(null, '/api/pluginInventory/list', 'pluginInventory/list', { args: {} })
  let typertOk = false
  let typertDetail = ''
  try {
    const body = JSON.parse(typert.body)
    typertOk = typert.ok && body.type === 'server-response' && body.result && body.result.ok === true
      && Array.isArray(body.result.value.entries)
    typertDetail = `status=${typert.status} body=${String(typert.body).slice(0, 200)}`
  } catch (e) { typertDetail = `parse err: ${e.message}; status=${typert.status} body=${String(typert.body).slice(0, 200)}` }
  check('Typert pluginInventory/list returns entries', typertOk, typertDetail)

  // 2. browse capability(apiproxy 回落 + directoryPicker browse 后端)
  const list = await rpc(null, '/api/host.listDirectory', 'host.listDirectory', {})
  let listOk = false
  let listDetail = ''
  try {
    const body = JSON.parse(list.body)
    listOk = list.ok && body.result && body.result.ok === true && Array.isArray(body.result.value.entries)
    listDetail = `status=${list.status} body=${String(list.body).slice(0, 200)}`
  } catch (e) { listDetail = `parse err: ${e.message}; status=${list.status} body=${String(list.body).slice(0, 200)}` }
  check('host.listDirectory (browse capability) lists home', listOk, listDetail)

  // 3. loader 树 + client 表面包解析
  const entryNames = [...ctx.loader.entries()].map((e) => e.options.name)
  check('loader has browse backend entry', entryNames.includes('@deepseek-ai/dsh-host-directory-picker-browse'), entryNames.join(','))
  check('loader has browse client entry', entryNames.includes('@deepseek-ai/dsh-client-ui-directory-picker-browse'), entryNames.join(','))
  const clientModules = ctx.get('clientModules')
  const surfacePath = clientModules && clientModules.clientPath('@deepseek-ai/dsh-client-ui-directory-picker-browse')
  check('clientModules resolves browse surface bundle', typeof surfacePath === 'string', String(surfacePath))

  // 4. 未认领路径仍 404
  const missing = await rpc(null, '/api/no.suchMethod', 'no.suchMethod', {})
  check('unclaimed /api path still 404', missing.status === 404, `status=${missing.status}`)

  await bridge.shutdownHarness()
  console.log(failures === 0 ? 'SMOKE: ALL PASS' : `SMOKE: ${failures} FAILURES`)
  app.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error('SMOKE FATAL:', e); app.exit(1) })
