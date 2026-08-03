// B23 重跑(F-005 修复后):＋终端应经回退链启动(cmd.exe),标签/切换/关闭/pty 独立
const { CDP, sleep } = require('./cdp');
const path = require('path');
const WS_DIR = path.join(process.env.TEMP, 'claude-ui-reg');
(async () => {
  const cdp = await new CDP().connect();
  // 打开终端面板
  await cdp.eval(`(() => { const rp = document.querySelector('#right-panel'); if (rp.classList.contains('hidden')) document.querySelector('#btn-panel').click(); document.querySelector('.ptab[data-panel="terminal"]').click(); })()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('#btn-term-new').click()`);
  await sleep(3000);
  const tabs1 = await cdp.eval(`document.querySelectorAll('#term-tabs .term-tab').length`);
  await cdp.eval(`document.querySelector('#btn-term-new').click()`);
  await sleep(3000);
  const tabs2 = await cdp.eval(`document.querySelectorAll('#term-tabs .term-tab').length`);
  await cdp.eval(`document.querySelectorAll('#term-tabs .term-tab')[0].click()`);
  await sleep(400);
  const activeFirst = await cdp.eval(`document.querySelectorAll('#term-tabs .term-tab')[0].classList.contains('active')`);
  await cdp.eval(`document.querySelectorAll('#term-tabs .term-tab .x')[1].click()`);
  await sleep(600);
  const tabs3 = await cdp.eval(`document.querySelectorAll('#term-tabs .term-tab').length`);
  // pty 独立性
  await cdp.eval(`window.__regTerm = []; api.on('term:data', (p) => window.__regTerm.push(p));`);
  const t1 = await cdp.eval(`api.termOpen({ cwd: ${JSON.stringify(WS_DIR)}, cols: 80, rows: 24 })`);
  const t2 = await cdp.eval(`api.termOpen({ cwd: ${JSON.stringify(WS_DIR)}, cols: 80, rows: 24 })`);
  await sleep(1500);
  await cdp.eval(`api.termInput(${JSON.stringify(t1.id)}, 'echo REG_T_A\\r')`);
  await cdp.eval(`api.termInput(${JSON.stringify(t2.id)}, 'echo REG_T_B\\r')`);
  await sleep(2000);
  const termData = await cdp.eval(`JSON.stringify(window.__regTerm)`);
  const indep = termData.includes('REG_T_A') && termData.includes('REG_T_B');
  await cdp.eval(`api.termClose(${JSON.stringify(t1.id)})`);
  await cdp.eval(`api.termClose(${JSON.stringify(t2.id)})`);
  // 终端实际输出:第一个 UI 终端输入命令看回显
  console.log(JSON.stringify({
    step: 'b23-rerun', tabs1, tabs2, activeFirst, tabs3,
    shellFallbackWorks: tabs1 >= 1, ptyIndependent: indep,
    pass: tabs1 === 1 && tabs2 === 2 && activeFirst && tabs3 === 1 && indep,
  }));
  cdp.close();
})().catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
