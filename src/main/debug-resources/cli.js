const resources = require('./index');
const { instructions } = require('./rules');
async function hook(input) {
  const scope = 'cli:' + input.session_id;
  if (!input.session_id) throw new Error('Hook session_id is required');
  const event = input.hook_event_name;
  if (event === 'SessionStart' || event === 'PreToolUse') {
    let owner = input.owner_pid;
    if (!owner) { try { owner = await resources.hookOwner(); } catch { owner = 0; } }
    return { hookSpecificOutput: { hookEventName: event, additionalContext: instructions(scope, owner) + (owner ? '' : '\n未能识别持久会话进程，启动前须核实 owner PID；禁止使用短命 hook/shell 的 PID。') } };
  }
  if (event === 'PostToolUseFailure') {
    return { hookSpecificOutput: { hookEventName: event, additionalContext: '若本次调试已失败结束，请立即执行受管 cleanup；继续排查中的实例不要提前关闭。调试脚本必须在 finally 释放本次连接。' } };
  }
  if (event === 'Stop' || event === 'SessionEnd') {
    const result = await resources.cleanup(scope);
    if (!result.ok) return event === 'Stop' && !input.stop_hook_active
      ? { decision: 'block', reason: '调试资源尚未释放：' + JSON.stringify(result.pending) }
      : { systemMessage: '调试占用未全部解除，请处理：' + JSON.stringify(result.pending) };
    return result.count ? { systemMessage: `本次 ${result.count} 项已登记调试资源已释放并复核。未登记资源须另行核实。` } : {};
  }
  return {};
}
async function main(argv) {
  if (argv[0] === 'hook') {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return hook(JSON.parse(text));
  }
  const [command, ...args] = argv;
  const split = args.indexOf('--');
  const opts = split < 0 ? args : args.slice(0, split);
  const value = (key) => { const i = opts.indexOf('--' + key); return i < 0 ? undefined : opts[i + 1]; };
  const scope = value('scope');
  if (!scope) throw new Error('--scope is required');
  if (command === 'launch') {
    const [exe, ...exeArgs] = split < 0 ? [] : args.slice(split + 1);
    if (!exe || !value('owner')) throw new Error('launch requires --owner PID and -- executable args');
    return resources.launch({ scope, exe, args: exeArgs, cwd: value('cwd') || process.cwd(), ownerPid: Number(value('owner')), ports: value('ports') ? value('ports').split(',').map(Number) : [] });
  }
  if (command === 'status') return resources.records(scope);
  if (command === 'cleanup') return resources.cleanup(scope);
  if (command === 'verify') return resources.verify(scope);
  throw new Error('Expected launch, status, cleanup or verify');
}
if (require.main === module) main(process.argv.slice(2)).then((value) => {
  console.log(JSON.stringify(value));
  if (value.ok === false) process.exitCode = 1;
}).catch((e) => { console.error('Debug cleanup: ' + e.message); process.exitCode = 1; });
module.exports = { hook, main };
