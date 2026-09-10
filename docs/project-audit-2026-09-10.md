# Drafter 项目检查报告

检查日期：2026-09-10。检查对象：`D:\ClaudeUI` 当前工作区（包含已有未提交修改）。

> 后续修复记录（2026-09-10）：下文保留初次检查结果。报告中的五项问题已在 v0.15.7 中处理，详细变更见根目录 `版本更新.md`。测试增至 337/337；新构建的 0.15.7 安装包通过 87 个文件源码一致性、二进制位置与 SHA-512 校验；打包态主界面、设置 IPC、Markdown、终端和 Harness 冒烟通过。只读保护现采用限制不可核实工具调用的策略，应用外部进程不在其保护范围。未做真实供应商付费请求、外部 ComfyUI 服务或系统级故障注入测试，也未执行全新机器的依赖安装。

## 结论

项目已具备较完整的桌面 AI 工作台功能，现有自动化测试全部通过，未发现脚本语法错误。但测试通过不能代表权限、数据恢复和发行流程没有问题。本次发现 **2 项高优先级问题、3 项中优先级问题**，建议优先修复只读保护缺口和配置损坏后的覆盖行为，再验证 0.15.7 网关修复的 Windows 路径边界。

本轮未修改业务代码、现有测试或配置，未启动真实模型付费请求，未重新打包或发布。仅新增本报告。问题复现使用内存模拟及独立 Node 进程，没有执行用于说明风险的文件写入命令。

## 项目现状

| 项目 | 检查结果 |
|---|---|
| 产品 | Drafter，Electron 桌面 AI 工作台 |
| 工作区版本 | 0.15.7 |
| Git | main，HEAD 为 `0172269c`；6 个已跟踪文件有修改，另有多项未跟踪脚本及冒烟测试目录 |
| 已有安装产物 | `dist/win-unpacked/resources/app.asar` 和 `dist/latest.yml` 均为 0.15.6 |
| 主体技术 | Electron 38.8.6、JavaScript、Claude Agent SDK 0.3.218、node-pty、xterm、marked |
| 数据持久化 | Electron userData 下的 JSON 配置、会话元数据及 JSONL 事件日志 |
| 启动与打包 | `npm start`、`npm run dist`；Windows NSIS 安装包 |

架构分为 Electron 主进程与 IPC 桥、原生 ES 模块渲染界面、Agent 会话管理、模型协议代理、AI 创作/ComfyUI，以及内嵌 DeepSeek Harness。主进程已有文件、Git、项目、定时任务、权限、更新和迁移等独立模块。

当前未提交的主要业务变更是 `src/main/sessions.js` 的 `agentSettingSources()`：避免主目录下的项目设置重新载入用户级网关配置；配套修改了 `test/chat-fast.test.js` 并将版本提升至 0.15.7。它们均为检查前已有改动。

## 验证结果

| 检查 | 本轮结果 | 适用范围 |
|---|---|---|
| `npm test` | **321 通过，0 失败，0 跳过**；约 6.85 秒 | 根目录 51 个 `*.test.js` 文件 |
| 真实 SDK 协议测试 | 通过 | claude.exe → 本地模拟网关，含子 Agent 模型守卫和 OpenAI 协议工具回路；不代表真实供应商服务状态 |
| `node --check` | **153 个脚本全部通过** | src/test 与根入口脚本，排除 src 内 vendor 和 dist 生成文件 |
| `npm ls --depth=0` | 通过 | 根项目直接依赖无 missing/invalid 报告；不等同于供应链漏洞扫描 |
| `git diff --check` | 通过 | 已有差异未报告空白错误；有 LF/CRLF 提示 |
| `node test/verify-packaged-bin.js` | 通过 | 已有 **0.15.6** 产物的 SDK 与 unpacked claude.exe 路径存在；不代表 0.15.7 构建通过 |

测试运行环境是 Node 24.18.0、npm 11.16.0。未在本轮启动 Electron 窗口、执行完整 UI 回归、验证真实 ComfyUI 服务、重新构建安装包或验证自动更新。根测试命令也不会自动执行 `test/regression/` 下的独立脚本。

## 主要问题

### P1：只读标签不能阻止命令工具修改文件

**位置：** `src/main/sessions.js:450`、`:780`、`:802`。

项目级 PreToolUse 只匹配 `Edit|Write|MultiEdit|NotebookEdit`，权限回调也只对这些工具检查只读标签。Bash 不会经过相同检查，且在“不询问”模式下直接放行。

**复现：** 在内存中登记一个 readonly 文件，用真实 `projects.isReadonly()` 和 `Session._onPermission()` 检查：标签为 true；同一路径的 Edit 请求返回 deny；`echo changed > <该路径>` 的 Bash 请求返回 allow。仅检查授权结果，没有执行该命令。

**影响：** 当前“只读硬拦截”的保证只覆盖部分编辑工具；模型通过 shell、脚本或其他写入工具仍可能修改标为只读的文件。

**建议：** 明确只读标签的约束范围，并将强制保护落实到统一执行边界或文件系统权限层。仅解析 shell 命令字符串不足以实现可靠隔离。补充命令写入与其他工具路径的回归测试。

### P1：损坏的配置可能被空默认数据覆盖

**位置：** `src/main/store.js:14`、`:23`。

`loadStore()` 吞掉读取和 JSON 解析错误；若没有可用的旧品牌配置文件，则返回空默认结构。后续任意 `update()` 会调用 `saveStore()`，直接覆盖当前配置文件。写入也没有临时文件原子替换和可靠备份，保存失败仅记录日志。

