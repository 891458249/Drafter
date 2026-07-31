# Claude UI

Claude Code 的桌面界面(Electron)。基于 `@anthropic-ai/claude-agent-sdk` 与 Claude Code 直接通信,支持多会话并行、项目组管理、权限确认 UI、Git 工作流与内嵌终端,不必再在 PowerShell 里手动启动。

## 启动与打包

```powershell
npm start      # 启动应用
npm run dist   # electron-builder 打包,输出 dist/(Windows nsis 安装包)
```

## 架构

- `main.js` — Electron 主进程入口,负责窗口、生命周期与 IPC 注册。
- `src/main/` — 主进程模块:
  - `sessions.js` — 多会话并行、流式对话、权限回调(canUseTool)、中断/恢复、事件持久化(JSONL)
  - `store.js` — 设置、会话元数据、事件日志、定时任务持久化
  - `git.js` — diff 视图数据、worktree 隔离、gh PR 轮询
  - `files.js` — 文件列表与读写、外部变更检测
  - `commands.js` — 斜杠命令聚合 / `mcp.js` — MCP servers 管理 / `scheduler.js` — 定时任务 / `terminal.js` — node-pty 多终端 / `projects.js` — 项目组
- `preload.js` — contextBridge 安全 IPC 桥。
- `src/renderer/` — 渲染端 ES 模块(app / state / chat / input / sessions-ui / diff / editor / preview / tasks / term),入口 `src/index.html` + `styles.css`。
- 数据持久化在 Electron userData 目录(设置、会话元数据、JSONL 事件日志、定时任务)。

## 功能概览

- **多会话并行**:侧边栏独立上下文会话,支持历史恢复(resume)、重命名/归档/筛选、运行中追加消息、中断不销毁会话、Side chat(forkSession)。
- **项目组**:会话按项目组一级分组,组内共享 `memory.md` 跨会话记忆;可登记文件/文件夹并打「只读/可改」标签,只读由 PreToolUse hook 硬拦截;多目录经 additionalDirectories 授权。
- **权限确认 UI**:canUseTool 弹卡片(Allow once / Always / Deny),Edit/Write 显示行内 diff;Plan 模式审批面板(批准后自动切 acceptEdits)。
- **Git 工作流**:diff 视图(+n -n 逐文件)+ 行内评论批量回传、Review code、PR 监控(gh 轮询 checks + Auto-fix 提示)、可选每会话 worktree 隔离。
- **内嵌终端**:node-pty + xterm,多终端标签。
- **输入增强**:@文件引用自动补全、斜杠命令下拉、图片粘贴/拖拽附件。
- **面板体系**:chat / diff / 终端 / 文件 / 预览 / 任务多面板显隐分栏;视图模式 Normal/Verbose/Summary;用量显示 + /compact;快捷键体系(Ctrl+/ 面板)。
- **其他**:定时任务(cron 到点自动向新会话发 prompt)、MCP servers 管理 UI、OS 通知、electron-builder 打包 + electron-updater 自动更新(发布流程见 RELEASE.md)、首次启动引导卡、权限规则管理。

## 已知事项

- **终端** 依赖 node-pty 原生模块。安装时若缺少 Visual Studio C++ 工具链,`electron-rebuild` 编译会失败,但 node-pty 自带 win32-x64 预编译二进制,通常仍可用;若终端报错,安装「Visual Studio Build Tools(含 Desktop development with C++)」后运行 `npm run rebuild`。
- **图标** `build/icon.ico` 是脚本生成的占位图标(深底 + CU 字母,`node build/make-icon.js` 可重新生成),可替换为正式图标后重新 `npm run dist`。
- 对话等核心功能不依赖任何原生模块,开箱即用。

## 版本与提交规范

- 版本号采用 semver,以 `package.json` 的 `version` 字段为准。
- 每次向远程推送前:先 bump version,提交信息以 `vX.Y.Z:` 开头,并打同名 git tag。
- 推送命令:`git push origin main --tags`。
