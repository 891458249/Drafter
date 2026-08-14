// B1 edit(修正版):审批本回合出现的所有权限卡(Read/Edit 都批),
// 在 Edit 卡上断言 .perm-diff,最终验证文件被改成 line2。
const fs = require('fs');
const path = require('path');
const { CDP, sleep } = require('./cdp');
const WS_DIR = path.join(process.env.TEMP, 'drafter-reg');
const sid = JSON.parse(fs.readFileSync(path.join(__dirname, '.reg-sid.json'), 'utf8')).sid;

(async () => {
  const cdp = await new CDP().connect();
  await cdp.tapEvents();
  const baseline = new Set((await cdp.events())
    .filter((p) => p.ev.type === 'ui_permission').map((p) => p.ev.reqId));
  const prevResults = await cdp.resultCount(sid);
  await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '用 Edit 工具把 edit-me.txt 文件里的 line1 改成 line2,改完只回复 DONE 两个字')`);

  let editDiffSeen = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const evs = await cdp.events();
    const fresh = evs.filter((p) => p.ev.type === 'ui_permission' && !baseline.has(p.ev.reqId));
    for (const p of fresh) {
      baseline.add(p.ev.reqId); // 只处理一次
      const req = p.ev.reqId;
      await sleep(600);
      if (p.ev.toolName === 'Edit' || p.ev.toolName === 'Write') {
        editDiffSeen = await cdp.eval(`!!document.querySelector('.perm-card[data-req-id="${req}"] .perm-diff')`);
      }
      const clicked = await cdp.eval(`(() => { const b = document.querySelector('.perm-card[data-req-id="${req}"] button[data-d="allow"]'); if (b) { b.click(); return true; } return false; })()`);
      console.log(JSON.stringify({ approved: p.ev.toolName, req, clicked, editDiffSeen }));
    }
    const done = evs.filter((p) => p.sid === sid && p.ev.type === 'result').length > prevResults;
    if (done) break;
    await sleep(1000);
  }
  await sleep(500);
  const after = fs.readFileSync(path.join(WS_DIR, 'edit-me.txt'), 'utf8');
  const results = (await cdp.events()).filter((p) => p.sid === sid && p.ev.type === 'result');
  const lastOk = results.length && !results[results.length - 1].ev.is_error;
  console.log(JSON.stringify({ step: 'edit', editDiffSeen, fileAfter: after.trim(), lastResultOk: !!lastOk, pass: editDiffSeen && after.includes('line2') && !!lastOk }));
  cdp.close();
})().catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
