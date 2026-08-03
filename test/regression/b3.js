// B3 会话历史与恢复:杀应用 → 重启 → 历史重放 → 继续对话
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CDP, sleep } = require('./cdp');
const sid = JSON.parse(fs.readFileSync(path.join(__dirname, '.reg-sid.json'), 'utf8')).sid;

(async () => {
  // 1. 杀掉应用
  try { execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' }); } catch {}
  await sleep(2500);

  // 2. 重启(带调试端口)
  const electron = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'electron.cmd');
  const child = spawn(electron, ['.', '--remote-debugging-port=9222'], {
    cwd: path.join(__dirname, '..', '..'),
    detached: true, stdio: 'ignore', shell: true,
  });
  child.unref();

  // 3. 等 CDP 就绪,验证历史重放
  const cdp = await new CDP().connect();
  await cdp.waitFor(`document.body.textContent.includes('REG-B1')`, 40000);
  await sleep(2500); // 等会话恢复渲染
  const msgInfo = await cdp.eval(`(() => {
    const m = document.querySelector('#messages');
    return { text: (m ? m.textContent : ''), cards: document.querySelectorAll('.perm-card').length };
  })()`);
  const historyReplayed = msgInfo.text.includes('DONE') || msgInfo.cards > 0;

  // 4. 重启后继续对话,上下文应保留(SDK resume)
  await cdp.tapEvents();
  const prevResults = await cdp.resultCount(sid);
  await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '我们之前在做一个权限测试,你还记得被改成 line2 的文件名吗?只回答文件名,然后另起一行回复 REG_B3_OK')`);
  await cdp.waitIdle(sid, prevResults, 150000);
  const evs = await cdp.events();
  const results = evs.filter((p) => p.sid === sid && p.ev.type === 'result');
  const last = results[results.length - 1];
  const assistants = evs.filter((p) => p.sid === sid && p.ev.type === 'assistant');
  const lastText = assistants.length ? JSON.stringify(assistants[assistants.length - 1].ev.message.content) : '';
  const resumeKept = lastText.includes('edit-me.txt');
  const ok = last && !last.ev.is_error;
  console.log(JSON.stringify({ step: 'b3', historyReplayed, permCards: msgInfo.cards, continueOk: !!ok, contextKeptAfterRestart: resumeKept, lastAssistant: lastText.slice(0, 150), pass: historyReplayed && !!ok }));
  cdp.close();
})().catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
