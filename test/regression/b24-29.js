// 批次5:B24 Side chat / B25 重命名归档筛选 / B26 OS 通知(sess:attention)/ B27 定时任务 / B28 MCP 管理 / B29 自动更新
// 用法: node test/regression/b24-29.js <b24|b25|b26|b27|b28|b29>
const fs = require('fs');
const path = require('path');
const { CDP, sleep } = require('./cdp');
const WS_DIR = path.join(process.env.TEMP, 'drafter-reg');
const sid = JSON.parse(fs.readFileSync(path.join(__dirname, '.reg-sid.json'), 'utf8')).sid;
const sidFile = (id) => path.join(process.env.APPDATA, 'claude-ui', 'sessions', id + '.jsonl');

async function approveUntilResult(cdp, targetSid, prevResults, timeoutMs = 260000) {
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const evs = await cdp.events();
    const done = new Set(evs.filter((p) => p.ev.type === 'ui_permission_done').map((p) => p.ev.reqId));
    const pending = evs.filter((p) => p.ev.type === 'ui_permission' && !done.has(p.ev.reqId) && !seen.has(p.ev.reqId));
    for (const p of pending) {
      seen.add(p.ev.reqId);
      await cdp.eval(`(() => { const b = document.querySelector('.perm-card[data-req-id="${p.ev.reqId}"] button[data-d="allow"]'); if (b) b.click(); })()`);
    }
    const finished = evs.filter((p) => p.sid === targetSid && p.ev.type === 'result').length > prevResults;
    if (finished && !pending.length) return true;
    await sleep(1200);
  }
  return false;
}

async function lastText(cdp, targetSid) {
  const evs = await cdp.events();
  const a = evs.filter((p) => p.sid === targetSid && p.ev.type === 'assistant').slice(-1)[0];
  return a ? (a.ev.message.content || []).map((b) => b.text || '').join(' ') : '';
}

