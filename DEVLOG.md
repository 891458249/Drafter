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
- [x] (已回归) B2 中断不销毁会话(interrupt)
- [x] (已回归) B3 会话历史与恢复(持久化 + resume)——初测失败(F-004),v0.4.9 修复后复测通过
- [x] (已回归) B4 多会话并行(侧边栏,独立上下文)
- [x] (已回归) B5 运行中追加消息(streaming input,不打断)
- [x] (已回归) B6 Auto 模式 → SDK 无此模式,降级:下拉提供全部 SDK 支持模式(default/acceptEdits/plan/bypassPermissions/dontAsk)
Git 工作流:
- [x] (已回归) B7 Diff 视图(+n -n 指示器,逐文件)
- [x] (已回归) B8 Diff 行内评论 → 批量回传给 Claude
- [x] (已回归) B9 Review code 按钮
- [x] (未回归) B10 PR 监控(gh CLI 轮询 checks,Auto-fix 提示)——2026-08-03 环境不具备(无 gh/PR),仅验证优雅降级
- [x] (已回归) B11 每会话 Git worktree 隔离(可选开关)+ 归档清理
输入:
- [x] (已回归) B12 @文件引用自动补全
- [x] (已回归) B13 图片粘贴/拖拽附件(content blocks)
- [x] (已回归) B14 斜杠命令列表(内置 + ~/.claude/commands + 项目 .claude/commands)
- [x] (已回归) B15 Plan 模式审批面板(ExitPlanMode → 批准/继续计划)
面板:
- [x] (已回归) B16 多面板布局(chat/diff/终端/文件/预览/任务,可显隐+分栏)
- [x] (已回归) B17 文件编辑器面板(点路径打开、编辑、保存、外部变更警告)
- [x] (已回归) B18 浏览器预览面板(webview,localhost 预览 + 外部站点确认)
- [x] (已回归) B19 任务面板(子代理/后台命令,parent_tool_use_id 归组)
- [x] (已回归) B20 视图模式 Normal/Verbose/Summary
- [x] (已回归) B21 用量显示(context tokens/费用)+ /compact 按钮
- [x] (已回归) B22 快捷键体系 + Ctrl+/ 面板
- [x] (已回归) B23 多终端标签——初测失败(F-005 shell 硬编码),v0.4.9 修复后复测通过
会话形态:
- [x] (已回归) B24 Side chat(forkSession,不污染主线)
- [x] (已回归) B25 会话重命名/归档/筛选
系统集成:
- [x] (已回归) B26 OS 通知(任务完成且非当前会话)
- [x] (已回归) B27 定时任务(简易调度器,cron 到点自动向新会话发 prompt)
- [x] (已回归) B28 MCP servers 管理 UI(读写 ~/.claude.json mcpServers)
- [x] (已回归) B29 自动更新(electron-builder nsis + electron-updater 接 GitHub Releases,发布流程见 RELEASE.md;v0.4.0 起不再是占位)

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
  - ~~权限「总是允许」目前为会话级内存记忆 + SDK suggestions 透传,未写入 settings.local.json 独立规则编辑器~~ **已解决(v0.3.0)**:「总是允许」现在把 SDK suggestions 规则串(如 `Bash(npm test:*)`)读-改-写持久化到 `<cwd>/.claude/settings.local.json` 的 `permissions.allow`(JSON 损坏时先备份 .bak 再重建;src/main/perms.js);更多菜单新增「权限规则」入口,可查看 allow/deny/ask 并单条删除。生效语义:当前会话由内存 autoAllowTools + updatedPermissions 立即覆盖,重启后的会话由 SDK 自身读取 settings.local.json 生效
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

## 维护记录

### v0.3.0(2026-07-30):权限规则持久化
「总是允许」规则经 src/main/perms.js 读-改-写持久化到 `<cwd>/.claude/settings.local.json`(`permissions.allow`,对齐官方格式如 `Bash(npm test:*)`);JSON 损坏先备份 `.bak-时间戳` 再重建;更多菜单「权限规则…」可查看 allow/deny/ask 并单条删除。当前会话即时生效靠 autoAllowTools + updatedPermissions,重启后由 SDK 读取 settings.local.json 生效。

