const path = require('node:path');
// 规则只随系统提示下发一次(v0.15.22):此前每次 Bash/PowerShell/MCP 调用都经 PreToolUse
// 注入整段规则,单会话累计 100KB+ 进入上下文,并把模型推向「凡进程皆走启动器」。
const RULES = `调试资源收尾:只在启动会一直驻留的程序(GUI 软件、服务、开着调试端口的实例)时使用下方受管入口;会自行结束的脚本/命令(测试、构建、mayapy/python 脚本等)直接运行即可,或用 launch --wait 前台跑完取回输出与退出码。受管实例在回合结束时自动清理;用完可主动 cleanup。禁止按软件名批量杀进程,用户原有软件和其他会话的进程不得退出,只能断开本次建立的调试连接。清理后以 verify 结果为准,无法验证时如实报告残留。`;
function instructions(scope, ownerPid = process.pid) {
  const cli = JSON.stringify(path.join(__dirname, 'cli.js'));
  const sc = JSON.stringify(scope);
  return RULES + `\n受管入口(Windows):node ${cli} launch --scope ${sc} --owner ${ownerPid} --cwd "绝对工作目录" [--wait 秒] [--ports 端口] -- "exe绝对路径" 参数…\n不带 --wait 时后台运行,程序输出写入返回记录的 log 文件;带 --wait 时等待结束并直接打印输出。查询/清理:status | verify | cleanup --scope ${sc}。所有进程启动仍须遵守现有权限。`;
}
module.exports = { RULES, instructions };
