// 批次4:B16 面板布局 / B17 文件编辑器 / B18 预览面板 / B19 任务面板 / B20 视图模式 / B21 用量+compact / B22 快捷键 / B23 多终端
// 用法: node test/regression/b16-23.js <b16|b17|b18|b19|b20|b21|b22|b23>
const fs = require('fs');
const path = require('path');
const { CDP, sleep } = require('./cdp');
const WS_DIR = path.join(process.env.TEMP, 'claude-ui-reg');
const sid = JSON.parse(fs.readFileSync(path.join(__dirname, '.reg-sid.json'), 'utf8')).sid;

async function ensurePanelOpen(cdp) {
  await cdp.eval(`(() => { const rp = document.querySelector('#right-panel'); if (rp.classList.contains('hidden')) document.querySelector('#btn-panel').click(); })()`);
  await sleep(300);
}
async function switchTab(cdp, name) {
  await cdp.eval(`document.querySelector('.ptab[data-panel="${name}"]').click()`);
  await sleep(300);
}
async function approveUntilResult(cdp, prevResults, timeoutMs = 260000) {
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
    const finished = evs.filter((p) => p.sid === sid && p.ev.type === 'result').length > prevResults;
    if (finished && !pending.length) return true;
    await sleep(1200);
  }
  return false;
}

