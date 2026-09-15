# 调试占用释放

调试完成包括释放本次调试资源。规则不限软件品牌；自动清理只覆盖受管启动的实例和明确登记的连接，不代表能自动关闭任意第三方软件。

## Windows 受管启动

Drafter Agent 会话通过系统提示和工具钩子提供本次 scope、入口路径和 owner PID。本机 CLI 的全局 hooks 提供同样入口。

```text
node <debug-resources/cli.js> launch --scope <当前scope> --owner <持续存活的会话PID> --cwd <绝对工作目录> --ports 9229 -- <exe绝对路径> <参数...>
node <debug-resources/cli.js> status --scope <当前scope>
node <debug-resources/cli.js> cleanup --scope <当前scope>
node <debug-resources/cli.js> verify --scope <当前scope>
```

- 只启动本次专用实例，优先使用隔离的 userData 和专属端口。owner 不能是马上退出的 shell/hook。
- 程序先以挂起状态创建，加入私有 Windows Job Object 后才执行，普通 breakaway 不允许。监督器退出会关闭 Job 并回收后代。
- 清理先对私有 Job 成员请求正常关窗，2 秒后仍未退出则终止该 Job。此机制不适合包含未保存用户工作的实例。
- 监督器检查 owner 的 PID 和创建时间，owner 退出/身份改变后清理；它自己的 cwd 和脚本在独立临时/状态目录，不占软件安装目录。
- 复核依据：Job 活跃成员归零、监督器退出，以及已登记的本机 IPv4 loopback TCP 端口可以重新绑定。文件锁、其他地址族、远程服务需额外验证，不推断为全部解除。
- 状态位于 `~/.claude/debug-resource-state/`；可用 `DRAFTER_DEBUG_ROOT` 指向隔离测试目录。路径只按 scope 哈希和资源 UUID 生成。不保存密钥、完整命令行或可执行清理指令；日志/状态保留便于诊断，不自动删除用户数据。
- 非 Windows 受管启动明确报错，不偷偷无跟踪启动。

## 调试脚本与已有软件

脚本使用 `require('<模块目录>')` 的 `launch({ scope, exe, args, cwd, env, ports, ownerPid })` 启动专用进程。`env` 中 null/空字符串删除变量。调试操作仍受原有权限审批和只读策略约束。

连接由脚本拥有，必须在同一进程中登记释放函数：

```js
resources.attach(scope, {
  name: '本次调试连接',
  release: async () => { await connection.disconnect(); },
  verify: () => !connection.connected,
});
try {
  // 调试和验证
} finally {
  const report = await resources.cleanup(scope);
  if (!report.ok) throw new Error(JSON.stringify(report.pending));
}
```

回调不会写入状态文件。脚本崩溃后无法调用已丢失的回调时，状态保持未验证，不能冒称清理成功。COM、IDE、MCP、远程软件必须用各自接口释放对象/会话；附加已有软件时不能退出用户实例。不要按 node/python/electron 等名字杀进程，也不要把用户原实例注册成可终止实例。

明确要求保留的软件应从一开始作为用户交接资源处理，不放入自动终止的私有 Job；说明保留会影响更新，不能声称“全部释放”。当前版本不支持从受管 Job 中脱离进程。

## 全局安装

运行 `node scripts/install-debug-cleanup.js`，将独立运行模块放入 `~/.claude/debug-resources` 并合并 SessionStart、PreToolUse、PostToolUseFailure、Stop、SessionEnd command hooks。保留现有设置，按时间戳备份原 settings。安装清单校验防止覆盖人工修改过的模块。

用户级规则另写入 `~/.claude/CLAUDE.md`。安装脚本不改 Key/网关/model，也不使 Drafter 重新加载 user settingSources。Drafter 使用自己的 SDK hooks 和 Harness 桥，因此不会因全局网关设置发生串用。

修改后使用 `/hooks` 重载或重启会话。本轮已验证 hook 命令的 stdin/JSON、SDK Stop 与 interrupt；当前 Drafter 会话不加载 user settings，不能用它证明用户级钩子热加载。

## 生命周期及边界

- SDK 正常 Stop 清理已登记资源；interrupt、query finally、stop 和应用退出再兜底。旧 query 的清理对象独立，不会清理新 query 的 scope。
- Harness 注册会话提示、正常停止、AbortSignal 取消和错误清理；关闭桥时释放事件监听与登记资源。纯问答无工具，不启动监督器。
- 更新安装前检查当前应用跟踪的资源，有未解除项目则拒绝开始安装。不是全系统更新管理器，不扫描关闭其他软件。
- 用户级 Stop **不一定在用户中断时执行**。owner 仍在且用户仅中断一轮时，监督器不知道业务任务已结束，必须靠 finally/后续 cleanup 或 SessionEnd；不能承诺任意中断立即自动清理。
- 没有登记、权限不足、状态损坏、身份无法核实或外部服务残留时明确报告，不做全局强杀。非受管历史残留不自动认领。

## 验证命令

- `node --test test/debug-resources.test.js`：作用域隔离、回调幂等、状态损坏、钩子合并、代次隔离、Windows owner 退出、父子进程/端口/独占文件锁释放。
- `node --test test/agent-route-live.test.js`：真实 SDK + 本地假网关，Stop 和 interrupt 接线以及现有安全守卫。
- `npm test`：完整项目回归。
- PowerShell：`$env:DRAFTER_SMOKE_DEV='1'; node test/packaged-smoke.js`：独立目录运行开发版，交互主界面/终端/Harness，finally 复核调试端口和进程释放。
- 打包版仍用 `node test/packaged-smoke.js <dist目录>`；旧包不含新代码，不应把开发版结果称作新包验收。
