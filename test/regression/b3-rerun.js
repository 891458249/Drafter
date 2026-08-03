// B3 重跑(F-004 修复后):重启后非恢复会话先收 live 事件,点开后历史应完整加载
const { execSync, spawn } = require('child_process');
const path = require('path');
const { CDP, sleep } = require('./cdp');
const WS_DIR = path.join(process.env.TEMP, 'claude-ui-reg');
const APP = path.join(__dirname, '..', '..');

(async () => {
  // 1. 建 R1 并完成一轮
  let cdp = await new CDP().connect();
  await cdp.tapEvents();
  const r1 = await cdp.eval(`api.sessCreate({ cwd: ${JSON.stringify(WS_DIR)}, permissionMode: 'default', title: 'REG-B3R-1' })`);
  await cdp.eval(`api.sessSend(${JSON.stringify(r1.id)}, '只回复 REG_B3R_TURN1 十二个字符')`);
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const evs = await cdp.events();
    if (evs.some((p) => p.sid === r1.id && p.ev.type === 'result')) break;
    await sleep(1500);
  }
  // 2. 建 R2(无回合,仅为成为 landing 恢复对象)
  await cdp.eval(`api.sessCreate({ cwd: ${JSON.stringify(WS_DIR)}, permissionMode: 'default', title: 'REG-B3R-2' })`);
  cdp.close();

  // 3. 杀应用重启
  try { execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' }); } catch {}
  await sleep(2500);
  const child = spawn(path.join(APP, 'node_modules', '.bin', 'electron.cmd'), ['.', '--remote-debugging-port=9222'], { cwd: APP, detached: true, stdio: 'ignore', shell: true });
  child.unref();
  await sleep(9000);

  // 4. 重连,R1 此时未在渲染端初始化;向 R1 发新消息(live 事件先到)
  cdp = await new CDP().connect();
  await cdp.tapEvents();
  await cdp.eval(`api.sessSend(${JSON.stringify(r1.id)}, '只回复 REG_B3R_TURN2 十二个字符')`);
  const t1 = Date.now();
  while (Date.now() - t1 < 180000) {
    const evs = await cdp.events();
    if (evs.filter((p) => p.sid === r1.id && p.ev.type === 'result').length >= 1) break;
    await sleep(1500);
  }
  await sleep(2500); // 等 replayHistory + buffer flush

  // 5. 点开 R1:历史(TURN1)与新事件(TURN2)都应可见,且 TURN2 不重复
  await cdp.eval(`(() => {
    const items = [...document.querySelectorAll('li.session-item')];
    const it = items.find((el) => el.textContent.includes('REG-B3R-1'));
    if (it) it.click();
  })()`);
  await sleep(2500);
  const info = await cdp.eval(`(() => {
    const logs = [...document.querySelectorAll('.session-log')];
    const vis = logs.find((el) => !el.classList.contains('hidden'));
    if (!vis) return { found: false };
    const t = vis.textContent;
    return {
      found: true,
      hasTurn1: t.includes('REG_B3R_TURN1'),
      turn2Count: (t.match(/REG_B3R_TURN2/g) || []).length,
      len: t.length,
    };
  })()`);
  const pass = info.found && info.hasTurn1 && info.turn2Count >= 1 && info.turn2Count <= 2; // 用户回显+助手回复各一次为正常
  console.log(JSON.stringify({ step: 'b3-rerun', ...info, pass }));
  cdp.close();
})().catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
