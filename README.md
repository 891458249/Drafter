# Claude UI

一个为 Claude Code 打造的桌面界面(Electron),不必再每次在 PowerShell 里手动启动。

## 启动

```powershell
cd D:\ClaudeUI
npm start
```

## 使用

1. 启动后在首屏 **选择项目目录**(或点最近打开的项目)。
2. 进入工作区后:
   - **对话** 标签:像 Claude Desktop 一样聊天,支持流式回复、Markdown、思考块、工具调用卡片(点卡片头可展开查看输入/输出)。
   - **终端** 标签:内嵌一个真正的 claude 交互式终端,用于权限确认或直接敲命令。
3. 顶栏可切换 **权限模式** 和 **模型**,点 **新会话** 重开,点 **切换目录** 换项目。

## 架构

- `main.js` — Electron 主进程。用 `claude -p --output-format stream-json --input-format stream-json` 启动常驻会话,双向流式通信;终端标签用 node-pty。
- `preload.js` — contextBridge 安全 IPC 桥。
- `src/` — 界面(index.html / styles.css / renderer.js)。renderer.js 负责把 stream-json 事件渲染成聊天 UI。
- 最近项目与设置持久化在 Electron userData 目录下的 `claude-ui-store.json`。

## 已知事项

- **终端标签** 依赖 node-pty 原生模块。安装时因缺少 Visual Studio C++ 工具链,`electron-rebuild` 编译失败,但 node-pty 自带 win32-x64 预编译二进制,通常仍可用;若终端报错,安装「Visual Studio Build Tools（含 Desktop development with C++）」后运行 `npm run rebuild`。
- **对话标签**(核心功能)不依赖任何原生模块,开箱即用。

## 打包为 .exe(可选)

```powershell
npm run dist
```
输出在 `dist/` 目录。