async function main(step) {
  const cdp = await new CDP().connect();
  await cdp.tapEvents();

  if (step === 'b16') {
    await ensurePanelOpen(cdp);
    const results = {};
    for (const name of ['diff', 'editor', 'preview', 'tasks', 'terminal']) {
      await switchTab(cdp, name);
      results[name] = await cdp.eval(`document.querySelector('#panel-${name}').classList.contains('active')`);
    }
    // 显隐切换
    await cdp.eval(`document.querySelector('#btn-panel-close').click()`);
    await sleep(300);
    const hiddenOk = await cdp.eval(`document.querySelector('#right-panel').classList.contains('hidden')`);
    await cdp.eval(`document.querySelector('#btn-panel').click()`);
    await sleep(300);
    const reopenOk = await cdp.eval(`!document.querySelector('#right-panel').classList.contains('hidden')`);
    const tabsOk = Object.values(results).every(Boolean);
    console.log(JSON.stringify({ step, tabs: results, closeOk: hiddenOk, reopenOk, pass: tabsOk && hiddenOk && reopenOk, note: '无独立分栏拖拽手柄,未测拖拽' }));
    return cdp.close();
  }

  if (step === 'b17') {
    // 点击对话中的文件路径打开编辑器
    const clicked = await cdp.eval(`(() => {
      const codes = [...document.querySelectorAll('#messages code')];
      const c = codes.find((x) => x.textContent.trim() === 'edit-me.txt');
      if (!c) return false; c.click(); return true;
    })()`);
    await sleep(1200);
    const opened = await cdp.eval(`({
      path: document.querySelector('#editor-path').textContent,
      enabled: !document.querySelector('#editor-area').disabled,
      content: document.querySelector('#editor-area').value,
    })`);
    // 修改并保存
    const target = path.join(WS_DIR, 'edit-me.txt');
    await cdp.eval(`(() => {
      const a = document.querySelector('#editor-area');
      a.value = a.value + '\\neditor-added';
      a.dispatchEvent(new Event('input'));
    })()`);
    await sleep(300);
    await cdp.eval(`document.querySelector('#btn-editor-save').click()`);
    await sleep(800);
    const saved = fs.readFileSync(target, 'utf8').includes('editor-added');
    // 外部修改 → 再保存应报冲突
    fs.writeFileSync(target, 'external-change\n');
    await cdp.eval(`document.querySelector('#btn-editor-save').click()`);
    await sleep(800);
    const warning = await cdp.eval(`({
      visible: !document.querySelector('#editor-warning').classList.contains('hidden'),
      text: document.querySelector('#editor-warning').textContent.slice(0, 80),
    })`);
    console.log(JSON.stringify({ step, pathClicked: clicked, opened: opened.enabled && opened.content.includes('line2'), saved, conflictWarned: warning.visible, warnText: warning.text,
      pass: clicked && opened.enabled && saved && warning.visible }));
    return cdp.close();
  }

  if (step === 'b18') {
    await ensurePanelOpen(cdp);
    await switchTab(cdp, 'preview');
    // localhost 直接加载
    await cdp.eval(`(() => {
      const u = document.querySelector('#preview-url');
      u.value = 'http://localhost:8799/a.txt';
    })()`);
    await cdp.eval(`document.querySelector('#btn-preview-go').click()`);
    await sleep(2500);
    const localOk = await cdp.eval(`!!document.querySelector('#preview-host webview')`);
    // 外部站点:拦截 confirm 验证确认门
    await cdp.eval(`window.__confirmSeen = null; window.confirm = (m) => { window.__confirmSeen = m; return false; };`);
    await cdp.eval(`(() => { document.querySelector('#preview-url').value = 'https://example.com'; })()`);
    await cdp.eval(`document.querySelector('#btn-preview-go').click()`);
    await sleep(800);
    const confirmSeen = await cdp.eval(`window.__confirmSeen`);
    const stillLocal = await cdp.eval(`(document.querySelector('#preview-host webview')||{}).src || ''`);
    const pass = localOk && !!confirmSeen && confirmSeen.includes('example.com') && !stillLocal.includes('example.com');
    console.log(JSON.stringify({ step, localWebview: localOk, confirmShown: !!confirmSeen, externalBlockedOnCancel: !stillLocal.includes('example.com'), pass }));
    return cdp.close();
  }

  if (step === 'b19') {
    const prevResults = await cdp.resultCount(sid);
    await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '请使用 Task 工具派一个子代理计算 3+4 并回报结果,不要自己算')`);
    await approveUntilResult(cdp, prevResults, 260000);
    await ensurePanelOpen(cdp);
    await switchTab(cdp, 'tasks');
    await sleep(800);
    const tasks = await cdp.eval(`({
      items: document.querySelectorAll('#panel-tasks .task-item').length,
      text: (document.querySelector('#panel-tasks')||{textContent:''}).textContent.slice(0, 150),
    })`);
    // 对话中子代理应按 parent_tool_use_id 归组
    const grouped = await cdp.eval(`document.querySelectorAll('#messages .task-group, #messages .subagent-group').length`);
    const pass = tasks.items >= 1;
    console.log(JSON.stringify({ step, taskItems: tasks.items, panelText: tasks.text, chatGroups: grouped, pass }));
    return cdp.close();
  }

  if (step === 'b20') {
    const before = await cdp.eval(`document.querySelector('#messages').className`);
    await cdp.eval(`(() => { const v = document.querySelector('#view-mode'); v.value = 'verbose'; v.dispatchEvent(new Event('change')); })()`);
    await sleep(400);
    const verbose = await cdp.eval(`({
      cls: document.querySelector('#messages').classList.contains('mode-verbose'),
      collapsed: document.querySelectorAll('#messages .tool-body.collapsed').length,
    })`);
    await cdp.eval(`(() => { const v = document.querySelector('#view-mode'); v.value = 'summary'; v.dispatchEvent(new Event('change')); })()`);
    await sleep(400);
    const summary = await cdp.eval(`({
      cls: document.querySelector('#messages').classList.contains('mode-summary'),
      collapsed: document.querySelectorAll('#messages .tool-body.collapsed').length,
    })`);
    await cdp.eval(`(() => { const v = document.querySelector('#view-mode'); v.value = 'normal'; v.dispatchEvent(new Event('change')); })()`);
    const pass = verbose.cls && summary.cls && summary.collapsed >= verbose.collapsed;
    console.log(JSON.stringify({ step, verbose, summary, pass }));
    return cdp.close();
  }

  if (step === 'b21') {
    const chip = await cdp.eval(`document.querySelector('#usage-chip').textContent`);
    await cdp.eval(`document.querySelector('#btn-usage').click()`);
    await sleep(800);
    const pop = await cdp.eval(`({
      visible: !document.querySelector('#usage-pop').classList.contains('hidden'),
      hasCtx: document.querySelector('#usage-pop').textContent.includes('上下文窗口'),
      hasModel: /Fable/.test(document.querySelector('#usage-pop').textContent),
      ctxPct: document.querySelector('#btn-usage-label').textContent,
    })`);
    await cdp.eval(`document.querySelector('#btn-usage').click()`); // 关掉弹层
    // /compact
    const prevResults = await cdp.resultCount(sid);
    await cdp.eval(`document.querySelector('#btn-compact').click()`);
    let compactSeen = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      const evs = await cdp.events();
      if (evs.some((p) => p.sid === sid && p.ev.type === 'ui_compact')) { compactSeen = true; break; }
      if (evs.filter((p) => p.sid === sid && p.ev.type === 'result').length > prevResults) break;
      await sleep(1500);
    }
    const metaLine = await cdp.eval(`document.querySelector('#messages').textContent.includes('上下文已压缩')`);
    console.log(JSON.stringify({ step, chip, ...pop, compactEvent: compactSeen, metaLine, pass: pop.visible && pop.hasCtx && pop.hasModel && (compactSeen || metaLine) }));
    return cdp.close();
  }

  if (step === 'b22') {
    const key = (k) => `document.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', ctrlKey: true, bubbles: true }))`;
    const esc = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`;
    const r = {};
    await cdp.eval(key('/'));
    r.shortcutsShown = await cdp.eval(`!document.querySelector('#shortcuts-modal').classList.contains('hidden')`);
    await cdp.eval(esc);
    r.escCloses = await cdp.eval(`document.querySelector('#shortcuts-modal').classList.contains('hidden')`);
    const sbBefore = await cdp.eval(`document.querySelector('#sidebar').classList.contains('collapsed')`);
    await cdp.eval(key('b'));
    r.ctrlB = (await cdp.eval(`document.querySelector('#sidebar').classList.contains('collapsed')`)) !== sbBefore;
    await cdp.eval(key('b')); // 还原
    const sessBefore = (await cdp.eval(`api.sessList()`)).length;
    await cdp.eval(key('n'));
    await sleep(1500);
    const sessAfter = (await cdp.eval(`api.sessList()`)).length;
    r.ctrlN = sessAfter === sessBefore + 1;
    await cdp.eval(key('j'));
    await sleep(300);
    r.ctrlJ = await cdp.eval(`!document.querySelector('#right-panel').classList.contains('hidden')`);
    await cdp.eval(key('1'));
    await sleep(300);
    r.ctrl1 = await cdp.eval(`document.querySelector('#panel-diff').classList.contains('active')`);
    const pass = r.shortcutsShown && r.escCloses && r.ctrlB && r.ctrlN && r.ctrlJ && r.ctrl1;
    console.log(JSON.stringify({ step, ...r, pass }));
    return cdp.close();
  }

  if (step === 'b23') {
    await ensurePanelOpen(cdp);
    await switchTab(cdp, 'terminal');
    await cdp.eval(`document.querySelector('#btn-term-new').click()`);
    await sleep(4000);
    const tabs1 = await cdp.eval(`document.querySelectorAll('#term-tabs .term-tab').length`);
    await cdp.eval(`document.querySelector('#btn-term-new').click()`);
    await sleep(4000);
    const tabs2 = await cdp.eval(`document.querySelectorAll('#term-tabs .term-tab').length`);
    // 切换标签
    await cdp.eval(`document.querySelectorAll('#term-tabs .term-tab')[0].click()`);
    await sleep(400);
    const activeFirst = await cdp.eval(`document.querySelectorAll('#term-tabs .term-tab')[0].classList.contains('active')`);
    // 关闭一个
    await cdp.eval(`document.querySelectorAll('#term-tabs .term-tab .x')[1].click()`);
    await sleep(600);
    const tabs3 = await cdp.eval(`document.querySelectorAll('#term-tabs .term-tab').length`);
    // pty 独立性(API 层双 cmd 终端互发标记)
    await cdp.eval(`window.__regTerm = []; api.on('term:data', (p) => window.__regTerm.push(p));`);
    const t1 = await cdp.eval(`api.termOpen({ cwd: ${JSON.stringify(WS_DIR)}, cols: 80, rows: 24, command: 'cmd.exe' })`);
    const t2 = await cdp.eval(`api.termOpen({ cwd: ${JSON.stringify(WS_DIR)}, cols: 80, rows: 24, command: 'cmd.exe' })`);
    await sleep(1500);
    await cdp.eval(`api.termInput(${JSON.stringify(t1.id || t1)}, 'echo REG_T_A\\r')`);
    await cdp.eval(`api.termInput(${JSON.stringify(t2.id || t2)}, 'echo REG_T_B\\r')`);
    await sleep(2000);
    const termData = await cdp.eval(`JSON.stringify(window.__regTerm)`);
    const indep = termData.includes('REG_T_A') && termData.includes('REG_T_B');
    await cdp.eval(`api.termClose(${JSON.stringify(t1.id || t1)})`);
    await cdp.eval(`api.termClose(${JSON.stringify(t2.id || t2)})`);
    const pass = tabs1 === 1 && tabs2 === 2 && activeFirst && tabs3 === 1 && indep;
    console.log(JSON.stringify({ step, tabs1, tabs2, activeFirst, tabs3, ptyIndependent: indep, pass }));
    return cdp.close();
  }

  throw new Error('unknown step: ' + step);
}

main(process.argv[2]).catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
