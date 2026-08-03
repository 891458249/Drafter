// 收尾清理:删除回归测试会话(仅测试工作区 cwd 的),关闭应用与本地服务器
const { CDP, sleep } = require('./cdp');
const path = require('path');
const WS_DIR = path.join(process.env.TEMP, 'claude-ui-reg');
(async () => {
  const cdp = await new CDP().connect();
  const list = await cdp.eval(`api.sessList()`);
  const mine = list.filter((m) => m.cwd && m.cwd.replace(/\\/g, '/').includes('claude-ui-reg'));
  for (const m of mine) {
    await cdp.eval(`api.sessRemove(${JSON.stringify(m.id)})`);
    console.log('removed session:', m.id, m.title || '');
  }
  console.log('cleaned', mine.length, 'test sessions');
  cdp.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
