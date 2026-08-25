// 浏览器侧 harness IPC 客户端入口:继承官方 AbstractApiClient,传输走 Electron IPC。
// 这个文件会被 tsdown 打包成单个自包含 ESM(bundle 掉 AbstractApiClient + zod 依赖链),
// 产物由主进程渲染 index.html 时以 inline <script type="module"> 注入,在 harness 前端
// 脚本之前执行,装好 window.__DSH_TRANSPORT__。
//
// 传输原语从 window.__DRAFTER_IPC_RAW__ 读(preload 用 contextBridge 暴露,只返回
// 结构化克隆的纯数据);Response/ReadableStream 都在主世界这里构造,避免跨世界构造器错位。

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'

const raw = globalThis.__DRAFTER_IPC_RAW__
if (!raw) throw new Error('[drafter-harness] __DRAFTER_IPC_RAW__ 未预置(preload 应先注入)')

// unary/respond:raw.fetch 拿回纯对象,这里 new Response(主世界构造器)。
async function mainFetch(input, init) {
  let url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url)
  if (url && url.startsWith('/')) url = 'http://dsh.internal' + url
  const reqDesc = {
    url,
    method: (init && init.method) || 'GET',
    headers: (init && init.headers) || {},
    body: init && init.body !== undefined ? init.body : undefined,
  }
  const res = await raw.fetch(reqDesc)
  if (!res.ok) throw new Error(`harness IPC fetch failed: ${res.error || 'unknown'}`)
  return new Response(res.body, { status: res.status, headers: res.headers })
}

// client 模块 bundle 加载:raw.loadBundle 拿源码文本,插 <script> 到主世界文档。
async function mainLoadBundle(url) {
  const res = await raw.loadBundle(url)
  if (!res.ok) throw new Error(`harness loadBundle failed for ${url}: ${res.error || 'unknown'}`)
  const blob = new Blob([res.code], { type: 'text/javascript' })
  const blobUrl = URL.createObjectURL(blob)
  await new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = blobUrl
    el.onload = () => { URL.revokeObjectURL(blobUrl); el.remove(); resolve() }
    el.onerror = () => { URL.revokeObjectURL(blobUrl); el.remove(); reject(new Error(`bundle script failed: ${url}`)) }
    document.head.appendChild(el)
  })
}

// SSE:raw.openSse 返回 { channelId, onMessage(cb), close() },这里组装成 ReadableStream。
function mainOpenSse(url) {
  const sub = raw.openSse(url)
  let unsubscribe = null
  const stream = new ReadableStream({
    start(controller) {
      unsubscribe = sub.onMessage((msg) => {
        if (!msg) return
        if (msg.type === 'chunk') {
          controller.enqueue(new TextEncoder().encode(msg.chunk + '\n\n'))
        } else if (msg.type === 'end') {
          try { controller.close() } catch {}
          if (unsubscribe) unsubscribe()
        } else if (msg.type === 'error') {
          controller.error(new Error(msg.error || `SSE error status=${msg.status}`))
          if (unsubscribe) unsubscribe()
        }
      })
    },
    cancel() {
      sub.close()
      if (unsubscribe) unsubscribe()
    },
  })
  return stream
}

class IpcApiClient extends AbstractApiClient {
  doFetch(input, init) { return mainFetch(input, init) }
  openMux(_payload, signal, onOpen) { return this._readIpcSse('/api/events.mux', signal, onOpen) }
  openHost(_payload, signal, onOpen) { return this._readIpcSse('/api/events.host', signal, onOpen) }
  async *_readIpcSse(path, signal, onOpen) {
    const url = new URL(path, 'http://dsh.internal').href
    const body = mainOpenSse(url)
    if (onOpen) onOpen()
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const onAbort = () => { reader.cancel().catch(() => {}) }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        if (signal && signal.aborted) return
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('')
          if (data === '') continue
          let full
          let frame
          try {
            full = JSON.parse(data)
            frame = full.payload
          } catch (err) {
            console.error('[drafter-harness] dropping malformed SSE frame:', err)
            continue
          }
          this.onEnvelope(full)
          yield { rpcId: full.rpcId, payload: frame }
        }
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
      await reader.cancel().catch(() => {})
    }
  }
}

// 页面侧安装入口:由 index.html 注入的 inline module 脚本调用。
export function installDshTransport() {
  const transport = {
    createApiClient: () => new IpcApiClient(),
    fetch: mainFetch,
    loadBundle: mainLoadBundle,
  }
  globalThis.__DSH_TRANSPORT__ = transport
  return true
}
