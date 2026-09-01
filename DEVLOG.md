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
- **更名 DeskTopUI**:productName/窗口标题/落地页/引导卡/快捷方式全部改为 DeskTopUI;appId 保持 com.claudeui.app 不变(userData 与自动更新身份不受影响)(⚠ 已于 v0.9.34 品牌清理中改为 com.desktopui.app,旧安装目录需手动卸载一次)
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

### v0.9.13(2026-08-07):会话滚动吸附——上翻自由浏览,不再被流式渲染强制拉底
- **问题**:会话思考/编辑流式输出时,scheduleAssistantRender/appendThinking/工具卡片/结果行等都无条件 scrollBottom,用户拖滚动条或滚轮上翻会被持续拉回底部
- **修复**:chat.js 引入 stickToBottom 吸附态——#messages scroll 监听:距底 <80px 视为吸附,上翻即解除;scrollBottom 加 force 参数,仅吸附态(或 force)才吸底
- **force 场景**:用户发消息(addUserMessage,含 aigc 回显)/切换会话(setActiveSession)/历史回放完成
- **「↓ 回到底部」悬浮按钮**:非吸附态出现在消息区右下,点击平滑吸底并恢复吸附;切换会话时同步隐藏
- npm test 97/97

### v0.9.13(同日补充):Chat 会话 token 计数兜底 + 上下文 % 实时刷新
- **问题**:部分网关(如 Kimi)流式 message_delta 不带 usage,turnTokens 只依赖该事件,回合状态恒显示「0 tokens」;lastUsage 也只在 result 时更新,「上下文 %」回合中不推进
- **修复**:handleAssistantMessage 对 assistant 完整消息的 message.usage 兜底——流式已计过(msgDeltaCounted,message_stop 时记录)不重复计,否则按 output_tokens 补计 turnTokens;同步刷新 lastUsage 并发 usage-updated 事件,app.js 监听实时刷新「上下文 %」按钮
- npm test 97/97

### v0.9.13(同日补充 2):回合进度条 + 当前动作提示
- **进度条**:turn-status 行下新增整宽细条(.turn-progress),往复滑动指示(agentic 回合无真实百分比,用指示条表达「正在推进」),仅 busy 时随状态行显示
- **当前动作**:流式事件跟踪 s.ui.curAction——思考中/撰写回复/调用工具 Xxx/子任务 Xxx(完成即清除),合入状态行文本尾部;新回合(ui_status busy)重置
- npm test 97/97

### v0.9.13(同日补充 3):预测式进度条
- **模型**:把往复滑动指示条改为时间双曲线预测——predictedPct = 92·t/(t+25000)(25 秒 ~46%、100 秒 ~74%),渐近逼近 92% 永不到 100,避免「卡在 100% 等结束」的误导;.turn-progress-bar 改 width 驱动 + transition 平滑
- **补满反馈**:result 时进度补满 100% 停留 350ms 再隐藏状态行(setTimeout 内 busy 重入则不隐藏,防多回合闪烁);新回合 resetTurnProgress 归零
- **量化显示**:状态行文本尾部加 `· ~N%`(每秒刷新)
- npm test 97/97

### v0.9.13(同日补充 4):回合结束系统通知
- **每次回合结束都发 Windows toast**(此前仅非活跃会话):onTurnDone 去掉 activeId 限制,标题区分正常「任务完成」/出错「任务结束(出错)」,正文带用时(3m 21s 的回合 → "…的回合已结束,用时 201.0s");非活跃会话仍额外打点 sess:attention
- 走 Electron Notification(isSupported 守卫,silent 失败),与权限请求通知共用 notify()
- npm test 97/97

### v0.9.13(同日补充 5):系统托盘驻留——关窗转后台,右键托盘退出
- **关窗不再退出**:mainWindow close 拦截(非 darwin、非 isQuitting)→ hide();首次最小化弹一次系统通知「正在后台运行,右键托盘图标可退出」
- **托盘**:build/icon.png 缩放到 16px 建 Tray;左键单击唤出;右键菜单「显示 DeskTopUI / 退出」;退出走 app.isQuitting=true + cleanup()(幂等:stopAll/closeAll/scheduler.stop)+ app.quit()
- **配套**:updater.installAndRestart 先置 app.isQuitting(否则关窗拦截挡住自动更新重启);before-quit 统一置 isQuitting+cleanup 覆盖所有退出路径;second-instance 改为 showMainWindow(应用在托盘隐藏时二次启动能唤出);build/icon.png 加入打包 files
- npm test 97/97