### v0.3.1(2026-07-30):GPU/disk cache「拒绝访问」修复
- **根因诊断**:启动日志中 cache_util_win.cc "Unable to move the cache: 拒绝访问 (0x5)" 与 disk_cache/gpu_disk_cache 创建失败,源于 userData 下默认 Chromium 缓存目录(Cache/GPUCache/Code Cache)的状态问题——开发期反复启动/强杀进程导致缓存文件被残留锁占用或所有者不一致,启动时的缓存迁移因此被拒。非代码逻辑 bug。
- **修法**(main.js,三管齐下):a) `app.commandLine.appendSwitch('disk-cache-dir', userData/cache)` 把磁盘缓存固定到专用子目录,绕开默认目录的历史状态;b) `app.on('gpu-process-crashed')` 落日志(logger.js),并支持设置项 `disableGpu` 关闭硬件加速(默认仍启用);c) `app.requestSingleInstanceLock()` 单实例锁,杜绝多实例争用缓存,第二实例唤起已有窗口。
- **验证**:修复后 `npm start` 启动 20 秒,stdout/stderr 全程无 cache/gpu/拒绝访问 相关输出,新缓存目录 `userData/cache/Cache_Data` 正常创建使用。

### v0.4.0(2026-07-31):发布体验(自动更新/品牌/首启引导)
- **自动更新接线(B29 落地)**:引入 electron-updater(本任务明确允许的唯一新依赖),`build.publish` 指向 GitHub Releases(仓库 public,已用 REST API 确认);src/main/updater.js 在 ready 后后台检查,状态经 `update:status` 推送顶栏 chip(检查中/新版本+版本号/下载进度/已就绪点击重启);检查失败一律静默降级;发布流程与私有仓库备选方案见 RELEASE.md
- **品牌**:`build/icon.ico` 占位图标(node build/make-icon.js 纯 node 生成 256x256 PNG → ICO,深底 #1a1815 + 珊瑚色 CU);NSIS 改为非一键安装、可自选目录、快捷方式「Claude UI」;补齐 copyright/author 等 exe 元信息
- **首次启动引导卡**:首屏顶部三步卡(配置 API Key → 选项目目录 → 权限模式说明),全部完成或手动关闭后写 `firstRunCompleted` 设置项,之后不再显示;已配置 key 时直接跳过

### v0.4.1(2026-07-31):推理深度会话级化 + 上下文窗口真实值(回归陪跑中发现)
- **推理深度(Effort)改为会话级设置**:移除顶栏全局滑块与 defaultEffort 设置;输入框工具条新增「推理深度」下拉(默认/低/中/高/Extra/Max,与「本会话模型」并列),仅约束当前会话;新建会话 effort 一律 null(跟随 SDK/模型默认),消除「档位粘性传播」(F-002)
- **上下文窗口显示修正**:原用 result.usage(整轮 API 调用输入加总)当上下文大小,含工具调用的轮次显示值约为真实值 2 倍;改用 SDK `result.modelUsage[].contextWindow` 真实值,旧事件退化原启发值(F-003)

### v0.4.2(2026-08-03):安装包 asar 会话修复 + 用量缓存细分
- **F-001 修复(安装包会话不可用)**:根因为 SDK 内部把 claude.exe 解析到 app.asar 归档内路径,OS 无法 spawn;sessions.js 新增 `resolveClaudeExe()` 显式解析真实二进制位置并替换为 app.asar.unpacked(hoisted/嵌套/resourcesPath 三层兜底,win32-x64 包无 exports 限制可直接解析),传入 `options.pathToClaudeCodeExecutable`。test/sessions-bin.test.js 断言解析结果存在且不在 asar 内
- **用量弹层缓存细分**:各模型输入拆出(缓存读/写),附 0.1×/1.25× 计价说明——用于观察 prompt caching 写读比(实测缓存工作正常:全价输入≈0,写 84%/读 16% 为慢节奏测试模式的正常形态)

### v0.4.9(2026-08-03):回归修复(F-004 历史重放 / F-005 终端 shell 回退)
- **F-004**:chat.js handleSessEvent 不再把 live 事件到达标记为"已重放";首个 live 事件先触发 replayHistory,live 事件缓冲,历史渲染后按 eventKey 去重补渲染。B3 复测通过
- **F-005**:terminal.js Windows shell 回退链 powershell.exe → cmd.exe,报错含 shell 名。B23 复测通过(cmd.exe 回退建标签、多标签/关闭/双 pty 独立均正常)

### v0.5.0(2026-08-04):去除全局目录 + 新会话默认独立
- **去除全局目录**:顶栏不再显示「项目名 · cwd」路径(cwd-label 移除),顶栏左侧只留侧边栏开关与 git 分支
- **新会话默认独立**:「＋新会话」不再强制选目录/建项目组,默认创建**独立会话**(cwd=用户主目录,projectId=null,meta.standalone=true);侧边栏新增「独立会话」区收纳;独立会话的 side chat 继承 standalone 不会被自动建组;项目迁移逻辑跳过 standalone/chat 会话
- 项目组会话仍通过组内 ＋ 或落地页「选择项目目录」创建(行为不变)

### v0.5.1(2026-08-04):附件合并 + 项目文件夹常驻显示
- **＋文件 / ＋图片 合并为「＋附件」**:任意文件随下一条消息发送——图片走原生 content block;文本类文件读取内容以 `<附件 name="…">` 围栏内联进消息文本(单文件 50KB 截断);二进制非图片拒收提示;拖拽同步支持两类
- **＋文件夹保留项目级共享语义**(登记 + /add-dir),新增输入框上方常驻 chips 显示当前项目共享的目录(独立会话自动隐藏)

### v0.6.0(2026-08-04):Code / Chat 双板块
- **板块切换**:顶栏新增 Code / Chat 分段开关;现有功能全部归属 Code 板块
- **Chat 板块**:纯对话 AI 不服务项目——会话打 `kind:'chat'` 标记(cwd 内部用主目录,无项目组 systemPrompt 注入/文件标签/共享记忆),侧边栏仅平铺 chat 会话,隐藏项目向 UI(右侧面板/worktree/＋文件夹/git 分支);会话激活时板块自动跟随切换
- Code 板块新会话仍为独立会话(v0.5.0 行为);chat 会话不进任何项目组、不参与项目迁移

### v0.6.2(2026-08-04):项目列表「刷新」按钮
- 侧边栏筛选行新增 ⟳ 刷新:清理磁盘上已不存在的登记目录/文件;主目录已删且组内无会话的项目组直接移除,并弹反馈汇总(projects.pruneMissing)
- 附带:支持 `CLAUDE_UI_USERDATA` 环境变量覆盖 userData(便携/并行实例/隔离测试)

### v0.7.0(2026-08-05):多 API Key + 按 Key 自动识别模型
- **多 Key 管理**(src/main/keys.js):API Keys 弹窗支持任意个 Key(名称/内容/Base URL/类型自动猜测),radio 切换「默认」Key;旧单 apiKey 自动迁移;完整 key 不出主进程(列表仅 …后4位)
- **按 Key 自动识别模型**:每个 Key 可「刷新模型」——按其 Base URL 与认证方式(apiKey→x-api-key 头,authToken→Bearer)拉 /v1/models 并缓存;顶栏与输入框的模型下拉改为按活跃 Key 的模型列表动态填充(无缓存回退内置列表),实测库洛网关识别 243 个模型并动态填充
- **切换隔离**:buildEnv 按活跃 Key 注入并显式清空另一套凭据(API_KEY/AUTH_TOKEN 互清,BASE_URL 缺省归位官方),避免 ~/.claude/settings.json env 串扰

### v0.8.0(2026-08-05):Key 模型勾选 + 周/月额度
- **模型勾选**:每个 Key 的识别模型在弹窗内可勾选(全选/全不选/保存),下拉只显示勾选项;全选等同不限制;实测 243 个模型勾选 3 个后下拉精确过滤
- **周/月额度**:每个 Key 可设周额度(周一 0 点重置)与月额度(每月 1 号 0 点重置),弹窗实时显示「本周/本月已用/额度(剩余 %)」;消耗按会话创建时的 keyId 归账(store.addKeyUsage 滚动桶,读写双向滚动重置)

### v0.8.1(2026-08-05):API Key 用量查询(网页跳转 + 自动余额)
- **用量查询网址**(usageUrl):每个 Key 可填用量页地址(添加/编辑区与每行各一个输入位),填了网址的行显示「打开用量页」(shell.openExternal,仅 http/https);已配置时行内提示「可不设额度,直接网页查用量」
- **自动余额查询**(keys.js BALANCE_PROVIDERS,按 host 可扩展):api.moonshot.cn / api.moonshot.ai / api.kimi.ai → GET /v1/users/me/balance,展示「可用余额 ¥x.xx(代金券 ¥y / 现金 ¥z)」;api.deepseek.com → GET /user/balance,合计 balance_infos;未命中映射不自动查,仅网址跳转或本地额度
- **交互**:命中映射的行显示「查余额」按钮,弹窗打开时对命中映射的活跃 Key 自动查一次;成功结果缓存 balanceCache 持久化,失败仅行内一行错误不打断;显示优先级:自动余额 > 网址跳转 > 本地周/月额度(三者共存)

### v0.9.0(2026-08-05):Key 编辑/预设 + Image/Video/Audio/Model 板块 + 辅助模型
- **Key 可编辑**:Key 列表每行新增「编辑」,弹窗预填 name/kind/baseUrl/usageUrl,secret 留空即保留原值(keys.js save 按 id upsert 时空 key 不覆盖);「默认 Key」统一改名「Kuro」(含存量数据一次性迁移)
- **Key 预设**:弹窗顶部 Kuro/Kimi/Deepseek/Gemini/ChatGPT 一键预填 name+baseUrl+kind;模型下拉旁新增 key-chip 显示当前会话所用 Key
- **模型分类**:refreshModels 优先走 Kuro 网关 `GET /my-models/api`(Bearer/x-api-key),把 `groups[{category,model_type,models}]` 存入 key 的 modelGroups 并合成平铺 models;非 Kuro 网关 404 自动回退 /v1/models
- **六板块**:顶栏 Code/Chat/Image/Video/Audio/Model 分段开关;会话 kind 扩展,非 code 会话统一走 chat 式处理(主目录 cwd、不进项目组);模型下拉按板块过滤(modelGroups 的 model_type,无分组 key 的模型全算 chat)
- **AIGC 生成闭环**(src/main/aigc.js):媒体板块会话不进 Agent SDK——`POST /aigc/api/create-{image|video|audio|3D}` 建任务(Header X-Trace-ID 取 trace_id)→ 3s 轮询 task-detail → `download_wm_sts` 下载产物到 userData/aigc/(水印分支直接 GET download_url,已审批分支手写 COS XML API q-sign-algorithm=sha1 签名直连 COS,无新依赖);参考图走 apply-upload→COS 直传→commit-upload 链;渲染端任务卡片原地更新状态,产物内联渲染(img/video/audio,aigc:// 自定义协议)或 3D 文件卡片
- **辅助模型**(src/main/aux-models.js):Code/Chat 会话附音频(mp3/wav/m4a/ogg)/视频/3D 附件时,发送前用设置的辅助模型经 /v1/chat/completions 分析(image_url/input_audio 多模态块),分析文本以 `<附件分析>` 注入主模型 prompt;未配置/失败时注入文件元信息兜底;设置区(Key 弹窗底部)4 个辅助下拉,候选为各启用 Key 的 chat 类模型
- **实测**:以真实 Kuro Key 端到端跑通文生图(Banana-1,创建→轮询→带水印下载 1.27MB PNG);期间修复 download_wm_sts 返回相对路径 download_url 未解析的 bug(新增同源判定,回网关请求才带鉴权头);npm test 68/68

### v0.9.1(2026-08-05):独立会话项目化确认 + 自动命名 + 代码预览 + 项目右键菜单
- **修复**:main.js/test 引用 `./src/main/aux` 但文件实为 aux-models.js,打包后启动即报 Cannot find module(v0.9.0 安装包不可用)
- **独立会话项目化确认**:独立会话(默认)经输入框「＋文件夹」添加目录时弹窗确认——「设为项目文件夹」建新 IPC proj:adoptDir(ensureForDir 复用/创建项目组,名=文件夹名,会话脱离独立区归入该项目,cwd 不变、目录经 /add-dir 附加生效);「仅添加目录」保持原行为
- **会话自动命名**(src/main/title.js):首条消息发送后用会话自身 Key+模型走 /v1/chat/completions 概括 ≤15 字标题(10s 超时,清洗引号/标点/换行,限长 20);失败退化截取首行前 20 字;autoTitle 标记防重入,写回前再查 store,用户已手动改名不覆盖;新媒体会话直接截取 prompt(媒体模型非 chat 模型);命名完成推 ui_title 事件实时刷新侧栏
- **代码预览**:highlight.js 无浏览器构建,新增 build/make-hljs.js 简易 CJS bundler 生成 src/vendor/hljs.js(38 模块 362KB,common 语言包);聊天内 Write/Edit 工具卡片 body 由 JSON 原文改为文件名头 + 高亮代码块(超 2 万字符截断提示),文件类工具 label 可点击在编辑器面板打开;编辑器面板新增预览/编辑双模式,聊天打开默认只读高亮预览,点「编辑」回到 textarea 流程
- **项目右键菜单**:侧栏项目组头部右键弹出自建菜单「打开文件夹」(proj:openFolder → shell.openPath 主目录),贴边自动内收
- npm test 75/75(新增 test/title.test.js 7 例)

### v0.9.2(2026-08-06):/add-dir 修复 + 更名 DeskTopUI + 模型身份 + 用户消息贴右
- **/add-dir 修复**:SDK 流式输入(stream-json)不会执行 /add-dir 这类本地命令,发出去只是给模型看的文本。改为客户端拦截(main.js sess:send 开头匹配):目录持久化到会话 meta.extraDirs,projects.addDir 幂等同步项目组;运行中的会话重启 query(resume 保上下文)使 additionalDirectories 立即生效,回合进行中则标记 needRestart 回合结束后自动重启;目录不存在直接提示不发送。其余斜杠命令(/compact、自定义命令)由 CLI 本地命令通道处理(system/local_command_output),不受影响
- **更名 DeskTopUI**:productName/窗口标题/落地页/引导卡/快捷方式全部改为 DeskTopUI;appId 保持 com.claudeui.app 不变(userData 与自动更新身份不受影响)
- **用户消息贴右**:.msg.user 跳出 860px 居中内容列(margin-right:0),气泡贴聊天区右缘
- **模型身份**:输入框 placeholder 变为「给 <当前模型> 发送消息…」,助手气泡角色名由固定「Claude」改为当前会话模型(state.js modelLabel/sessionModelName);顶栏/输入框两处模型下拉切换、SDK init 回传模型时同步刷新;新媒体任务卡片角色名同步走 modelLabel

### v0.9.3(2026-08-06):辅助模型候选修复
- **辅助模型下拉不全**:Key 弹窗里图像/音频/视频/3D 辅助模型的候选原先只列 chat 类模型(Kuro 分组 model_type 过滤),勾选的 150 个模型里非 chat 的全部被隐藏。改为列出所有启用 Key 勾选的完整模型,非 chat 模型在选项里标注类别;选错类型导致分析失败时 aux-models 本就注入元信息兜底,不会断流

### v0.9.4(2026-08-06):移除首屏落地页
- 首次打开直接进入对话页:恢复最近活跃会话,一个都没有就自动创建独立会话(cwd=主目录,目录留空,用的时候再经「＋文件夹」或 ⋯菜单添加);未配置 API Key 时自动弹出 Key 配置窗(取代原三步引导卡)
- 移除 landing/onboarding/最近项目列表的 HTML、JS(initLanding/renderRecent/obMark 等)与对应 CSS;SDK 缺失警告条移到工作区顶栏下方

### v0.9.5(2026-08-06):新媒体模型 403「模型未配置」修复
- **根因**(网关实测定位):切到 Image/Video/Audio/Model 板块时,若该板块还没有会话,旧的 code 会话保持激活,而模型下拉已切换为媒体模型列表——此时在下拉里选模型会把媒体模型(如 gpt-image-2)绑到 code 会话上,发送走 SDK /v1/messages,网关对非 chat 模型一律 403「模型未配置:<model>」(媒体 create-* 端点本身全部正常)
- **修复**:setSection 切板块时先 await 重建模型下拉,板块无会话则自动新建对应 kind 的会话(不再滞留旧会话);两处模型下拉 onchange 加板块/会话一致性检查;sess:setModel 主进程防御(keys.modelType 查 modelGroups,非 chat 模型拒绝绑到 code/chat 会话);Session.start 自愈——code/chat 会话上残留的媒体模型自动清空回退默认
- 排查中实测确认:create-image/video/audio/create-3D 的字段名与鉴权全部正确;3D 板块 Hunyuan3D 基础款不支持 text_to_model(400),Hunyuan3D-3.0 正常

### v0.9.6(2026-08-06):控件会话级化 + 板块隔离 + 全产物可预览
- **顶栏瘦身**:模式/压缩/模型从顶栏移入输入区工具栏(会话级);模型下拉双份(顶栏+输入区)合并为输入区一份(model-sel),key-chip 同步合并;压缩/模式/推理深度标 sdk-only,新媒体板块自动隐藏;顶栏只留 视图/面板/⋯ 等全局控件
- **板块会话隔离加固**:setSection 重建下拉后按激活会话真实模型回显 updateTopbarForSession——修掉「image 会话的模型在切到 code 再切回来后显示/变成别的模型」(下拉重建落到回退项所致)
- **全产物可点开**:生成文件(图片/视频/音频/3D 等)统一带文件条,文件名可点击——文本类(md/js/json/…)进编辑器面板高亮预览,其余走系统默认程序打开(新 IPC shell:openPath,限制 aigc 产物目录);「打开所在文件夹」保留

### v0.9.7(2026-08-06):「设为项目文件夹」cwd 修复
- **根因**:proj:adoptDir 只改 projectId 不切 cwd,会话主工作目录停在用户主目录;叠加 ~/.claude/settings.local.json 残留的 permissions.additionalDirectories,无关路径出现在所有会话
- **修复**:adoptDir 同步切换 cwd(清冗余 extraDirs+重启 query);sessions.js addDir/start() 过滤与 cwd 相同的目录;input.js adopt 分支同步 meta.cwd/state.cwd;存量 store 3 个会话 cwd 已修正(留 .bak-cwdfix 备份);settings.local.json 残留项已删
- **已知代价**:改存量会话 cwd 会使 resume 报 No conversation found with session ID(记录按 cwd 分目录),App 自动开新会话接续;新会话不受影响
- npm test 75/75;安装包 dist/DeskTopUI Setup 0.9.7.exe 已构建

### v0.9.8(2026-08-06):会话操作右键化 + 消息右键复制/引用 + 图片查看模式
- **会话操作收进右键菜单**:侧栏会话项常驻的「重命名 / Side chat / 归档 / 删除」按钮行移除,改为右键菜单(state.js 新增通用 showCtxMenu,项目「打开文件夹」菜单同步迁移复用);删除标红、加分隔线
- **消息右键复制/引用**:新模块 msgmenu.js 在 #messages 上事件委托——文本消息右键「复制」(有选区复制选区,否则剔除工具进程组/任务卡片/思考块后复制整条正文)与「引用」(markdown 引用块填入输入框末尾并聚焦)
- **图片双击查看 + 右键复制**:用户附件缩略图(.msg-img)与生成产物图(.aigc-media)双击进入查看模式(#img-viewer 复用 modal-mask:Esc/点空白关闭,滚轮缩放,双击图面复位);右键菜单「查看图片 / 复制图片」,复制走 fetch→位图→PNG 写剪贴板(兼容 data: 与 aigc://,取代原仅缩略图的直接右键复制)

### v0.9.9(2026-08-06):用户消息导航条 + 右键编辑重生成/分支
- **消息锚点 uuid**:Session.send 为每条用户消息生成 uuid 打在 SDK 流式输入消息上并持久化进 echo(ui_user_input);user/assistant SDK 事件同步捕获 uuid;sess:send IPC 返回 uuid,renderer 回填到 live 回显元素;renderer eventKey 去重忽略 uuid 字段(防 live/历史双渲染)
- **用户消息导航条**:新模块 msgnav.js——聊天区右侧悬浮条列出每条用户消息摘要(_umsg 原始内容取文本,非 markdown 渲染残留),点击平滑滚动定位+闪烁,滚动联动高亮当前位置(参考线:视口顶部+120px);事件驱动重建(user-msg-added/history-replayed/session-activated,rAF 合帧防回放 O(n²));用户气泡右移 148px 为导航条让位
- **修改并重新生成**:用户消息右键 → 内联编辑(textarea,Enter 保存/Esc 取消)→ sess:editRegenerate:主进程 locateEcho 校验锚点后截断 UI 日志(writeSessionEvents 替换 echo 内容),stop 旧 query(setImmediate 等旧 _pump finally 跑完),fork 重启(resume+forkSession+resumeSessionAt=echo 前最近 assistant 锚点)再发送编辑后内容;非首条消息但无锚点(旧版本历史)直接报错,不静默丢上下文;附件块原样保留只替换文本
- **从此消息分支**:用户消息右键 → sess:branch:branchSlice 复制「目标 echo 回合结束」之前的事件进新会话(同 cwd/模型/Key/板块归属,标题加 · 分支),SDK fork 到该回合末尾锚点,新会话带完整上文继续;无 SDK 锚点时降级为仅复制可见历史并返回 warning
- **store**:新增 writeSessionEvents/locateEcho/branchSlice;test/session-edit.test.js 6 例(锚点偏好 assistant、退化 user、首条无锚点、切片到回合结束、整文件重写)
- npm test 81/81

### v0.9.10(2026-08-07):新项目首会话作废修复 + 流式渲染卡顿修复
- **「设为项目文件夹」后会话作废修复**:adoptDir 切 cwd 后 resume 在新 cwd 的 projects 目录找不到 <sdkSessionId>.jsonl,报 No conversation found 进程退出,且 sdkSessionId 残留导致之后每次 send 都失败、会话永久卡死。sessions.js 新增 encodeCwdForProjects(与 claude.exe 内 A0 编码一致:[^a-zA-Z0-9]→'-',超 200 字符截断+att 哈希 base36 后缀,从二进制提取验证)+migrateTranscript(resume 前把旧 cwd 目录的记录复制到新目录,留底不移动;登记的 prevCwd 找不到时兜底全盘扫描,覆盖连续两次 adopt);adoptDir 登记 meta.prevCwd(消费后清除);迁移后仍无记录则清 sdkSessionId 降级全新会话并提示,杜绝卡死。CLAUDE_PROJECTS_DIR 遵循 CLAUDE_CONFIG_DIR。test/transcript-migrate.test.js 6 例
- **流式执行卡死其他会话输入框修复**:chat.js appendText 此前对每个 text delta 把已累积全文 renderMarkdown 重渲一遍(O(n²)),所有会话共用渲染主线程,后台会话流式输出占满主线程导致输入框无法打字。改为 80ms 合帧渲染(scheduleAssistantRender),finalizeAssistant/content_block_start/handleAssistantMessage 文本块切换时 flushAssistantRender 冲销保证完整
- npm test 87/87

### v0.9.11(2026-08-07):Gem 自定义助手(全板块,编辑界面对齐 Gemini Gem)
- **数据模型**:store settings.gems 数组{name,desc,instructions(≤30000),tools,model,knowledge(≤10),knowledgeEnabled,preset};内置 4 个预置 Gem(编程伙伴/写作编辑/头脑风暴/学习辅导,preset:true 不可改删,可复制副本),首启播种幂等不覆盖用户数据
- **主进程 gems.js**:CRUD + composeAppend(SDK 会话 systemPrompt append:身份+说明+指令+工具偏好+知识文件,文本类 <200KB 内联前 2000 字符,总量截断 8000)+ composeMediaPrefix(媒体板块:指令截断 2000 拼用户 prompt 前);main.js 加 gems:list/save/delete/rewrite(✨AI 优化:一句话按官方「角色/任务/情境/形式」四要素扩写,复用 chat 模型单次调用)与 sess:setGem;aigc:send 在 meta.gemId 时注入前缀(回显/标题仍用原始 prompt)
- **sessions.js**:create 接 gemId(upsert 浅合并自动持久化);start() 把 gem append 与项目组 append 合并注入(有/无项目组均生效;gem 被删静默忽略);setGem 复用 needRestart 重启模式(busy 等回合结束,否则 stop+start resume 保上下文);媒体会话 create 分支也落 gemId
- **渲染端 gems.js**:三栏管理 modal(对齐 Gemini 编辑器)——左栏 Gem 列表(预置/我的)+新建;中栏表单(名称/说明/指令+✨AI 优化/默认工具多选 chips(制作图片·视频·音乐/Canvas/Deep Research/学习辅导)/知识文件(≤10,添加/移除)+「停用知识引用」);右栏预览(首字母头像+名称+说明实时联动+近期对话(该 gem 的会话,点击跳转)+「开始对话」按当前板块建会话绑定,gem 带默认模型且下拉未选时套用);composer 工具行 💎 选择器(选择/清除/管理);会话项 💎gem 名徽标;placeholder 显示「Gem名·模型名」;side chat 继承 gemId
- **注意坑**:smoke 测试须先 unset ELECTRON_RUN_AS_NODE(否则 electron 以纯 node 运行,electron-updater 因 app undefined 崩溃,与本功能无关)
- npm test 93/93(新增 test/gems.test.js 6 例)

### v0.9.12(2026-08-07):聊天代码块 IDE 化(复制按钮 + 按语言着色)
- **代码卡片**:marked 输出的 <pre><code> 统一由新模块 codeblock.js 的 enhanceCodeHtml 包装为「代码卡片」——头部条(左侧语言标签 + 右侧「复制」按钮)+ 代码区;复制原文转义存 data-code,navigator.clipboard 直写,#messages 事件委托(成功后按钮短暂变「已复制 ✓」)
- **按语言着色**:hljs.js 新增 highlightAs(code, lang)——按 fence 语言名调 highlight.js(vendor 包 30+ 语言,见 build/make-hljs.js);别名映射(py→python、sh→bash、ts→typescript、html→xml 等);语言未注册(如 ps1)退化 highlightAuto,再退化转义纯文本;主题沿用已加载的 github-dark.css
- **覆盖所有注入点**:chat.js 流式(scheduleAssistantRender/flushAssistantRender)、用户气泡(renderUserBubble)、计划卡片(plan-md);state.js 新增 PRE_CODE_RE/decodeCodeHtml 共享正则与解码
- **联动修复**:msgmenu.js 复制整条消息的 msgText 剔除 .code-card-head,避免「python 复制」混进正文
- npm test 97/97(新增 test/codeblock.test.js 4 例,window.hljs/document stub)
