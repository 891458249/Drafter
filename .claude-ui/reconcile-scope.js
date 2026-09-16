// 参数化版本(源自 reconcile-debug-scope.js):清理指定 scope 下卡死的调试资源记录。
// 用法: node reconcile-scope.js <scope>
// 仅当「目标进程与 supervisor 按 PID+启动时间核对确实均已退出」才把记录标记 released 并清 stop 文件。
const fs = require('fs');
const path = require('path');
const rt = require('C:/Users/dingyongzhen/.claude/debug-runtime/87dfe784e25b6337a6d3bd8feb91a61315239b965e576b7a886fe06acccffcef/index.js');

const scope = process.argv[2];
if (!scope) { console.error('usage: node reconcile-scope.js <scope>'); process.exit(2); }

async function alive(pid, started) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { return (await rt.identity(pid)) === started; } catch { return false; } // exit 3 = 进程不存在
}

(async () => {
  const dir = rt.scopeDir(scope);
  const items = rt.records(scope);
  const fixed = [];
  for (const item of items) {
    if (item.status === 'released') continue;
    if (item.status === 'attached' || !item.pid) continue;
    const targetAlive = await alive(item.pid, item.started);
    const supAlive = await alive(item.supervisorPid, item.supervisorStarted);
    if (!targetAlive && !supAlive) {
      const next = { ...item, status: 'released', error: item.error || null };
      const file = path.join(dir, item.id, 'state.json');
      const tmp = file + '.' + require('crypto').randomUUID() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(tmp, file);
      const stop = path.join(dir, item.id, 'stop');
      try { fs.rmSync(stop, { force: true }); } catch {}
      fixed.push({ id: item.id, pid: item.pid, supervisorPid: item.supervisorPid });
    } else {
      console.log('SKIP(still alive):', item.id, { targetAlive, supAlive });
    }
  }
  console.log('reconciled:', JSON.stringify(fixed));
  const report = await rt.verify(scope);
  console.log('verify:', JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