### v0.9.14(2026-08-10):消息导航条 Dock 式悬停放大
- **效果**:鼠标在右侧消息缩略导航上滑动时,光标所在项放大最多(1.35x),邻近项按垂直距离二次衰减(影响半径 80px),右缘为原点向左扩(利用聊天区空间);离开列表全部复位
- **启用条件**:仅导航内容无需滚动时(rebuild 时测量,挂 .mag class);可滚动时 transform 放大必被 overflow 裁切/出横向滚动条(CSS 规则限制),退回普通 hover 高亮
- 监听挂在 .msg-nav-list 容器上,rebuild 重建子项不影响
- **点击定位改为瞬时跳转**:scrollIntoView 去掉 smooth 动画,长会话不再慢速滚动晃眼
- npm test 97/97

### v0.9.15(2026-08-10):瞬时跳转设置项
- **右上角 ⋯ 菜单新增「⚡ 瞬时跳转定位」勾选**(默认开,保持 v0.9.14 行为):作用于消息导航点击定位与「回到底部」按钮;关闭则恢复平滑滚动
- state.instantJump(boot 时 api.getStore 读 settings.instantJump);菜单每次打开刷新 ✓ 勾选态;切换即 api.setSetting 持久化
- npm test 97/97

### v0.9.16(2026-08-10):消息导航收进消息区 + 横杠默认形态/悬停按距离展开
- **不再覆盖输入区**:#msg-nav 收进新增的 .messages-wrap(flex:1,只包裹 #messages),从「整个聊天列绝对定位」改为只覆盖会话显示区,底部不再压到消息发送栏
- **默认形态 = 一条条小横杠**(类 GPT):26×4px、字号 0;悬停时由 JS 按光标垂直距离二次衰减展开——光标所在项展开到 190×22px 显示完整摘要,越远离光标越小,直到退回横杠(行内 width/height/font-size + CSS transition 驱动)
- 内容溢出可滚动时 mag 关闭(展开会被 overflow 裁切),退回 CSS :hover 整项展开回退
- npm test 97/97

