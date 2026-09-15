const path = require('node:path');
const RULES = `调试收尾是任务完成条件：调用任何软件调试前，优先使用隔离实例和受管启动，登记本次资源所属会话。调试完毕、失败或取消均在 finally 停止采集和自动重连，断开调试器/CDP/WebSocket/COM，关闭本次创建的文档和文件句柄，退出自有测试实例及子进程，验证端口和文件占用解除。不得仅关窗口或发出 kill 就声称已释放。禁止按软件名批量杀进程；用户原有软件、其他会话及共享服务只能解除本次调试连接，不能退出。附加连接须由脚本明确 release 并 verify；无法验证时报告残留及处理方式，不能宣布完成。用户明确要求保留实例时说明更新可能受阻，并将实例作为用户保留资源交接，不冒充已清理。未登记的外部软件不在自动清理覆盖范围。`;
function instructions(scope, ownerPid = process.pid) {
  const cli = path.join(__dirname, 'cli.js');
  return RULES + `\n本次受管调试入口（Windows，启动任何本次专用测试软件/脚本使用此入口）：node ${JSON.stringify(cli)} launch --scope ${JSON.stringify(scope)} --owner ${ownerPid} --cwd "绝对工作目录" -- "软件exe绝对路径" 参数…\n启动后返回受管 PID；后台实例在任务结束自动清理，调试完成应立即主动执行：node ${JSON.stringify(cli)} cleanup --scope ${JSON.stringify(scope)}。查询使用 status/verify。所有进程启动仍须遵守现有权限，不通过此入口规避只读或审批。`;
}
module.exports = { RULES, instructions };