async function main(step) {
  const cdp = await new CDP().connect();
  await cdp.tapEvents();

  if (step === 'b24') {
    const main0 = (await cdp.eval(`api.sessList()`)).find((m) => m.id === sid);
    const side = await cdp.eval(`api.sessCreate({
      cwd: ${JSON.stringify(WS_DIR)}, permissionMode: 'default',
      title: 'REG-B1 · side', parentId: ${JSON.stringify(sid)},
      forkFrom: ${JSON.stringify(main0.sdkSessionId || null)},
      projectId: ${JSON.stringify(main0.projectId || null)},
    })`);
    // fork 上下文:支线应知道主线的事
    let prev = 0;
    await cdp.eval(`api.sessSend(${JSON.stringify(side.id)}, '我们之前在权限测试里把一个文件从 line1 改成 line2,文件名是什么?只回答文件名')`);
    await approveUntilResult(cdp, side.id, prev, 240000);
    const knows = (await lastText(cdp, side.id)).includes('edit-me.txt');
    // 支线内容不污染主线:在支线里留暗号
    await cdp.eval(`api.sessSend(${JSON.stringify(side.id)}, '记住支线暗号 SIDE-999,只回复"记住了"')`);
    await approveUntilResult(cdp, side.id, 1, 240000);
    await sleep(800);
    const mainLog = fs.existsSync(sidFile(sid)) ? fs.readFileSync(sidFile(sid), 'utf8') : '';
    const notPolluted = !mainLog.includes('SIDE-999');
    console.log(JSON.stringify({ step, sideId: side.id, parentId: side.parentId, forkKnowsMain: knows, mainNotPolluted: notPolluted, pass: side.parentId === sid && knows && notPolluted }));
    return cdp.close();
  }

  if (step === 'b25') {
    await cdp.eval(`api.sessRename(${JSON.stringify(sid)}, 'REG-B1-RENAMED')`);
    await sleep(600);
    const renamed = (await cdp.eval(`api.sessList()`)).find((m) => m.id === sid).title === 'REG-B1-RENAMED';
    // 归档 REG-B4(不影响主线会话)
    const sids = JSON.parse(fs.readFileSync(path.join(__dirname, '.reg-sid.json'), 'utf8'));
    await cdp.eval(`api.sessArchive(${JSON.stringify(sids.sidB4)}, true)`);
    await sleep(600);
    const archived = (await cdp.eval(`api.sessList()`)).find((m) => m.id === sids.sidB4).archived === true;
    // 侧边栏筛选:勾选「已归档」应显示归档会话
    const cbState = await cdp.eval(`(() => {
      const cb = [...document.querySelectorAll('#sidebar input[type="checkbox"]')].find((x) => x.parentElement.textContent.includes('已归档'));
      if (!cb) return { found: false };
      const before = document.querySelectorAll('li.session-item').length;
      cb.click();
      return { found: true, before };
    })()`);
    await sleep(1000);
    const withArchived = await cdp.eval(`({
      count: document.querySelectorAll('li.session-item').length,
      hasB4: !!document.querySelector('#sidebar') && document.querySelector('#sidebar').textContent.includes('REG-B4'),
    })`);
    const pass = renamed && archived && cbState.found && withArchived.hasB4 && withArchived.count > cbState.before;
    console.log(JSON.stringify({ step, renamed, archived, filterFound: cbState.found, beforeCount: cbState.before, afterCount: withArchived.count, archivedShown: withArchived.hasB4, pass }));
    return cdp.close();
  }

  if (step === 'b26') {
    // 非当前会话完成任务 → sess:attention 事件(应用层通知证据;OS 弹窗不可自动观测)
    await cdp.eval(`window.__regAttn = []; api.on('sess:attention', (p) => window.__regAttn.push(p));`);
    const sids = JSON.parse(fs.readFileSync(path.join(__dirname, '.reg-sid.json'), 'utf8'));
    await cdp.eval(`api.sessSetActive(${JSON.stringify(sids.sidB4)})`); // 把"当前会话"切到 B4
    const prev = await cdp.resultCount(sid);
    await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '只回复 REG_B26_OK 六个字符')`); // 在非当前会话 B1 里跑
    await approveUntilResult(cdp, sid, prev, 180000);
    await sleep(1500);
    const attn = await cdp.eval(`window.__regAttn`);
    const got = attn.some((p) => p.sid === sid);
    await cdp.eval(`api.sessSetActive(${JSON.stringify(sid)})`); // 还原
    console.log(JSON.stringify({ step, attentionEvent: got, attnCount: attn.length, pass: got, note: 'OS 弹窗本身不可自动观测,以 sess:attention 为证据' }));
    return cdp.close();
  }

  if (step === 'b27') {
    const jobs0 = await cdp.eval(`api.cronList()`);
    const sess0 = (await cdp.eval(`api.sessList()`)).length;
    await cdp.eval(`window.__regCron = []; api.on('cron:fired', (p) => window.__regCron.push(p));`);
    await cdp.eval(`api.cronSave({ id: 'reg-cron-1', label: '回归测试任务', prompt: '只回复 REG_B27_OK 六个字符', cwd: ${JSON.stringify(WS_DIR)}, everyMinutes: 1, enabled: true })`);
    let fired = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 200000) {
      const f = await cdp.eval(`window.__regCron.length`);
      if (f > 0) { fired = true; break; }
      await sleep(4000);
    }
    await sleep(2000);
    const sess1 = (await cdp.eval(`api.sessList()`)).length;
    await cdp.eval(`api.cronDelete('reg-cron-1')`);
    const jobs1 = await cdp.eval(`api.cronList()`);
    const pass = fired && sess1 > sess0 && !jobs1.some((j) => j.id === 'reg-cron-1');
    console.log(JSON.stringify({ step, fired, sessionsBefore: sess0, sessionsAfter: sess1, jobDeleted: !jobs1.some((j) => j.id === 'reg-cron-1'), pass }));
    return cdp.close();
  }

  if (step === 'b28') {
    const cfgPath = path.join(process.env.USERPROFILE, '.claude.json');
    const backup = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : null;
    try {
      await cdp.eval(`api.mcpSave({ cwd: ${JSON.stringify(WS_DIR)}, scope: 'global', name: 'reg-mcp', config: { command: 'cmd.exe', args: ['/c', 'echo', 'hi'] } })`);
      await sleep(600);
      const after1 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const added = !!(after1.mcpServers && after1.mcpServers['reg-mcp']);
      await cdp.eval(`api.mcpDelete({ cwd: ${JSON.stringify(WS_DIR)}, scope: 'global', name: 'reg-mcp' })`);
      await sleep(600);
      const after2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const removed = !(after2.mcpServers && after2.mcpServers['reg-mcp']);
      console.log(JSON.stringify({ step, added, removed, pass: added && removed }));
    } finally {
      if (backup != null) fs.writeFileSync(cfgPath, backup); // 还原用户配置
    }
    return cdp.close();
  }

  if (step === 'b29') {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    const publishOk = pkg.build && pkg.build.publish && pkg.build.publish.provider === 'github';
    const updaterExists = fs.existsSync(path.join(__dirname, '..', '..', 'src', 'main', 'updater.js'));
    const latestYml = fs.existsSync(path.join(__dirname, '..', '..', 'dist', 'latest.yml'));
    // dev 环境手动触发一次检查:应静默失败不抛错
    const silent = await cdp.eval(`api.updateCheck().then(() => true).catch(() => false)`);
    const pass = publishOk && updaterExists && latestYml && silent;
    console.log(JSON.stringify({ step, publishOk, updaterExists, latestYml, devCheckSilent: silent, pass }));
    return cdp.close();
  }

  throw new Error('unknown step: ' + step);
}

main(process.argv[2]).catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
