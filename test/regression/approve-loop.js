// 通用:循环批准某会话所有待处理权限卡直到出现新 result(评审/长任务用)
const { CDP, sleep } = require('./cdp');
(async () => {
  const sid = process.argv[2];
  const cdp = await new CDP().connect();
  await cdp.tapEvents();
  const prevResults = await cdp.resultCount(sid);
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 260000) {
    const evs = await cdp.events();
    const done = new Set(evs.filter((p) => p.ev.type === 'ui_permission_done').map((p) => p.ev.reqId));
    const pending = evs.filter((p) => p.ev.type === 'ui_permission' && !done.has(p.ev.reqId) && !seen.has(p.ev.reqId));
    for (const p of pending) {
      seen.add(p.ev.reqId);
      await cdp.eval(`(() => { const b = document.querySelector('.perm-card[data-req-id="${p.ev.reqId}"] button[data-d="allow"]'); if (b) b.click(); })()`);
      console.log('approved:', p.ev.toolName);
    }
    const finished = evs.filter((p) => p.sid === sid && p.ev.type === 'result').length > prevResults;
    if (finished && !pending.length) break;
    await sleep(1200);
  }
  const results = (await cdp.events()).filter((p) => p.sid === sid && p.ev.type === 'result');
  const last = results[results.length - 1];
  const assistants = (await cdp.events()).filter((p) => p.sid === sid && p.ev.type === 'assistant');
  const lastLen = assistants.length ? JSON.stringify(assistants[assistants.length - 1].ev.message.content).length : 0;
  console.log(JSON.stringify({ turnOk: last && !last.ev.is_error, approvedCount: seen.size, lastAssistantLen: lastLen }));
  cdp.close();
})().catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
