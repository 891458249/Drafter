# Phase 1 设计:Electron IPC 桥(定稿)

## 链路(三段)

```
渲染进程 (file:// 加载 harness 前端 dist)
  └─ IpcApiClient extends AbstractApiClient   [src/harness/preload.js 注入 __DSH_TRANSPORT__]
        doFetch(req) ──invoke──┐
        openMux/openHost ──────┤ (MessagePort / webContents.send)
                               ▼
主进程 Drafter                  [src/main/harness-bridge.js]
  ├─ boot('drafter', cordis.yml, [patches])  拿到 ctx
  ├─ toFetchHandler(ctx.apiProxy).fetch(req) ── 官方导出,直接用
  └─ SSE Response.body (ReadableStream) → 转发回渲染进程
```

**零 hack**:全部走官方导出(`AbstractApiClient` / `toFetchHandler` / `window.__DSH_TRANSPORT__` 注入点 / `boot()`)。

## 关键决策

1. **不 spawn 子进程,harness 跑在 Drafter 主进程内**——harness 是纯 Node ESM,Electron 主进程就是 Node。**已实测(Electron 33 / Node v20.18.3)**:`app-boot`/`apiproxy`(handler+client)均 import 成功;`node:sqlite` 缺失但 `session-query-sqlite` 是 `import type`+`openAt:'never'` 惰性,`session-persistence-sqlite` 动态 import 且 base 用 jsonl——**Node 20 非阻断**,禁掉 sqlite 行即可。
2. **不 patch webserver/client-connection 包**,只提供一个 Drafter 专属 cordis.yml profile,`disabled` 掉 `webserver`/`web-runtime`/`client-connection`/`client-hmr` 四行,`api-gateway` 行保留(它只 provide `ctx.apiProxy`,不注册路由)。
3. **`window.__DSH_TRANSPORT__` 由 preload 注入**——`createApiClient()` 返回 `IpcApiClient`,`fetch` 走 IPC unary,`loadBundle` 留空(harness 前端的 client 模块 bundle 经 `file://` 加载,不走 HTTP)。
4. **SSE(mux/host 事件流)用 MessagePort**:`IpcApiClient.openMux/openHost` 各建一个 MessageChannel,把 port1 传主进程,主进程侧消费 `Response.body` ReadableStream,逐帧 `port.postMessage` 推回。
5. **Drafter 现有渲染端(Chat/创作/画布/素材)与 harness 前端分窗/分视图共存**——Phase 5 再做壳合并,Phase 1 先用一个独立 BrowserWindow 把 harness 前端跑通。

## 要创建的文件

| 文件 | 职责 |
|---|---|
| `src/main/harness-bridge.js` | 主进程:boot harness、提供 `harness:fetch`(invoke)+ `harness:events`(MessagePort)IPC、生命周期 |
| `src/harness/preload.js` | harness 窗口专用 preload:注入 `__DSH_TRANSPORT__`,实现 `IpcApiClient` |
| `src/harness/profile/cordis.yml` | Drafter 专属 profile:禁 webserver/web-runtime/connection/hmr,保留 api-gateway 及全部 agent 能力 |
| `src/harness/host-entry.js` | harness 窗口入口 HTML/加载器(引 harness dist 的 assets) |

## cordis.yml profile 草案

```yaml
# Drafter 桌面 harness profile — 基于 web-app bundle,禁用 HTTP 传输层
- id: webserver
  disabled: true
- id: web-runtime
  disabled: true
- id: connection
  disabled: true
- id: client-hmr
  disabled: true
# api-gateway、modules、client-runtime 等保留;modules 的 node 半仍需提供 __DSH_BOOT__
```

待验证点:modules 的 node 半(host side)是否依赖 webserver 来服务 client bundle——若是,Electron 侧需要经 file:// 直接加载 dist 里的 bundle 而非 `/plugins/<id>/client.js`。

## 验证标准(Phase 1 完成)
- Drafter 启动后开一个 harness 窗口,file:// 加载 harness dist,UI 正常渲染
- 能列工作区、建会话、发消息、看到流式回复(经 IPC 桥)
- `npm test` 现有 146 例不回归
