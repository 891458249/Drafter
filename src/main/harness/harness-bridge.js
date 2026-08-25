// harness 桥:Drafter 主进程内 boot deepseek-harness 运行时,经 IPC 向渲染进程提供
// 官方 fetch 载体(toFetchHandler)与 SSE 事件流(MessagePort)。
//
// 设计依据(.claude-ui/harness-phase1-design.md):
//  - 不 spawn 子进程:harness 是纯 Node ESM,Electron 主进程即 Node。实测 Electron 33
//    (Node v20.18.3)可 import app-boot/apiproxy;node:sqlite 缺失但相关包均惰性加载。
//  - 传输层:禁用 webserver/web-runtime/client-connection/client-hmr,改用 IPC;
//    另插 drafterWebServerStub 提供「不监听的 webServer 注册表」满足 client-modules inject。
//  - 渲染进程:preload 注入 window.__DSH_TRANSPORT__ = { createApiClient: () => IpcApiClient }。
//
// 本模块只在主进程使用;全部 harness import 都是动态 import(ESM),避免顶层阻塞。

const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, ipcMain, BrowserWindow } = require('electron')
const keysBridge = require('./keys-bridge')
const permissionBridge = require('./permission-bridge')

// 权限预设配置从 permission-bridge 取(独立模块便于测试与复用)
function keysBridgePermissionConfig() {
  return permissionBridge.permissionPresetsConfig()
}

const HARNESS_ROOT = path.join(__dirname, '..', '..', '..', 'vendor', 'deepseek-harness')

// —— 运行时单例状态 ————————————————————————————————————————————————————————
let harnessCtx = null          // Cordis 根 Context(boot 结果)
let apiFetchHandler = null     // toFetchHandler(ctx.apiProxy).fetch
let bootPromise = null         // 防重入
const sseBridges = new Map()   // channelId → { cancel() } 活跃 SSE 转发器

function log(...args) { console.log('[harness-bridge]', ...args) }
function logErr(...args) { console.error('[harness-bridge]', ...args) }

// —— webServer 存根插件(不监听端口,只保留注册表与 renderIndex)———————————————
// client-modules inject ['webServer','loader'],frontend-static 调 renderIndex;
// 二者都不需要真实 HTTP 监听。此插件复刻 WebServer 的注册表语义,去掉 listen。
function drafterWebServerStubPlugin() {
  return {
    name: 'drafter-webserver-stub',
    // 以「提供 webServer 服务」的身份挂载,顶替被禁用的真 webserver。
    apply(ctx) {
      const exact = new Map()
      const prefixes = new Map()
      const upgrades = new Map()
      const indexTaps = []
      let fallback
      const stub = {
        host: '127.0.0.1',
        port: 0,
        register(route) {
          const table = route.kind === 'exact' ? exact : prefixes
          if (table.has(route.path)) throw new Error(`webserver-stub: duplicate ${route.kind} route "${route.path}"`)
          table.set(route.path, route)
          return () => { table.delete(route.path) }
        },
        registerUpgrade(route) {
          if (upgrades.has(route.path)) throw new Error(`webserver-stub: duplicate upgrade route "${route.path}"`)
          upgrades.set(route.path, route)
          return () => { upgrades.delete(route.path) }
        },
        registerFallback(handler) {
          if (fallback !== undefined) throw new Error('webserver-stub: fallback already registered')
          fallback = handler
          return () => { fallback = undefined }
        },
        tapIndex(transform) {
          indexTaps.push(transform)
          return () => { const i = indexTaps.indexOf(transform); if (i !== -1) indexTaps.splice(i, 1) }
        },
        collectIndexInjections() {
          const table = []
          ctx.emit('webserver/index-inject', table)
          return table
        },
        applyIndexTaps(html) {
          let out = html
          for (const t of indexTaps) out = t(out)
          return out
        },
        // 复刻官方 renderIndex:先渲染结构化注入行(含 __DSH_BOOT__),再过原始 tap。
        renderIndex(html) {
          const rows = stub.collectIndexInjections()
          // 内联一个最小渲染器,与官方 renderIndexInjections 等价(只支持我们用到的行类型)。
          let head = ''
          let body = ''
          for (const row of rows) {
            let markup = ''
            let placement = row.placement || 'head'
            if (row.kind === 'global') {
              const name = JSON.stringify(row.name).replaceAll('<', '\\u003c')
              const value = row.value === undefined ? 'undefined' : JSON.stringify(row.value).replaceAll('<', '\\u003c')
              markup = `<script>globalThis[${name}] = ${value}</script>`
              placement = 'head'
            } else if (row.kind === 'script') {
              markup = `<script>${row.text}</script>`
            } else if (row.kind === 'script-src') {
              markup = `<script src="${row.src}"></script>`
            } else if (row.kind === 'style') {
              markup = `<style>${row.text}</style>`
              placement = 'head'
            } else if (row.kind === 'html') {
              markup = row.html
            }
            if (placement === 'head') head += markup; else body += markup
          }
          let out = html
          if (head) {
            const m = /<head(?:\s[^>]*)?>/i.exec(out)
            out = m === null ? head + out : out.slice(0, m.index + m[0].length) + head + out.slice(m.index + m[0].length)
          }
          if (body) {
            const m = /<body(?:\s[^>]*)?>/i.exec(out)
            out = m === null ? out + body : out.slice(0, m.index + m[0].length) + body + out.slice(m.index + m[0].length)
          }
          return stub.applyIndexTaps(out)
        },
      }
      ctx.provide('webServer', stub)
      log('webServer stub provided (no listen)')
    },
  }
}

