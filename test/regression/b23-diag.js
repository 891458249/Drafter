// B23 诊断:分别尝试 claude / cmd.exe 终端
const { CDP } = require('./cdp');
const WS_DIR = require('path').join(process.env.TEMP, 'drafter-reg');
(async () => {
  const cdp = await new CDP().connect();
  for (const cmd of ['claude', 'cmd.exe']) {
    const r = await cdp.eval(`api.termOpen({ cwd: ${JSON.stringify(WS_DIR)}, cols: 80, rows: 24, command: ${JSON.stringify(cmd)} }).then((x) => ({ ok: true, id: (x && x.id) || x })).catch((e) => ({ ok: false, err: String(e).slice(0, 300) }))`);
    console.log(cmd, '→', JSON.stringify(r));
    if (r && r.ok) await cdp.eval(`api.termClose(${JSON.stringify(r.id)})`);
  }
  cdp.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
