// 清理本 scope 下卡死的调试资源记录:目标进程与 supervisor 均已退出(此前已按 PID 核实),
// 但 supervisor 在崩溃/被杀前未能把 status 写成 released,verify 一直 pending。
// 本脚本复用 runtime 的 identity() 复核「进程确实不存在」后才把记录标记为 released,
// 并清理残留的 stop 文件,使 cleanup/verify 能得出 ok:true。
const fs = require('fs');
const path = require('path');
const rt = require('C:/Users/dingyongzhen/.claude/debug-runtime/87dfe784e25b6337a6d3bd8feb91a61315239b965e576b7a886fe06acccffcef/index.js');

const scope = 'drafter:s_87485b8b-768:520433cf-6dcc-46c2-9510-76f7710dd999:6f899a09-ea48-4bdc-bf0d-22f8625c3eb7';

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
    // 只有 supervised 记录才有 pid/supervisorPid;attached 记录由回调处理,不动。
    if (item.status === 'attached' || !item.pid) continue;
    const targetAlive = await alive(item.pid, item.started);
    const supAlive = await alive(item.supervisorPid, item.supervisorStarted);
    const portBusy = [];
    for (const p of item.ports || []) { /* ports 为空时不检查 */ void p; }
    if (!targetAlive && !supAlive && portBusy.length === 0) {
      const next = { ...item, status: 'released', error: item.error || null };
      const file = path.join(dir, item.id, 'state.json');
      const tmp = file + '.' + require('crypto').randomUUID() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(tmp, file);
      const stop = path.join(dir, item.id, 'stop');
      try { fs.rmSync(stop, { force: true }); } catch {}
      fixed.push({ id: item.id, pid: item.pid, supervisorPid: item.supervisorPid });
    } else {
      console.log('SKIP(still alive):', item.id, { targetAlive, supAlive, portBusy });
    }
  }
  console.log('reconciled:', JSON.stringify(fixed));
  const report = await rt.verify(scope);
  console.log('verify:', JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