// —— boot harness 运行时 ————————————————————————————————————————————————————
async function bootHarness() {
  if (harnessCtx) return harnessCtx
  if (bootPromise) return bootPromise
  bootPromise = (async () => {
    const appBootUrl = pathToFileURL(path.join(HARNESS_ROOT, 'packages/boot/app-boot/lib/index.js')).href
    const appBoot = await import(appBootUrl)
    const { boot } = appBoot
    const apiProxyUrl = pathToFileURL(path.join(HARNESS_ROOT, 'packages/host/apiproxy/lib/index.js')).href
    const { toFetchHandler } = await import(apiProxyUrl)
    const { resolveDshHome } = await import(pathToFileURL(path.join(HARNESS_ROOT, 'packages/util/home-paths/lib/index.js')).href)
    // loadProfile/composeEntries 在 profile.ts,经 app-boot 包根导出
    const { loadProfile, composeEntries } = appBoot

    // 加载官方 web profile($DSH_HOME/profiles/web,首用自动初始化为 base+web-app),
    // 取出它的 bundle patch 层;再叠我们的 Drafter overlay(禁传输层)。
    // loadProfile 签名:(binName, name, installAnchor, home?)。installAnchor 指向一个能
    // 解析到 @deepseek-ai/dsh-base / dsh-web-app 的 package.json——用 apps/cli 的 package.json
    // (apps/cli 依赖了全部 bundle,与官方 dsh CLI 的 INSTALL_ANCHOR 一致)。
    const installAnchor = path.join(HARNESS_ROOT, 'apps/cli/package.json')
    // 关键:官方 CLI 的 prepareProfile 会先 healProfilesModuleFallback,把安装锚点的
    // 依赖图符号链接进 $DSH_HOME/profiles/node_modules,cordis.yml(位于该 profile 目录)
    // 里的裸包名(@deepseek-ai/*)才能被 Node 的 node_modules 查找解析到。缺了这步,
    // loader 会报 Cannot find package(因为 Drafter 自己的 node_modules 里没有这些包)。
    appBoot.healProfilesModuleFallback(installAnchor)
    const profile = loadProfile('drafter', 'web', installAnchor)
    const bundlePatches = profile.layers.flatMap((layer) => layer.patches)
    // PatchOptions 是扁平的 { id, disabled, config, insert, ... }(vendor/include/src/index.ts)。
    // 每个 patch 按 id 定位一行并替换/禁用;我们的 overlay 逐行禁用传输层。
    // 注意:session-query-sqlite 不能禁——它即便 openAt:'never' 也提供 ctx.sessionQuery
    // 服务(apiproxy/session-reference 都依赖),只是不打开 sqlite(node:sqlite 在 Node 20
    // 缺失也无妨,因它是 import type + openAt:'never' 惰性感应)。web-app 层已配 openAt:'never'。
    const drafterOverlay = [
      // 只禁用「宿主侧 HTTP 监听」行:webserver(node:http 监听)、web-runtime(URL 打印/开浏览器)。
      // connection 保留——它的 client 半读 __DSH_TRANSPORT__ 提供 ctx.connection(我们正是注入它);
      //   但 bundle patch 给 connection 配了 inject:[webRuntime](为拿 trustedHosts),webRuntime 被禁后
      //   connection 会一直 pending。这里把 connection 的 inject 覆盖为空数组(我们不走 HTTP 信任围栏,
      //   Electron file:// 本身就是受信环境),并把它的 config.trustedHosts 固定为空。
      { id: 'webserver', disabled: true },
      { id: 'web-runtime', disabled: true },
      { id: 'client-hmr', disabled: true },
      { id: 'connection', inject: [], config: { trustedHosts: [] } },
      // cordis 动态运行时/清单浏览是宿主自修改扩展(dsh-cordis-*),走 host 的
      // dynamicCordisRunner 服务;它是 web 形态的在线插件管理,Electron 桌面版不用
      // (我们的扩展管理走自己的设置页),且其 RPC 通道不在标准 apiproxy RpcMethodMap 里
      // (会 404)。禁用其 client 端 UI/runner 行。
      { id: 'cordis-client-runner', disabled: true },
      { id: 'ui-cordis', disabled: true },
      // Phase 3:权限预设表替换为 Drafter 的 5 档(default/acceptEdits/plan/dontAsk/bypassPermissions),
      // config 整值覆盖,含 presets + defaultPreset。
      { id: 'permission', config: keysBridgePermissionConfig() },
      // Node 20 无 createZstdDecompress(zstd.ts 顶层 import node:zlib 的具名导出);
      // 配 compression:'none' 后 jsonl 走纯文本,不触发 zstd 路径。
      // 注意:patch 的 config 是整值覆盖(vendor/include),root 必填需补回。
      // root 语义 = dshHomePath('sessions'),即 $DSH_HOME/sessions。
      { id: 'session-persistence-jsonl', config: { root: path.join(resolveDshHome(), 'sessions'), compression: 'none' } },
      // Node 20 无 stripTypeScriptTypes;code-runtime 是 run_code 工具(Phase 1 不用),禁用。
      { id: 'code-runtime', disabled: true },
    ]
    const allPatches = [...bundlePatches, ...profile.patches, ...drafterOverlay]

    // profile 根配置:空 entry 列表(与官方 PROFILE_ROOT_CONFIG 一致),由 patch 合成整棵树。
    const configPath = path.join(profile.dir, 'cordis.yml')

    const prepare = async (ctx) => {
      // 关键垫片:Node 20 下 loader.internal 为 undefined(fromInternal 仅支持 Node 22+),
      // 导致插件裸包名退化为「从 vendor/loader/lib/ 普通 import」而解析失败。
      // 这里手搓一个 internal 垫片:import 用 createRequire(apps/cli/package.json) 把
      // @deepseek-ai/* 解析成绝对路径再 import(复用 pnpm workspace 的符号链接);
      // register 委托给官方 node:module.register(HMR 热重载用,Phase 1 用不到但保留)。
      // 统一解析策略:无论 Node 版本,都用「多锚点回退」包一层。
      // Node 20:loader.internal 为 undefined,我们直接装多锚点 shim。
      // Node 24:loader.internal 存在但 internal.import 按 baseUrl 单点解析(bareModuleBaseUrl
      //   指向 base 时找不到 web-app 的包,反之亦然)——包一层,失败时回退多锚点。
      const { createRequire } = await import('node:module')
      const { register } = await import('node:module')
      const anchors = [
        path.join(HARNESS_ROOT, 'packages/bundle/web-app/package.json'),
        path.join(HARNESS_ROOT, 'packages/bundle/base/package.json'),
        path.join(HARNESS_ROOT, 'apps/cli/package.json'),
      ].map((p) => createRequire(pathToFileURL(p).href))
      const resolveAny = (specifier) => {
        for (const req of anchors) {
          try { return req.resolve(specifier) } catch { /* try next anchor */ }
        }
        return anchors[anchors.length - 1].resolve(specifier)
      }
      const shimImport = async (specifier, parentURL) => {
        if (specifier.startsWith('.') || specifier.startsWith('file:') || path.isAbsolute(specifier)) {
          return import(specifier)
        }
        return import(pathToFileURL(resolveAny(specifier)).href)
      }
      if (!ctx.loader.internal) {
        ctx.loader.internal = {
          version: 'v1',
          import: shimImport,
          register(specifier, parentURL, data, transferList) {
            return register(specifier, parentURL, { data, transferList })
          },
        }
        log('loader.internal shim installed (multi-anchor, Node 20 path)')
      } else {
        // 包装现有 internal:先走官方解析,失败再回退多锚点
        const orig = ctx.loader.internal
        const origImport = orig.import.bind(orig)
        ctx.loader.internal = {
          ...orig,
          async import(specifier, parentURL, ...rest) {
            try { return await origImport(specifier, parentURL, ...rest) }
            catch { return shimImport(specifier, parentURL) }
          },
        }
        log('loader.internal wrapped with multi-anchor fallback (Node 24 path)')
      }
      // 存根必须在 client-modules(inject webServer)激活前提供。
      await ctx.plugin(drafterWebServerStubPlugin())
      // web-startup 插件 inject cmdlineArgs(解析 web 应用的 --port/--no-open 等)。
      // 我们没有 CLI,提供空参数快照 + 一个 no-op exit(dsh-cmdline 的 provideCmdline)。
      const cmdlineUrl = pathToFileURL(path.join(HARNESS_ROOT, 'packages/boot/cmdline/lib/index.js')).href
      const { provideCmdline } = await import(cmdlineUrl)
      provideCmdline(ctx, {
        args: [],
        exit: (code) => { log('harness 请求退出, code =', code) },
      })
    }

    log('booting harness, profile dir:', profile.dir)
    // bareModuleBaseUrl 指向 dsh-base:base 的依赖闭包含全部核心插件(timer/llm/session/
    // typert 等),web-app 只含 web 专属插件;从 base 能解析到全部(含 web-app,因 base 被
    // web-app 依赖、pnpm 在 base 的 node_modules 里也有 web 插件的传递链接)。
    const bareModuleBaseUrl = pathToFileURL(path.join(HARNESS_ROOT, 'packages/bundle/base/')).href
    const ctx = await boot('drafter', configPath, allPatches, prepare, bareModuleBaseUrl)
    harnessCtx = ctx

    if (!ctx.apiProxy) throw new Error('harness boot 完成但 ctx.apiProxy 缺失(api-gateway 未挂载?)')
    apiFetchHandler = toFetchHandler(ctx.apiProxy).fetch
    log('harness booted, apiProxy ready')
    // Phase 2:把 Drafter 的多 Key 同步进 harness(credentials + llm-pi-ai providers + 默认模型)
    try {
      const syncResult = await keysBridge.syncKeysToHarness(ctx)
      log('keys synced to harness:', JSON.stringify(syncResult))
    } catch (err) {
      // Key 同步失败不阻断 boot——用户可能还没配 Key;在 UI 层提示即可
      logErr('keys sync failed(可能还没配 Key):', err.message)
    }
    return ctx
  })().catch((err) => {
    bootPromise = null
    logErr('boot failed:', err)
    throw err
  })
  return bootPromise
}

