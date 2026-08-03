# Claude UI 回归失败与问题记录

来源:B1–B29 人工回归陪跑(2026-07-31,v0.4.0 起)。按发现顺序记录,修复后标注状态。

## F-001 打包版会话完全不可用(claude.exe 无法从 asar 启动)【严重 · 未修】

- **发现**:2026-07-31,所有者运行 v0.4.0 安装版(安装到 D:\CU)发起会话时报错:
  `Claude Code native binary at ...\resources\app.asar\node_modules\@anthropic-ai\claude-agent-sdk\...\claude.exe exists but failed to launch`
- **根因**:SDK 原生二进制经 electron-builder asarUnpack 解包到了 `app.asar.unpacked`,但 SDK 内部解析的 `pathToClaudeCodeExecutable` 仍是 `app.asar` 内路径;`fs.exists` 被 Electron 重定向所以检查通过,但 OS 无法从 asar 归档内 spawn 可执行文件。开发版(npm start)无此问题。
- **影响**:v0.4.0 安装包的核心会话功能完全不可用,**阻断 GitHub Release 发布**。
- **建议修法**:sessions.js 构建 query options 时显式传 `pathToClaudeCodeExecutable`,路径取 SDK win32-x64 包的 claude.exe 并把 `app.asar` 替换为 `app.asar.unpacked`(仅打包环境生效);修复后重跑 `npm run dist` 验证安装版能发起会话。
- **状态**:**已修复(v0.4.2,2026-08-03)**:sessions.js 新增 `resolveClaudeExe()`,多布局兜底(hoisted/嵌套/resourcesPath)解析 claude.exe 并把 `app.asar` 替换为 `app.asar.unpacked`,显式传给 `options.pathToClaudeCodeExecutable`;test/sessions-bin.test.js 覆盖解析有效性;dist 重打包验证见 DEVLOG v0.4.2 记录。

## F-004 后台会话历史重放被永久跳过【高 · 未修】

- **发现**:2026-08-03,B3 自动化回归:应用重启后,未被 landing 恢复的会话(REG-B1)收到新事件,点击切换后只见新事件,重启前全部历史不渲染。
- **根因**:`src/renderer/chat.js` handleSessEvent 第 488 行——`if (!s.ui.replayed) s.ui.replayed = true`,live 事件到达即把"已重放"置真(意图是防重复渲染);之后 setActiveSession 的 `if (!s.ui.replayed) replayHistory(sid)` 永远不再触发,历史永久隐身。影响场景:cron 触发的会话、通知后点开的后台会话、任何"先收事件后点开"的会话。
- **验证旁证**:landing 恢复的最近会话(REG-B4)重放完整 ✓;重启后 SDK resume 上下文保留(模型记得 edit-me.txt)✓ —— 仅渲染层历史加载被跳过。
- **建议修法**:live 事件到达且未重放时,先触发 replayHistory 再渲染(需处理"刚持久化的事件同时出现在 JSONL 里"的去重);非一行级改动,需要专门设计。
- **状态**:**已修复(v0.4.9,2026-08-03)**:handleSessEvent 不再把 live 事件到达当作"已重放";首个 live 事件先触发 replayHistory,live 事件进缓冲区,历史渲染后按 eventKey(JSON 序列化)去重补渲染。B3 复测通过:重启后非恢复会话先收事件,点开后 TURN1 历史完整可见、TURN2 无重复渲染。

## F-005 终端无法启动:Windows shell 硬编码 powershell.exe 无回退【中 · 已修】

- **发现**:2026-08-03,B23 自动化回归:点「＋终端」无标签创建,api.termOpen 返回 `{ok:false, error:"File not found: "}`。
- **根因**:`src/main/terminal.js` 在 win32 固定 `pty.spawn('powershell.exe', …)`;本机 PATH 无 powershell.exe(企业受限机,Git Bash 亦 not found,需全路径 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`)。实测:`cmd.exe` 在 conpty 与 winpty 后端下均正常 spawn —— 即 node-pty 与二进制完好,仅 shell 路径写死且无回退。
- **影响**:无 powershell.exe 的 Windows 机器上内嵌终端完全不可用(B23);有 powershell 的机器不受影响。
- **建议修法**:spawn 失败时回退链 `powershell.exe → cmd.exe`(或启动前 which 探测);报错文案带上 shell 名。
- **状态**:**已修复(v0.4.9,2026-08-03)**:terminal.js 实现 shell 回退链(powershell.exe → cmd.exe),报错文案含 shell 名与全部候选。B23 复测通过:＋终端正常建标签(经 cmd.exe 回退)、多标签切换/关闭正常、双 pty 输出独立。

## F-002 Effort 档位「粘性传播」+ 无跟随默认选项,token 消耗体感异常【中 · 未修】

- **发现**:2026-07-31,所有者反馈 token 消耗疑似异常,怀疑 Effort(推理深度)模块有 bug。
- **排查结论**(对照 SDK sdk.d.ts 与源码):
  - 档位映射**无 bug**:滑块 低/中/高/Extra/Max ↔ low/medium/high/xhigh/max,setEffort 走官方 `applyFlagSettings({effortLevel})`,语义与 SDK 文档一致。
  - 用量统计**无重复计数**:addModelUsage 仅在实时 result 事件累加(total_cost_usd 逐轮),JSONL 历史回放不触发计数。
  - `'high'` 是 SDK 官方默认档(“Deep reasoning (default)”),Fable 5 等新模型在 high 档思考量大,这是偏贵的**正常**行为。
- **真实缺陷(造成消耗不受控的体感)**:
  1. **档位粘性传播**:effort 在会话创建时快照进 meta 并持久化,老会话永远保持创建时档位;切到 high 老会话 → 顶栏同步为 high → 此时新建会话直接继承 high,用户以为默认“中”实际新会话是“高”(app.js `on('session-effort')` + create 时 `effort: currentEffort()`)。
  2. **无“跟随默认”选项**:`currentEffort()` 总是有值,`options.effort` 总是显式传给 SDK,SDK/模型自身默认永无生效机会;改默认档位也只影响之后创建的会话。
- **建议修法**:会话创建时 effort 存 null(表示跟随当前默认档),仅当用户显式 sessSetEffort 才写 meta.effort;UI 对 null 会话显示当前默认档而非回写。产品决策项:是否把应用默认档从 high 调为 medium(省 token)。
- **状态**:**已修复(v0.4.1,2026-07-31)**:按所有者决策,推理深度从顶栏全局滑块移为**会话级下拉**(输入框工具条「推理深度」,与「本会话模型」并列);新建会话 effort 一律为 null(跟随 SDK/模型默认),仅显式调整才写入会话 meta;顶栏 Effort 控件、defaultEffort 设置与死样式一并移除。

## F-003 「上下文窗口」显示值虚高(把整轮输入加总当上下文大小)【中 · 已修】

- **发现**:2026-07-31,所有者反馈"才一轮对话怎么就 86k 上下文"。
- **根因**:`ctxInfo()` 用 `result.usage`(input+cache_read+cache_creation)当上下文窗口大小,但该字段是**整轮所有 API 调用的输入加总**——一轮含 1 次工具调用 = 2 次 API 调用,显示值约为真实上下文的 2 倍。SDK 的 `result.modelUsage[<model>].contextWindow` 才是真实上下文大小。
- **修法**:sessions.js 从 `modelUsage` 提取最大 contextWindow 随 result 事件下发;渲染端优先使用该值,旧事件退化为原启发值。
- **状态**:**已修复(v0.4.1,2026-07-31)**
