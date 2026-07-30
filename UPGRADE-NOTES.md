# SDK 升级评估记录(@anthropic-ai/claude-agent-sdk)

评估日期:2026-07-30 · 当前依赖:`^0.3.218`(本地锁定 0.3.218)· 最新发布:**0.3.220**(2026-07-25)

## 结论:不升级,维持 0.3.218

0.3.220 相对 0.3.218 仅为两个 patch 版本,API 面**纯新增、零 breaking**;新增能力本项目当前均未使用,无实质收益。`^0.3.218` 语义化范围已覆盖 0.3.220,未来重装依赖时会自然获得,无需专门发版。

## 评估过程

1. `npm view @anthropic-ai/claude-agent-sdk versions --json` → 最新 0.3.220。
2. `npm pack @anthropic-ai/claude-agent-sdk@0.3.220` 解包,与本地 0.3.218 的 `sdk.d.ts` 做全量 diff(91 行差异,全部为新增)。
3. 逐项核对 sessions.js 现有用法(query / canUseTool / resume / forkSession / streaming input / setModel / setPermissionMode):签名与行为均无变化。

## 0.3.220 新增内容(均未使用)

- `DirectoryAdded` hook 事件(/add-dir 或 register_repo_root 时触发)
- `FastModeDisabledReason` 类型与 `fast_mode_disabled_reason` 字段(fast mode 状态说明)
- interrupt 控制请求新增 `cancel_queued` 选项 + `interrupt_cancel_queued_v1` capability(中断时连队列消息一并取消)
- 沙箱 `strictAllowlist` 设置、`workflowSizeGuideline` 设置项

## 关于 Auto 权限模式的发现

- 两个版本的 `PermissionMode` 类型定义**都包含 `'auto'`**(`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`)——DEVLOG B6 的「SDK 无 Auto 模式」表述在类型层面已过时。
- 但 Auto 模式的安全分类器是官方服务端能力(DEVLOG C 区已记录),类型存在 ≠ 当前账号/CLI 运行时可用,未做运行时验证前维持 B6 降级方案不变。
- 后续若要把下拉的「Auto」项接回,需先在真实会话中验证 `permissionMode: 'auto'` 的运行时行为(是否拦截危险操作、是否报错),验证通过后按 minor 版本处理。

## 复审触发条件

- SDK 发布 0.4.x(major/minor 变化,需重新评估 breaking changes)
- 本项目需要 interrupt `cancel_queued`、`DirectoryAdded` hook 等新增能力时
- Auto 模式运行时验证提上日程时