// —— IPC:harness:fetch(unary + respond + SSE 复用同一 fetch 语义)——————————————
// 渲染进程 IpcApiClient.doFetch 把 Request 序列化为可结构化克隆的纯对象传来;
// 这里重建 Request,喂给官方 toFetchHandler,把 Response 序列化回去。
// SSE 流(/events.mux|host)单独走 MessagePort,见 harness:openSse。

function serializeRequestInit(init) {
  if (!init) return {}
  const out = { method: init.method, headers: init.headers, body: init.body }
  return out
}

async function handleHarnessFetch(event, reqDesc) {
  try {
    await bootHarness()
    const url = new URL(reqDesc.url)
    const headers = new Headers(reqDesc.headers || {})
    const init = { method: reqDesc.method || 'GET', headers }
    if (reqDesc.body !== undefined && reqDesc.body !== null) init.body = reqDesc.body
    const request = new Request(url, init)
    const response = await apiFetchHandler(request)
    const resHeaders = {}
    response.headers.forEach((v, k) => { resHeaders[k] = v })
    // SSE 路径不该走到这里(走 MessagePort),但兜底按文本返回。
    const body = await response.text()
    return { ok: true, status: response.status, headers: resHeaders, body }
  } catch (err) {
    logErr('harness:fetch failed:', err)
    return { ok: false, error: String(err && err.message || err) }
  }
}

