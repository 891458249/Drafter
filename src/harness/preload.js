// harness 窗口专用 preload。
//
// 关键约束(实测得出):contextBridge.exposeInMainWorld 暴露的函数在被主世界调用时,
// 仍运行在 preload 的隔离世界;它返回的 Promise<Response>/ReadableStream 里的对象
// 用的是隔离世界的构造器,到主世界后 instanceof/方法表对不上(res.text is not a function)。
//
// 因此正确做法:preload 只提供「同步可结构化克隆」的原语(发消息、收数据),
// 真正的 transport/Response/ReadableStream 组装全部在主世界脚本里完成。
// 主世界脚本由主进程渲染 index.html 时以 inline <script> 注入(见 harness-bridge.js),
// 它从 window.__DRAFTER_IPC_RAW__ 读这些原语。

const { contextBridge, ipcRenderer } = require('electron')

// —— 同步原语(全部只返回结构化克隆的纯数据,不构造 Web API 对象)———————————————————

// unary:发 invoke,拿回纯对象 { ok, status, headers, body(string) }。
// 主世界脚本负责 new Response(...)。
function rawFetch(reqDesc) {
  return ipcRenderer.invoke('harness:fetch', reqDesc)
}

// bundle 源码:返回纯字符串。主世界脚本负责插 <script>。
function rawLoadBundle(url) {
  return ipcRenderer.invoke('harness:loadBundle', { url })
}

// SSE:不发 MessagePort(contextBridge 边界不能 transfer port),改「channelId 对账」:
// 主进程把帧经 webContents.send(`harness:sse:<id>`) 推回来;这里桥接成一个订阅接口,
// 返回 { channelId, onMessage(cb), close() } 给主世界脚本组装 ReadableStream。
function rawOpenSse(url) {
  const channelId = `sse-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const channel = `harness:sse:${channelId}`
  // 订阅器:主世界脚本注册回调;返回取消订阅函数
  const listeners = new Set()
  const subscription = {
    channelId,
    // 主世界脚本调这个注册帧回调
    onMessage(cb) {
      const wrapped = (_event, data) => cb(data)
      listeners.add(wrapped)
      ipcRenderer.on(channel, wrapped)
      return () => { listeners.delete(wrapped); ipcRenderer.removeListener(channel, wrapped) }
    },
    close() {
      for (const w of listeners) ipcRenderer.removeListener(channel, w)
      listeners.clear()
      ipcRenderer.send('harness:closeSse', { channelId })
    },
  }
  ipcRenderer.send('harness:openSse', { channelId, url })
  return subscription
}

// 读 harness 路径(同步)
function rawPaths() {
  return ipcRenderer.sendSync('harness:getPathsSync')
}

try {
  contextBridge.exposeInMainWorld('__DRAFTER_IPC_RAW__', {
    fetch: rawFetch,
    loadBundle: rawLoadBundle,
    openSse: rawOpenSse,
    paths: rawPaths,
  })
  contextBridge.exposeInMainWorld('__DRAFTER_HARNESS_PRELOADED__', true)
  console.log('[drafter-harness] preload ready (raw IPC primitives exposed)')
} catch (err) {
  console.error('[drafter-harness] preload failed:', err)
}