### v0.9.17(2026-08-10,未发布):代码卡片头部条 sticky——长代码块复制按钮跟随可视区
- **痛点**:长代码块滚到中部想复制,得拉回块顶才能点到头部条的复制按钮
- **实现**:.code-card-head 改 position:sticky;top:0(滚动容器 #messages),滚过长代码块时头部条(语言标签+复制按钮)吸附在可视区顶部,滚出卡片自动归位
- **关键障碍**:.code-card 的 overflow:hidden 会让卡片成为滚动容器从而破坏 sticky——去掉;圆角改由头部条(border-radius:7px 7px 0 0)与卡片自身背景承担;头部条背景改不透底实色 #1e1c19,吸顶时下方代码不穿透
- 纯 CSS 改动,sticky 链路(.bubble/.msg → #messages)无其他 overflow 裁剪
- npm test 97/97

### v0.9.17(同日):数据迁移/自愈框架——更新后旧会话统一迭代修复
- **痛点**:每次版本更新后旧会话总会出些问题(resume 卡死、脏数据残留),且都要等用户点开会话才 lazy 兜底,没点到的会话一直是坏的
- **框架**(src/main/migrations.js,main.js whenReady 最先执行):
  - **repairs(每次启动幂等自愈)**:①transcript 健康扫描——记录不在当前 cwd 目录就 migrateTranscript 迁移(全盘兜底),全盘皆无则清 sdkSessionId 降级全新会话并记 resumeLostAt(echo 日志仍回放界面历史,会话不再卡死);②prevCwd 与 cwd 相同的残留清理;③会话 meta 按 id 去重
  - **migrations(按版本一次性数据改写)**:游标存 settings.dataVersion,版本戳只前进不后退;单个迁移失败不影响其他;今后破坏性数据格式变更必须登记一条(模板在文件头注释)
- **铁律:只修不删**——不删会话/事件日志/transcript;修不好就降级
- 修复报告写 userData/logs/migrations.log(有实际修复才写)
- test/migrations.test.js 7 例,npm test 104/104

### v0.9.18(2026-08-10):消息导航悬停展开改「槽位+transform」——修上下缩放不平均
- **问题**:v0.9.16 的悬停展开直接改行内 width/height(布局尺寸),项一膨胀就把下面的项往下推、上面的不动,上下衰减不对称;且项位置随 transition 每帧变化,距离重算产生反馈抖动
- **方案(Dock 式正解)**:每项包一层 .msg-nav-slot 槽位(布局尺寸恒定 26×4),按钮全尺寸(190×22)绝对定位于槽内,默认 transform: scale(0.137, 0.182) 缩成横杠;悬停只改 transform/opacity,**不触发列表重排**——距离按槽位中心测量(悬停期间槽位不动),上下衰减严格对称
- 展开项按 k 设 zIndex(大的压小的);可滚动回退改 scale(0.674,1)(宽度收进 132px 列表内)
- npm test 104/104

### v0.9.19(2026-08-10):消息导航居中 + 边缘淡出省略 + 悬停项对比强化
- **垂直居中**:.msg-nav align-items 改 center,横杠列表默认居于消息区垂直中部(原为顶部堆叠)
- **边缘淡出省略**:消息多到装不下时(非 mag、可滚动),列表上下 28px 用 mask-image 线性淡出,表示两侧还有省略内容;装得下(mag)时无淡出
- **悬停项对比强化**:衰减指数从 2 提到 3(k 再取 1.5 次方)+ 影响半径 90→70,两侧项更快退回横杠;中心项最大放大 1.15x 并打 .hot 高亮(主题色描边+底色+文字实色);远处项透明度压到 0.35 衬托;可滚动回退的 hover 态同步加高亮配色
- npm test 104/104

### v0.9.20(2026-08-10):消息导航间距加大防误触
- 槽位间距 gap 6→10px、横杠厚度 4→6px,pitch 从 10px 提到 16px,悬停/点击不再挤在一起误触
- 缩放系数同步:CSS 默认 scale(0.137, 0.273) / JS SY0=6/22
- npm test 104/104

### v0.9.21(2026-08-10):导航溢出态改居中小窗 + 悬停位置代理滚动
- **不再占满整条**:列表 max-height 100%→34%(约会话区 1/3),配合 v0.9.19 的 align-items:center 居中于右侧
- **悬停位置 = 总列表相应位置**:非 mag(装不下)时 mousemove 按光标在小窗内的纵向比例直接代理 scrollTop(scrollTop = ratio·(scrollHeight-clientHeight),数学上光标所指恰为整体同一比例处),滚动条隐藏(scrollbar-width:none),上下淡出保留表示省略;滚轮滚动仍可用
- mag(装得下)时维持 Dock 放大不变
- npm test 104/104

### v0.9.23(2026-08-10):回撤 v0.9.22 + 边界淡出分侧优化
- **回撤 v0.9.22**(git revert 9f49735):整条 rail 悬停区 + 小窗跟随光标方案回滚,恢复 v0.9.21 的「居中小窗 + 窗内比例代理滚动」
- **边界淡出分侧**:非 mag 时按 scrollTop 维护 at-top/at-bottom class——滚动未探到的一侧保持淡出,探到顶/底即去除该侧淡出(此前上下两侧恒定淡出,探到底了还淡出不合理);scroll 监听驱动,代理滚动/滚轮都覆盖
- npm test 104/104

### v0.9.24(2026-08-10):导航窗口边缘整项吸附(修「依旧没有显示完全」)
- **根因**:v0.9.23 回撤 v0.9.22 时把 scrollTop 整项吸附一并回掉,代理滚动回到连续值,窗口上下边缘的项被拦腰截断只显示半条
- **修复**:代理滚动按项距 16px(槽位 6+间距 10)取整吸附,边缘项要么完整显示要么完整隐入淡出区;分侧边界淡出(v0.9.23)不受影响
- npm test 104/104

### v0.9.25(2026-08-10):导航禁滚轮 + 回到底部按钮移位 + macOS Dock 式边缘感应
- **滚轮禁用**:list 的 wheel 事件 preventDefault({passive:false}),导航栏只吃悬停代理滚动,不再被滚轮误滚
- **回到底部按钮移位**:从 chat-col(bottom:150px)移进 messages-wrap,钉在消息区右下角(right:12 bottom:10,导航栏尾端之下);z-index 50 压过 rail(40)保证可点
- **macOS Dock 式边缘感应**:mousemove/mouseleave 提升到整条 rail(pointer-events:auto);mag 态光标 Y 先钳到首/末槽位中心之间——光标在导航上缘之上时最上面一条按「光标在其中心」拿满放大(1.15x+.hot),越过下缘同理(复刻 Dock 光标越过端点图标端点保持满倍);非 mag 态光标超出小窗上/下缘时 ratio 钳 0/1 直接探到顶/底
- npm test 104/104

### v0.9.26(2026-08-10):Gem 菜单下方空间不足时向上展开(修被窗口底边裁切)
- **问题**:Gem 选择器在输入区工具条(窗口底部),showMenu 固定 top=锚点.bottom+6 向下展开,窗口较矮时菜单被窗口底边裁掉
- **修复**:先渲染量高,下方空间 ≥ 菜单高才向下;否则向上展开(top=锚点.top−6−高,钳 ≥8),并按锚点上方可用空间收 max-height(≥120),顶部也不越界;共享 showMenu 的「默认工具」菜单同享此逻辑
- npm test 104/104

### v0.9.27(2026-08-10):文本附件改路径引用——UI 只显示文件卡片,内容 AI 自行 Read
- **痛点**:文本附件此前把全文内联进消息(`<附件 name>全文</附件>`,50KB 截断),大文件把会话 UI 撑得很长
- **发送侧**(input.js):文本附件只登记 `{name, path}`——＋附件按钮/拖拽有磁盘路径直接用;粘贴内容无路径则落盘 userData/attachments/(新 IPC files:savePasted)再引用;二进制检测改 4KB 采样(files.sampleFile,新 IPC files:sample),不再读全文;发送时内联 `<附件 name path>请用 Read 工具读取</附件>` 引用块
- **渲染侧**(chat.js renderUserBubble):ATTACH_BLOCK_RE 把附件块(含旧版内联全文的历史消息)折叠成 📄 文件卡片(.file-attach-chip,悬停显示路径)——旧会话的大附件消息同样不再占篇幅
- npm test 104/104

### v0.9.28(2026-08-10):附件不限大小 + 双击附件卡片打开编辑器查看
- **不限大小**:图片附件去掉 5MB 上限(readImageBase64);文本附件 v0.9.27 起本就只按路径引用无上限
- **双击查看**:消息气泡里的 📄 附件卡片(data-path)双击 → emit('open-file') 打开右侧编辑器面板(msgmenu.js dblclick 委托,复用图片双击同一监听);输入框待发区的文件/媒体 chip 同样支持双击打开;无路径的旧消息卡片不可点
- 编辑器读取上限 2MB→20MB(files.readFile),大附件双击能打开
- npm test 104/104

### v0.9.29(2026-08-10):彻底修「附件被截断/乱码」严重 BUG
- **根因 1(AI 侧截断)**:附件引用块只让 AI「去 Read」,而 Read 默认每次只返回前 2000 行——长文件 AI 读个开头就回答,用户感知即「附件被截断」。引用块改为显式指令:必须用 offset/limit 分段读完整个文件,禁止只读开头
- **根因 2(编辑器截断)**:files.readFile 仍有 20MB 上限 → 双击附件卡片看大文件被拒。上限彻底移除(用户明确:不管多长禁止截断)
- **根因 3(乱码/误判)**:采样与编辑器读取按 UTF-8 硬解,GBK/ANSI 编码的代码文件(中文 Windows 常见)解出 � → 被判二进制拒收、打开乱码;粘贴流 UTF-16 也乱码。新增 files.decodeBuffer:BOM(UTF-8/16LE/16BE)→ 严格 UTF-8 → GBK 兜底;sampleFile/readFile 与粘贴流全部接入
- **粘贴落盘补二进制校验**:savePastedAttachment 落盘前按 �/NUL/控制字符比例拒收真实二进制(此前校验在被删的 renderer 分支里丢失)
- test/file-decode.test.js 5 例(UTF-8/BOM/GBK/UTF-16LE/二进制),npm test 109/109

### v0.9.30(2026-08-10,严重 BUG):打断后再编辑重生成会话卡死修复
- **根因**:「停止」已对 query interrupt 过一次;「修改并重新生成」的 editRegenerate 里 `await this.interrupt()` 对同一 query 发起**第二次 interrupt**——SDK 的 interrupt 要等当前回合响应,第二次没有可打断的回合,承诺**永不 resolve**,sessEditRegenerate 永不返回,气泡停在「⏳ 重新生成中…」,会话卡死
- **修复(sessions.js 三处)**:
  ①interrupt() 幂等化——`_interrupting` 复用在途承诺 + Promise.race 6s 超时兜底,落地时校验 `this.q === 发起时的 q` 才清 busy(旧 interrupt 落地不得覆盖新 query 的回合并);
  ②editRegenerate 的 stop→重启间等待从 setImmediate 改为按「this.q 已换/running 已落」轮询(30ms×100 上限 3s)——旧泵的 for-await 要等 claude 子进程退出才跑 finally,一个任务间隙不够;
  ③_pump finally 校验 `this.q === 本泵的 q` 才写 running/busy 状态(stop+新 query 已启动时旧泵不得再清状态;旧权限卡照常了结);stop() 同时解除在途 _interrupting
- npm test 109/109

### v0.9.31(2026-08-11):皮肤定制 + 独立设置面板 + 活跃项对比修复
- **活跃会话项对比修复**:.session-item.active 从 bg-input+border(与非活跃项几乎无差)改 accent 洗底+描边;同时发现 **--accent-bg/--bg-hover 被 msg-nav/.hot 等多处引用但从未在 :root 定义**(一直是无效值),已在 :root 补齐
- **皮肤系统**(新模块 themes.js):主题=一组 CSS 变量覆盖集——深色(默认)/浅色/暗夜蓝/墨绿护眼 4 套,applyTheme 写 documentElement 内联变量(暗色=移除覆盖回落样式表),settings.theme 持久化,boot 时最先应用避免首帧闪错主题;代码卡片/hljs 硬编码深色各主题下统一保持
- **独立设置面板**(settings-modal):原「⋯」下拉菜单全部入口并入——外观(皮肤卡片点击即时预览+持久化)/功能(Gem 助手/API Key/MCP 服务器/定时任务/权限规则/快捷键)/偏好(⚡ 瞬时跳转定位 checkbox)/其他(打开目录/打开日志目录);「⋯」按钮改为设置面板直入口,删除 more-menu 下拉及其 handlers,瞬时跳转从菜单勾选态改为 checkbox
- npm test 109/109

### v0.9.35(2026-08-12):更名 Drafter + ClaudeUI 品牌全面出清
- **更名 Drafter**:productName/窗口标题/托盘/快捷方式/legalTrademarks/appId(com.drafter.app)全部改为 Drafter;包名 desktopui→drafter(中间品牌 DeskTopUI 未发版即被本轮取代)
- **userData 自动迁移**:productName 变更使 userData 变为 %AppData%\Drafter,main.js 启动时新目录不存在则从 DeskTopUI/desktopui/claude-ui 旧目录整体复制(只复制不删,缓存目录不搬);CLAUDE_/DESKTOPUI_USERDATA 环境变量兼容保留
- **产出物署名出清**:项目组注入改 <drafter-project-group>+「Drafter 的项目组」、共享记忆目录新建用 .drafter(存量 .desktopui/.claude-ui 只读识别)、Gem 注入改 <drafter-gem>、worktree 改 .drafter-worktrees+drafter/ 分支前缀——用本 App 产出的代码/插件不再带 ClaudeUI 痕迹
- **Logo 重设计**:make-icon.js 由像素字母改为「层叠草稿纸」图形(呼应 Drafter=起草者),重生成 icon.png/icon.ico
- **appId 变更代价**:旧版自动更新装新版时旧安装目录(Programs\claude-ui / DeskTopUI)不被接管,需手动卸载一次(数据已自动迁移)
- 顺手修复:package.json copyright GBK 坏字(漏→©)、package-lock 过期 name/version
- npm test 120/120

### v0.9.36(2026-08-12):系统通知可点击跳转到对应会话
- sessions.js notify 加 onClick 参数(Notification 持引用进 Set 防 GC 吞 click 监听,close 释放)+ jumpToSession(restore/show/focus 主窗口 + 发 sess:activate);onTurnDone 与 notifyPermission 都接上点击;preload api.on 白名单加 sess:activate;app.js 监听后 ensureSession(sessList 取 meta 兜底)+setActiveSession+refreshList,跨板块会话由 session-activated 自动切板块
- npm test 120/120

### v0.9.37(2026-08-12):权限确认全板块弹 toast + 权限模式热切换
- **权限确认全板块弹系统通知**:notifyPermission 去掉 activeId 门控,任何板块/活跃会话/窗口最小化都弹右下角通知(权限是阻塞等待需强提醒),点击跳转到该会话(v0.9.36 链路);非活跃仍额外打点
- **权限模式热切换**:①setPermissionMode 先把挂起的权限卡按新模式即时裁决(bypass/acceptEdits→allow 编辑类,dontAsk→deny,卡片同步消失);②SDK 控制请求 set_permission_mode 照发(失败不再静默吞,记日志);③_onPermission 按最新 meta.permissionMode 本地兜底——bypassPermissions 全放行、acceptEdits 放行编辑类、dontAsk 拒绝未预批准(顺序在 autoAllowTools 之后,尊重会话级 always);EDIT_TOOLS 提为模块常量,只读硬拦截保持最前(bypass 也拦)
- npm test 120/120

### v0.9.38(2026-08-19):image/video/audio/model 四大媒体板块合并为「创作」
- **彻底合并**(按 AI创作平台规划 md「工具集」单入口定位):会话 kind 统一为 'media'(migrations 版本化迁移 image/video/audio/model→media 并盖 board 戳,代码全面兼容旧 kind),**生成类型不再随会话 kind,改由所选模型的 model_type 决定**——同一会话可先生成图片再把产物当参考图生成视频,为 md 跨模态链路打底
- **顶栏 4 按钮→「创作」单按钮**,侧栏加工坊筛选 chips(全部/图片/视频/音频/3D,按 boardOf 过滤,新建会话按工坊预选首模型);模型下拉按全部四类媒体模型列出,optgroup 按「Key · 类型」分组
- **meta.board 戳三级兜底**:modelGroups→board 戳(迁移/建会话/换模型时盖)→旧 kind;新增 repairMediaBoard 每次启动自愈(分组被刷新失败清空后仍可按戳建单,消除旧版按 kind 建单可用的回归缺口)
- body 挂 board-<type> class 跟随会话当前模型(附件按钮仅 image/video 类型显示);任务卡片产物改按文件扩展名渲染 img/video/audio/文件卡(跨类型会话并存);aigc:send 改主进程 resolveBoard 定建单端点(类型不可解析时拦截提示重选)
- npm test 124/124(新增 resolveBoard/归一迁移/repairMediaBoard 用例)

### v0.10.0(2026-08-19):无限画布 v1 + 素材库(AI 创作平台 MVP 两大核心模块)
- **无限画布**(新板块「画布」,引擎 Drawflow 0.0.60/MIT——调研对比 litegraph.js(ComfyUI 同款)后选定:DOM 节点原生放 video/audio 播放器):
  - 6 种节点(对齐 md 1.1 MVP 子集):文本(prompt 源)/参考图上传/图片·视频·音频·3D 生成
  - 连线类型校验(ComfyUI 式类型槽):text→prompt 槽(连入接管 prompt,只读展示+实时同步),image→参考图/首帧槽
  - **多模型 fan-out**(md 1.2):节点内模型多选 chips,每模型独立 aigc:exec 任务,结果并排翻页,「采用」版本供下游节点取用
  - **节点生成历史**(md 1.2):每节点 tasks 全量留存翻页;画布 JSON 即历史,防抖自动保存 userData/canvases/<id>.json
  - 执行任务后切走/关窗不丢:主进程 patchTask 终态补丁写回画布 JSON
  - 侧栏画布列表(新建/行内 input 重命名/删除);aigc:exec 非会话执行(refFiles 限 AIGC/画布 assets 目录防任意读取)
- **素材库**(新板块「素材」,md 模块四雏形):创作会话+画布节点双源聚合网格(existsSync 剔除,时间倒序),类型 chips+搜索,**「用作参考图」一键塞回创作会话附件并跳转——md 图→视频跨模态主链路闭环**
- 板块框架扩展:SECTIONS 五板块,非会话板块(canvas/assets)跳过会话挑选流程;素材板块全宽;画布板块侧栏=画布列表
- 验证:npm test 129/129(canvases.test.js 5 例);CDP 冒烟(electron --remote-debugging-port + Node 内置 WebSocket).claude-ui/smoke-canvas.js 14/14 步;真实 Key 数据复验(29 模型 chips/真实产物网格/零渲染错误)

### v0.10.1(2026-08-19):画布 MVP 收尾——文本生成节点 + 画布模板 + fork 导入导出
- **文本生成节点(md 1.1 文本生成,接入多家 LLM)**:画布新增「文本生成」节点——prompt(可被上游文本节点接管)+ chat 模型多选 fan-out,走 /v1/chat/completions(新主进程模块 llmtext.js,鉴权/URL 归一与 aigc 同套),结果版本翻页+「采用」,采用版本文本即下游 prompt(prompt 槽文本源从纯文本节点扩展到文本生成节点)
- **画布模板(md 1.2)**:工具栏「▦ 模板」菜单——当前画布存为模板(主进程 sanitize 剥离任务历史/上传文件),从模板一键新建画布;首次进入播种两个预置(文生图→图生视频 / LLM 提示词→图片生成);模板存 userData/canvases/templates/
- **画布 fork/导入导出(md 1.2 只读分享与「复制项目」)**:导出当前画布副本为 .drafter-canvas.json(剥离任务历史,布局+模型/提示词配置随文件走);导入严格校验结构(非本应用导出拒绝)后以「(副本)」后缀新建画布
- npm test 136/136(新增 llmtext.test.js 5 例、canvases 模板/导出用例 2 例);CDP 冒烟 17/17(llmtext 节点/模板菜单/从模板建画布 3 节点 2 连线)



### v0.12.5(2026-09-01):画布 ComfyUI 交互对齐——修复节点创建不可见
- **修复节点点击创建后在画布不可见的严重 bug**:①addExternalNodeAt 缺 outCount 定义导致点击抛错;②`.cv-workspace` 缺 flex 规则导致画布区宽度为 0,节点只在小地图出现;③新增节点改为落在当前可视区中心(canvasViewCenter 考虑 Drawflow 平移/缩放变换)。
- **画布交互对齐 ComfyUI**:滚轮直接缩放(原生要求 Ctrl,已接管)、中键拖动平移、左键空白框选、F 键居中(有选中节点居中该节点,无则 fit 全部)、Delete 删除选中节点(修复 removeNodeId 需 node-X 前缀的格式错配)、右键 ComfyUI 风格菜单(Pin/Clone/复制/粘贴/固定/绕过/最小化/节点信息/颜色/Remove)、选中节点悬浮工具栏(删除/信息/形状/绕过/最小化/复制/更多+9 色颜色条)、连线点击悬浮菜单(Add Node/Add Reroute/Delete,reroute 已启用)。
- **布局**:左侧图标轨道(资产/节点/模型/工作流/应用/模板)、图形/应用切换、棋盘格画布背景、顶部画布标签页(多画布标签切换/关闭);模板独立弹窗——我的模板(自存)+ 本机 ComfyUI 官方预设(comfyui_workflow_templates_json 533 个模板按前缀分类,点击即导入为新画布)。
- **节点绘制对齐 ComfyUI**:端口点改到节点两侧竖排(左蓝输入/右绿输出,带端口名),深色圆角色卡;检查器参数不再泄漏 comfy* 内部字段;escapeHtml 全局容错非字符串输入。
- 冒烟(CDP,真实本机 ComfyUI 0.34.0):添加节点可见/中键平移/滚轮缩放/F 居中/框选/右键菜单/悬浮工具栏/Delete/模板预设加载全过,零渲染错误;npm test 190/190。坑:Electron 冒烟实例不随文件改动自动刷新,陈旧实例占调试端口会导致误判——每次验证必须用专用端口+新实例。

### v0.12.3(2026-09-01):原生 ComfyUI Canvas——900 节点库与本地工作流界面
- **原生节点浏览器**:画布左侧直接加载本机 ComfyUI `/object_info`,显示 900 个节点、201 个分类,支持分类树、搜索、刷新与收藏,不再嵌入官方网页,也不再受旧的 120 项菜单限制。
- **原生三栏工作流界面**:中间为全尺寸本地无限画布,右侧为 ComfyUI 风格检查器(参数/信息/设置);节点支持分类颜色、颜色标记、正常/忽略/禁用状态,禁用/忽略会真实影响原生 DAG 调度。
- **节点编辑能力**:多输出端口、复杂 Schema 控件(数值范围、多行文本、静态/动态/增长型 COMBO、tooltip、空模型目录提示)、动态输入、右键复制/重复/删除、Ctrl+Z/Y 撤销重做和右下角小地图。
- **API Key + 本机 ComfyUI**:默认继续使用 API Key 模型;本机 ComfyUI 作为高级本地后端,文本/已落地图片可通过标准资产桥接进入 ComfyUI 子图,产物继续进入 Drafter 素材库。私有 LATENT/MODEL/CONDITIONING 等推理对象不会跨后端伪装成可序列化资产。
- 本机验证:ComfyUI 0.34.0 + CUDA 12.6 在 RTX 5060 Ti 16GB 上运行;`npm test` 185/185;原生 Electron 冒烟验证 201 分类、CLIP Text Encode 节点添加、多行参数、检查器与小地图。真实出图需在 `D:\ComfyUI-cu126\ComfyUI_windows_portable\ComfyUI\models` 放置模型文件。


- **ComfyUI 连接管理**:画布工具栏新增「⚙ ComfyUI」，可配置本机/LAN/云端/反向代理地址与 Bearer、API Key 或自定义头认证；连接条目脱敏，远程 HTTP 与不受信任 TLS 必须显式确认。
- **节点目录与工作流互通**:读取 `/object_info` 并安全清洗后驱动外部节点选择/基础 widget 编辑；支持 ComfyUI prompt/workflow JSON 导入导出，原始 `class_type`、连接与布局保留。
- **远程运行闭环**:纯 ComfyUI 画布通过 `/prompt` 提交，WebSocket 和 `/history` 回传队列进度；`/view` 产物安全落入本地素材目录，复用既有画廊与素材库。跨后端或跨连接混合图会明确拒绝，避免错误传递张量。
- **可靠性**:修复 API 格式画布重开时 Drawflow 节点空壳；恢复会话遇到损坏 JSONL 或 provider `message.uuid` 恢复错误时，清理 SDK 锚点并保留本地历史。
- 验证:npm test 179/179；隔离 Electron/CDP 冒烟 6/6；`electron-builder --dir` 与 asar 包含检查通过。真实 ComfyUI 服务的模型提交待用户配置可用服务后验证。


- **画布持久化格式换 ComfyUI API 格式**(通读 Comfy-Org/ComfyUI master 源码后对齐):{nodeId:{class_type,inputs:{...}}} 平铺对象,与 ComfyUI 工作流 JSON 天然互通;存量画布 migrations 0.12.0 一次性转换(原文件留 .bak,真实数据已验证);渲染端加载时主进程 toDrawflow 重建 Drawflow 编辑器
- **整图运行**(对齐 execution.py PromptQueue + comfy_execution/graph.py ExecutionList):工具栏「▶ 运行」——提交前校验(validate:缺 prompt/循环依赖带 A→B→A 可读路径/不支持节点类型)→ 拓扑就绪集推进,上游完成才跑下游;**单点失败不炸整图**(失败节点下游 skipped,其他分支照常);新主进程模块 canvasJobs.js(Job 五态 + outputs 归属 + 每画布 20 job 容量挤出)
- **增量缓存**(对齐 caching.py CacheKeySetInputSignature):节点缓存键=递归祖先签名(link 输入记祖先序位而非 id——祖先等价重写不破坏缓存;tasks/results/active/view 等版本字段剔除);签名一致且有完成产物 → 整图运行时跳过远程调用直接复用产物,改上游只重跑变更子树
- **节点状态环**(ComfyUI 标志性交互):节点边框色随 job 状态流转(黄=执行中/绿=完成/蓝=缓存命中/红=失败/紫=跳过);校验失败节点红框+行内错误提示
- **双击画布空白搜索加节点**(litegraph 惯例:模糊匹配,Enter 选第一个)
- 新主进程模块 canvasGraph.js(纯逻辑:fromDrawflow/toDrawflow/validate/nodeSignature/topoOrder/executionTargets);测试 163/163(canvas-graph 5 例 + canvas-jobs 5 例);CDP 冒烟 20/20(整图运行校验拦截+搜索加节点)
- 坑:①prompt 槽是「必需槽」,空槽不落 null 占位(可选 ref 槽才占位)——否则连线类型语义被空槽吃掉;②连线判断必须区分 [id,socket] 与 models:['k|m'] 值数组(isLink);③prompt 解析沿 prompt 槽递归向上(生成节点也可作上游文本源)

> 版本注:v0.12.0 的 tag 与 GitHub Release 被并行会话用于 Harness 修复(be722d49),画布升级的实际发布版本号是 **v0.12.1**(内容同上)。