// —— IPC:harness:openSse —— SSE 流不复用 MessagePort(contextBridge 边界不能 transfer port),
// 改为「channelId 对账 + webContents.send 推流」:渲染进程发起时给 channelId,主进程消费
// toFetchHandler 的 SSE ReadableStream,逐帧经 event.sender.send(`harness:sse:${channelId}`) 推回。
async function handleHarnessOpenSse(event, reqDesc) {
  const channelId = reqDesc.channelId
  const sender = event.sender
  try {
    await bootHarness()
    const request = new Request(new URL(reqDesc.url), { method: 'GET' })
    const response = await apiFetchHandler(request)
    if (!response.ok || !response.body) {
      sender.send(`harness:sse:${channelId}`, { type: 'error', status: response.status })
      return
    }
    sender.send(`harness:sse:${channelId}`, { type: 'open', status: response.status })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let cancelled = false
    sseBridges.set(channelId, { cancel() { cancelled = true; reader.cancel().catch(() => {}) } })
    ;(async () => {
      try {
        let buffer = ''
        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            if (!sender.isDestroyed()) sender.send(`harness:sse:${channelId}`, { type: 'chunk', chunk })
          }
        }
        if (!sender.isDestroyed()) sender.send(`harness:sse:${channelId}`, { type: 'end' })
      } catch (err) {
        if (!sender.isDestroyed()) sender.send(`harness:sse:${channelId}`, { type: 'error', error: String(err && err.message || err) })
      } finally {
        sseBridges.delete(channelId)
      }
    })()
  } catch (err) {
    logErr('openSse failed:', err)
    try { sender.send(`harness:sse:${channelId}`, { type: 'error', error: String(err && err.message || err) }) } catch {}
  }
}

