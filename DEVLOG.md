## 功能清单(落地状态跟踪)

### A. 旧工具已有功能(必须全部保留)
- [x] A1 目录选择 + 最近项目
- [x] A2 流式对话(Markdown/思考块/工具卡片,可展开输入输出)
- [x] A3 权限模式下拉 / 模型下拉
- [x] A4 API Key 配置(存 userData,注入 env,不回传渲染端)
- [x] A5 内嵌终端(pty + xterm)
- [x] A6 耗时/轮数/费用统计行
- [x] A7 新会话 / 切换目录

### B. 缺口清单(对照 2026-07-24 官方桌面端文档)
核心交互:
- [x] (已回归) B1 权限确认 UI(canUseTool,Allow once/Always/Deny,Edit 显示 diff)
- [x] (未回归) B2 中断不销毁会话(interrupt)
- [x] (未回归) B3 会话历史与恢复(持久化 + resume)
- [x] (未回归) B4 多会话并行(侧边栏,独立上下文)
- [x] (未回归) B5 运行中追加消息(streaming input,不打断)
- [x] (未回归) B6 Auto 模式 → SDK 无此模式,降级:下拉提供全部 SDK 支持模式(default/acceptEdits/plan/bypassPermissions/dontAsk)
Git 工作流:
- [x] (未回归) B7 Diff 视图(+n -n 指示器,逐文件)
- [x] (未回归) B8 Diff 行内评论 → 批量回传给 Claude
- [x] (未回归) B9 Review code 按钮
- [x] (未回归) B10 PR 监控(gh CLI 轮询 checks,Auto-fix 提示)
- [x] (未回归) B11 每会话 Git worktree 隔离(可选开关)+ 归档清理
输入:
- [x] (未回归) B12 @文件引用自动补全
- [x] (未回归) B13 图片粘贴/拖拽附件(content blocks)
- [x] (未回归) B14 斜杠命令列表(内置 + ~/.claude/commands + 项目 .claude/commands)
- [x] (未回归) B15 Plan 模式审批面板(ExitPlanMode → 批准/继续计划)
面板:
- [x] (未回归) B16 多面板布局(chat/diff/终端/文件/预览/任务,可显隐+分栏)
- [x] (未回归) B17 文件编辑器面板(点路径打开、编辑、保存、外部变更警告)
- [x] (未回归) B18 浏览器预览面板(webview,localhost 预览 + 外部站点确认)
- [x] (未回归) B19 任务面板(子代理/后台命令,parent_tool_use_id 归组)
- [x] (未回归) B20 视图模式 Normal/Verbose/Summary
- [x] (未回归) B21 用量显示(context tokens/费用)+ /compact 按钮
- [x] (未回归) B22 快捷键体系 + Ctrl+/ 面板
- [x] (未回归) B23 多终端标签
会话形态:
- [x] (未回归) B24 Side chat(forkSession,不污染主线)
- [x] (未回归) B25 会话重命名/归档/筛选
系统集成:
- [x] (未回归) B26 OS 通知(任务完成且非当前会话)
- [x] (未回归) B27 定时任务(简易调度器,cron 到点自动向新会话发 prompt)
- [x] (未回归) B28 MCP servers 管理 UI(读写 ~/.claude.json mcpServers)
- [x] (未回归) B29 自动更新占位(electron-builder nsis;仅打包配置,不接更新服务器)

### C. 明确不落地(超出本地工具能力,记录原因)
- 云端会话 / SSH / WSL 会话(依赖 Anthropic 云与远程装配基建)
- Dispatch 手机派发、Continue in、claude.ai OAuth 登录(依赖 claude.ai 账号服务)
- Computer use / iOS 模拟器(依赖官方私有工具链)
- Connectors 市场、企业管控(依赖官方服务)
- Auto 权限模式的安全分类器(官方服务端能力,见 B6 降级)

---

## 实现记录(2026-07-24)

