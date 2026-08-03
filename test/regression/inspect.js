// 诊断:助手消息里是否有 tool_use、init 的权限模式、是否被设置规则自动放行
const { CDP } = require('./cdp');
(async () => {
  const cdp = await new CDP().connect();
  await cdp.tapEvents();
  const sid = process.argv[2];
  const evs = (await cdp.events()).filter((p) => p.sid === sid);
  for (const p of evs) {
    const ev = p.ev;
    if (ev.type === 'ui_init') console.log('INIT:', JSON.stringify(ev).slice(0, 500));
    if (ev.type === 'assistant') {
      const blocks = (ev.message && ev.message.content) || [];
      for (const b of blocks) {
        if (b.type === 'tool_use') console.log('TOOL_USE:', b.name, JSON.stringify(b.input).slice(0, 150));
        if (b.type === 'text') console.log('TEXT:', (b.text || '').slice(0, 100));
      }
    }
    if (ev.type === 'result') console.log('RESULT:', ev.subtype, 'is_error=' + ev.is_error);
    if (ev.type === 'ui_error') console.log('UI_ERROR:', ev.message);
  }
  cdp.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