// 渲染进程取消一条 SSE 流
function handleHarnessCloseSse(_event, { channelId }) {
  const bridge = sseBridges.get(channelId)
  if (bridge) { try { bridge.cancel() } catch {} sseBridges.delete(channelId) }
}

// —— IPC:harness:loadBundle —— 渲染进程要加载 client 模块 bundle(/plugins/<id>/client.js)
// 时,经 clientModules.clientPath(id) 解析磁盘绝对路径读文本返回(渲染侧 eval 注册)。
async function handleHarnessLoadBundle(_event, { url }) {
  try {
    await bootHarness()
    // url 形如 /plugins/<id>/client.js 或 /plugins/<id>/client.js?rev=xxx
    const m = /^\/plugins\/(.+)\/client\.js/.exec(url || '')
    if (!m) return { ok: false, error: `unrecognized bundle url: ${url}` }
    const id = decodeURIComponent(m[1])
    const clientModules = harnessCtx && harnessCtx.get('clientModules')
    if (!clientModules || typeof clientModules.clientPath !== 'function') {
      return { ok: false, error: 'clientModules service unavailable' }
    }
    const absPath = clientModules.clientPath(id)
    if (!absPath) return { ok: false, error: `unknown client module id: ${id}` }
    const code = require('node:fs').readFileSync(absPath, 'utf8')
    return { ok: true, code }
  } catch (err) {
    logErr('loadBundle failed:', err)
    return { ok: false, error: String(err && err.message || err) }
  }
}