**复现：** 用内存文件系统模拟 `drafter-store.json` 内容损坏、旧配置不存在：加载得到空 sessions/settings；随后只设置 theme，生成的覆盖内容仍是空 sessions，并只保留新 theme。

**影响：** 文件截断、异常退出或读取异常后，下一次普通设置变更可能覆盖会话索引、项目、密钥配置等数据。独立 JSONL 事件文件不一定被删除，但其索引和设置可能丢失。

**建议：** 区分首次不存在、解析损坏和访问失败；损坏时保留原件并阻止静默覆盖；使用同目录临时文件替换、备份与显式保存错误反馈。增加截断文件、无写权限和备份恢复测试。

### P2：0.15.7 网关修复遗漏 Windows 路径大小写

**位置：** `src/main/sessions.js:131`。

`agentSettingSources()` 对两个 `path.resolve()` 结果使用大小写敏感的字符串相等判断。Windows 默认文件系统中，同一目录可用不同大小写表示。

**复现：** 原始配置父目录返回 `[]`，将同一路径转成大写后返回 `['project', 'local']`；`fs.statSync` 的设备号与文件标识一致，确认指向同一目录。

**影响：** 某些 cwd 表示形式下可能重新启用项目设置，使本次要修复的错误网关覆盖问题再次出现。本轮复现了配置源选择错误，没有访问真实网关验证 403。

**建议：** 按平台规范化路径身份，再做比较；补充大小写变体测试，并考虑目录链接与自定义 CLAUDE_CONFIG_DIR 的语义。

### P2：聊天 Markdown 保留原始 HTML，存在界面注入风险

**位置：** `src/renderer/state.js:88`、`src/renderer/chat.js:290`、`:412`，以及 `src/index.html:6`。

`renderMarkdown()` 直接返回 `marked.parse()` 的结果，随后写入 `innerHTML`，没有 HTML 清洗。页面 CSP 禁止内联脚本，但允许内联样式。

**验证：** 当前 marked 会原样保留 `<style>body{display:none}</style>` 和带任意 id 的 HTML 元素。

**影响：** 不可信聊天内容可携带改变布局、隐藏界面或伪造界面元素的 HTML/CSS。现有 CSP 有助于限制脚本执行，因此本报告不将其认定为已证实的任意脚本执行或系统命令执行漏洞。未进行 Electron 界面攻击实测。

**建议：** 使用严格 HTML 白名单清洗或禁用 Markdown 原始 HTML；移除 style、事件属性和危险 URL 协议，限制可能影响应用元素的 id/name。增加恶意 Markdown 渲染用例。

### P2：干净环境的构建流程不完整，存在机器路径依赖

**位置：** `tsdown.config.ts:5`、`package.json:6`、`src/main/harness/harness-bridge.js:744`、`:768`。

根构建配置写死了 `D:/ClaudeUI/.../package.json` 作为依赖解析锚点。运行时必需的 `src/harness/dist/ipc-client-entry.mjs` 和 `vendor/deepseek-harness/apps/web/dist/index.html` 本机存在，但均被 Git 忽略。根 `npm run dist` 仅调用 electron-builder，没有串联生成它们的步骤。

**影响：** 换目录、换机器或干净检出后，仅遵循根 README 的启动/打包步骤不能保证重建 Harness 所需产物；本机旧产物还可能掩盖源代码与打包内容不一致的问题。这是静态确认的构建依赖缺口，本轮未执行干净检出构建。

**建议：** 用当前配置文件位置计算路径；提供明确的依赖安装、Harness 构建、IPC bundle 构建及打包入口，并在打包前校验必需产物。用干净目录验证一次完整流程。

## 工程维护观察

- **已有较好的基础防护：** 主窗口启用 contextIsolation、关闭 nodeIntegration，拦截主窗口导航；`store:get` 排除完整 API Key；`aigc:` 协议实现路径检查。不能因存在上述风险而忽略这些现有措施。
- **质量检查尚未形成统一门禁：** 根 package.json 没有 lint/typecheck 脚本，根 lefthook.yml 全部为示例注释，未发现已跟踪的根 `.github` 工作流。vendor 自身拥有独立检查工具，但不等于根应用已接入。
- **部分模块较大：** canvas.js 约 85 KB，app.js 约 64 KB，main.js 与 sessions.js 各约 62 KB。功能增长后应按职责拆分，优先降低 IPC 注册和会话状态逻辑的耦合。
- **回归记录需更新：** 根 REGRESSION.md 的主要执行记录为 2026-08-03；它不能作为当前 0.15.7 全功能已验证的证据，且文档明确保留了跳过项及有限验证项。
- **产物与临时目录较多：** dist 顶层有 86 个历史安装 exe，合计约 14.01 GB（十进制，仅统计 exe）；多种冒烟用户目录未被当前忽略规则覆盖。建议制定保留策略，避免临时配置误入提交。本轮未删除任何内容。
- **Git 环境有非阻塞警告：** 读取用户级 Git ignore 文件时提示 Permission denied；本轮 Git 状态、差异与日志查询仍成功。建议单独修复该文件的读取权限。

## 建议顺序

1. 修复只读执行边界和配置损坏后的恢复逻辑。
2. 补齐 0.15.7 路径判断及 Markdown 清洗测试。
3. 补齐干净构建入口，验证生成的 0.15.7 安装包。
4. 执行隔离用户目录下的 Electron 界面回归，覆盖聊天模式切换、历史恢复、权限交互、Harness 和 ComfyUI。
5. 接入持续集成，更新回归记录并整理历史产物。