架构:主进程从「裸 spawn claude CLI」迁移到 `@anthropic-ai/claude-agent-sdk`(v0.3.218,ESM,经动态 `import()` 加载;Electron 33 主进程内 E2E 验证通过,子进程 env 注入 `ELECTRON_RUN_AS_NODE=1`)。

- 主进程模块化:`src/main/`
  - `sessions.js` — 多会话并行,query() streaming input(B4/B5),canUseTool→渲染端权限卡(B1),interrupt()(B2),resume/forkSession(B3/B24),事件持久化 JSONL(userData/sessions/*.jsonl)供重放,OS 通知(B26)
  - `store.js` — 设置/会话元数据/事件日志/定时任务持久化
  - `git.js` — diff numstat/单文件 diff(B7)、worktree 创建清理(B11)、gh PR 轮询(B10)
  - `files.js` — 文件列表(@补全)、读写+外部变更检测(B17)
  - `commands.js`(B14)、`mcp.js`(B28)、`scheduler.js`(B27)、`terminal.js` 多 pty(B23)
- 渲染端 ES 模块:`src/renderer/`(app/state/chat/input/sessions-ui/diff/editor/preview/tasks/term)
  - 权限卡 Allow once / Always(本会话)/ Deny,Edit/Write 显示行内 diff(B1)
  - 计划模式:ExitPlanMode → 计划审批卡,批准后自动切 acceptEdits(B15)
  - 子代理按 parent_tool_use_id 归组折叠 + 任务面板(B19)
  - 视图模式 Normal/Verbose/Summary(B20);用量 chip + /compact(B21);快捷键 + Ctrl+/(B22)
  - @文件补全 / 斜杠命令下拉 / 图片粘贴拖拽 content blocks(B12/B13/B14)
  - diff 行内评论批量回传(B8)、Review code(B9)、PR 监控 + Auto-fix(B10)
  - 文件编辑器(点击路径打开、mtime 冲突检测)(B17)、webview 预览(B18)、多终端标签(B23)
- 已知限制/待打磨:
  - B6:SDK 无 Auto 模式,下拉提供 default/acceptEdits/plan/dontAsk/bypassPermissions
  - 权限「总是允许」目前为会话级内存记忆 + SDK suggestions 透传,未写入 settings.local.json 独立规则编辑器
  - 会话重放基于本地 JSONL 事件日志(SDK 自身 transcript 用于 resume)
  - E2E 已验证:SDK init / 回复 / result 费用统计;其余功能待日常使用中回归

## 项目组改版(2026-07-24 晚)

会话不再全局平铺,以**项目组**为一级分组:

- 数据模型:store 新增 `projects`(id/name/dirs/files+tag),会话带 `projectId`;旧会话启动时按 cwd 自动迁移进组(worktree 会话归属其仓库根)
- 新会话路径不属于任何组 → 自动建组(目录名命名);组名双击可改;组头 ＋ 按钮在组内新建会话
- **组内上下文互通**:每组一个共享记忆文件 `<主目录>/.claude-ui/memory.md`,注入每个会话的 systemPrompt(preset append),并指示 Claude 主动读写沉淀跨会话结论;文件落盘,重启不丢(会话本身靠 JSONL 日志重放 + SDK resume 恢复)
- **文件标签**:组内可加载多个文件/文件夹,标签「只读/可改」实时切换;只读通过 SDK PreToolUse hook 硬拦截 Edit/Write/MultiEdit/NotebookEdit(E2E 验证:bypassPermissions 下也拦得住),canUseTool 兜底二道防线,systemPrompt 内同步声明
- 组内多目录通过 `additionalDirectories` 授权新会话访问
- **会话内工具条**(输入框上方):＋文件(图片转附件,其他登记项目组并插入 @路径)、＋文件夹(登记 + 自动 /add-dir)、＋图片(文件选择器)、本会话模型切换(与顶栏双向同步)