// —— 渲染 file:// 可加载的 index.html ————————————————————————————————————————
// harness dist 的 index.html 用绝对路径(/assets/...)且不含 __DSH_BOOT__。
// 这里读原始 index → 经 webServer.renderIndex 注入 __DSH_BOOT__ 等结构化行 →
// 把所有 "/assets/..." 与 "/plugins/..." 重写为相对当前文件的 file 路径 → 写到
// userData/harness-web/index.html 供 loadFile。返回该文件路径。
async function renderHarnessIndex() {
  await bootHarness()
  const fs = require('node:fs')
  const distIndex = path.join(HARNESS_ROOT, 'apps/web/dist/index.html')
  const raw = fs.readFileSync(distIndex, 'utf8')
  const webServer = harnessCtx && harnessCtx.get('webServer')
  if (!webServer || typeof webServer.renderIndex !== 'function') {
    throw new Error('webServer stub 未提供 renderIndex')
  }
  let html = webServer.renderIndex(raw)
  // 绝对路径 → 相对 file 路径。index.electron.html 与 assets/ 同目录,/assets/x → ./assets/x。
  // /plugins/<id>/client.js 的两个 parser-blocking 预加载(modules/runtime)改写为 file:// 绝对
  // 路径(经 clientModules.clientPath 解析);其余 /plugins/ 引用由 preload 的 loadBundle 接管。
  html = html.replaceAll('href="/', 'href="./').replaceAll('src="/', 'src="./')
  html = html.replace(/<link rel="manifest"[^>]*>/, '')
  const clientModules = harnessCtx && harnessCtx.get('clientModules')
  if (clientModules && typeof clientModules.clientPath === 'function') {
    html = html.replace(/src="\.\/plugins\/(.+?)\/client\.js(\?rev=[^"]*)?"/g, (match, id, rev) => {
      const abs = clientModules.clientPath(decodeURIComponent(id))
      if (!abs) return match
      return `src="${pathToFileURL(abs).href}"`
    })
  }
  // 注入 transport 安装脚本:一个 inline <script type="module">,import 打包好的
  // ipc-client-entry.mjs 并调 installDshTransport()。module 脚本按文档顺序执行,
  // 它位于 <head> 最前,先于 dist 的 index-*.js(在 <head> 后段),保证 __DSH_TRANSPORT__
  // 在 harness 前端读它之前就位。__DRAFTER_IPC__ 由 preload 同步装好(contextBridge)。
  const bundleFileUrl = pathToFileURL(path.join(__dirname, '..', '..', 'harness', 'dist', 'ipc-client-entry.mjs')).href
  const transportScript = `<script type="module">import { installDshTransport } from ${JSON.stringify(bundleFileUrl)}; installDshTransport();</script>`
  html = html.replace(/<head>/i, `<head>${transportScript}`)
  const outPath = path.join(HARNESS_ROOT, 'apps/web/dist/index.electron.html')
  fs.writeFileSync(outPath, html, 'utf8')
  return outPath
}

// —— 生命周期 ————————————————————————————————————————————————————————————————
function registerHarnessIpc() {
  ipcMain.handle('harness:fetch', handleHarnessFetch)
  ipcMain.handle('harness:loadBundle', handleHarnessLoadBundle)
  // 渲染进程 harness 板块入口:boot + 渲染 index,返回 file:// 可加载的路径
  ipcMain.handle('harness:boot', async () => {
    const p = await renderHarnessIndex()
    return p.replace(/\\/g, '/')
  })
  // harness 板块 webview 的 preload 路径(注入 __DRAFTER_IPC_RAW__ 的那个)
  ipcMain.handle('harness:preloadPath', () => path.join(__dirname, '..', '..', 'harness', 'preload.js').replace(/\\/g, '/'))
  // preload 沙箱取不到 __dirname,经此拿 harness 根路径与打包后的 IPC client bundle 路径
  ipcMain.handle('harness:paths', () => ({
    harnessRoot: HARNESS_ROOT.replace(/\\/g, '/'),
    bundlePath: path.join(__dirname, '..', '..', 'harness', 'dist', 'ipc-client-entry.mjs'),
  }))
  // 同步给 preload 提供 harness 路径(sendSync——preload 启动时同步读)
  ipcMain.on('harness:getPathsSync', (event) => {
    event.returnValue = {
      harnessRoot: HARNESS_ROOT.replace(/\\/g, '/'),
      bundlePath: path.join(__dirname, '..', '..', 'harness', 'dist', 'ipc-client-entry.mjs'),
    }
  })
  ipcMain.on('harness:openSse', handleHarnessOpenSse)
  ipcMain.on('harness:closeSse', handleHarnessCloseSse)
  log('IPC registered (harness:fetch, harness:loadBundle, harness:paths, harness:boot, harness:openSse, harness:closeSse)')
}

async function shutdownHarness() {
  for (const [, b] of sseBridges) { try { b.cancel() } catch {} }
  sseBridges.clear()
  if (harnessCtx) {
    try { await harnessCtx.fiber.dispose() } catch (e) { logErr('dispose failed:', e) }
    harnessCtx = null
    apiFetchHandler = null
    bootPromise = null
    log('harness disposed')
  }
}

module.exports = {
  bootHarness,
  renderHarnessIndex,
  registerHarnessIpc,
  shutdownHarness,
  // Key 变更后重同步(Phase 2)
  resyncKeys: async () => { const ctx = await bootHarness(); return keysBridge.syncKeysToHarness(ctx) },
  // 测试探针
  _internal: { HARNESS_ROOT, drafterWebServerStubPlugin },
}
