// B19 补充:后台子代理(run_in_background=true)→ parent_tool_use_id 归组与任务面板
const { CDP, sleep } = require('./cdp');
const sid = 's_55bcf318-69d';
(async () => {
  const cdp = await new CDP().connect();
  await cdp.tapEvents();
  const prevResults = await cdp.resultCount(sid);
  await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '请使用 Agent 工具并以 run_in_background=true 派一个后台子代理计算 5+6,派出去之后先回复我一句"已派出",不用等结果')`);
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const evs = await cdp.events();
    const done = new Set(evs.filter((p) => p.ev.type === 'ui_permission_done').map((p) => p.ev.reqId));
    for (const p of evs.filter((p) => p.ev.type === 'ui_permission' && !done.has(p.ev.reqId))) {
      done.add(p.ev.reqId);
      await cdp.eval(`(() => { const b = document.querySelector('.perm-card[data-req-id="${p.ev.reqId}"] button[data-d="allow"]'); if (b) b.click(); })()`);
      console.log('approved:', p.ev.toolName);
    }
    const finished = evs.filter((p) => p.sid === sid && p.ev.type === 'result').length > prevResults;
    if (finished) break;
    await sleep(1500);
  }
  await sleep(4000); // 等后台任务通知流入
  const evs = await cdp.events();
  const withParent = evs.filter((p) => p.ev.parent_tool_use_id);
  const taskGroup = await cdp.eval(`document.querySelectorAll('#messages .task-group').length`);
  const taskItem = await cdp.eval(`document.querySelectorAll('#panel-tasks .task-item').length`);
  const typed = {};
  for (const p of withParent) typed[p.ev.type] = (typed[p.ev.type] || 0) + 1;
  console.log(JSON.stringify({ parentEvents: withParent.length, parentTypes: typed, taskGroup, taskItem }));
  cdp.close();
})().catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
