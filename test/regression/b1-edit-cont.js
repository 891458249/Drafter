// B1 edit 续:等待 Edit 权限卡 → 断言 diff → 批准 → 等结果
const fs = require('fs');
const path = require('path');
const { CDP, sleep } = require('./cdp');
const WS_DIR = path.join(process.env.TEMP, 'claude-ui-reg');
const sid = JSON.parse(fs.readFileSync(path.join(__dirname, '.reg-sid.json'), 'utf8')).sid;

(async () => {
  const cdp = await new CDP().connect();
  await cdp.tapEvents();
  const prevResults = await cdp.resultCount(sid);
  const perm = await cdp.waitEvent(`(evs) => evs.find((p) => p.sid === ${JSON.stringify(sid)} && p.ev.type === 'ui_permission' && (p.ev.toolName === 'Edit' || p.ev.toolName === 'Write'))`, 170000);
  const req = perm.ev.reqId;
  await sleep(800);
  const hasDiff = await cdp.eval(`!!document.querySelector('.perm-card[data-req-id="${req}"] .perm-diff')`);
  const cardText = await cdp.eval(`(document.querySelector('.perm-card[data-req-id="${req}"]')||{textContent:''}).textContent.slice(0,200)`);
  await cdp.eval(`document.querySelector('.perm-card[data-req-id="${req}"] button[data-d="allow"]').click()`);
  await cdp.waitIdle(sid, prevResults, 170000);
  const after = fs.readFileSync(path.join(WS_DIR, 'edit-me.txt'), 'utf8');
  console.log(JSON.stringify({ hasDiff, cardText: cardText.slice(0, 120), fileAfter: after.trim(), pass: hasDiff && after.includes('line2') }));
  cdp.close();
})().catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
