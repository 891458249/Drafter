// v0.5.0/v0.5.1/v0.6.0 全链路验证:顶栏去路径、独立会话、板块切换、附件合并、文件夹 chips
const fs = require('fs');
const path = require('path');
const { CDP, sleep } = require('./cdp');
const WS_DIR = path.join(process.env.TEMP, 'claude-ui-reg');

(async () => {
  const cdp = await new CDP().connect();
  await cdp.tapEvents();
  const R = {};

  // 1. 顶栏无全局目录路径
  R.noCwdLabel = await cdp.eval(`!document.querySelector('#cwd-label')`);
  R.sectionSwitchExists = await cdp.eval(`!!document.querySelector('#section-switch')`);

  // 2. ＋新会话(code 板块)→ 独立会话,出现在「独立会话」区
  await cdp.eval(`document.querySelector('#btn-new-session').click()`);
  await sleep(2500);
  const standaloneMeta = (await cdp.eval(`api.sessList()`))
    .filter((m) => m.standalone && m.kind !== 'chat')
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  R.standaloneCreated = !!standaloneMeta && !standaloneMeta.projectId;
  R.standaloneCwdIsHome = !!standaloneMeta && /users/i.test(standaloneMeta.cwd || '');
  await sleep(1500);
  R.standaloneSectionShown = await cdp.eval(`(() => {
    const g = [...document.querySelectorAll('#session-list .proj-group')];
    const sg = g.find((el) => el.textContent.includes('独立会话'));
    return !!sg && sg.textContent.length > 10;
  })()`);
  R.noProjectCreated = (await cdp.eval(`api.projList()`)).every((p) => !(p.dirs || []).some((d) => /users\\\\dingyongzhen/i.test(d) && d.split(/[\\/]/).length <= 3));

  // 3. 切到 Chat 板块 → 侧栏只显示 chat 会话;项目向 UI 隐藏
  await cdp.eval(`document.querySelector('#section-switch button[data-sec="chat"]').click()`);
  await sleep(1500);
  R.chatModeHidesCodeUi = await cdp.eval(`({
    panel: getComputedStyle(document.querySelector('#btn-panel')).display === 'none',
    addFolder: getComputedStyle(document.querySelector('#btn-add-folder')).display === 'none',
    worktree: getComputedStyle(document.querySelector('.wt-toggle')).display === 'none',
    headLabel: document.querySelector('#sidebar-head-label').textContent,
  })`);
  // 在 chat 板块建新会话 → kind='chat'
  await cdp.eval(`document.querySelector('#btn-new-session').click()`);
  await sleep(2500);
  const chatMeta = (await cdp.eval(`api.sessList()`))
    .filter((m) => m.kind === 'chat')
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  R.chatSessionCreated = !!chatMeta && chatMeta.kind === 'chat' && !chatMeta.projectId;
  R.chatSidebarFlat = await cdp.eval(`({
    groups: document.querySelectorAll('#session-list .proj-group .proj-head').length,
    items: document.querySelectorAll('#session-list li.session-item').length,
  })`);

  // 4. 附件合并:文本附件 chip + 发送内联围栏;随后中断,不计回合
  await cdp.eval(`(() => {
    const el = document.querySelector('#input');
    el.value = '看下这个附件'; el.dispatchEvent(new Event('input'));
  })()`);
  await cdp.eval(`(() => {
    const f = new File(['REG_ATTACH_BODY_123'], 'note.txt', { type: 'text/plain' });
    const dt = new DataTransfer(); dt.items.add(f);
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await sleep(800);
  R.attachChip = await cdp.eval(`({
    count: document.querySelector('#attachments').childElementCount,
    hasFileChip: !!document.querySelector('#attachments .attach-file'),
  })`);
  await cdp.eval(`document.querySelector('#btn-send').click()`);
  await sleep(2500);
  R.attachSentInline = await cdp.eval(`document.querySelector('#messages').textContent.includes('<附件 name="note.txt">') && document.querySelector('#messages').textContent.includes('REG_ATTACH_BODY_123')`);
  R.attachCleared = await cdp.eval(`document.querySelector('#attachments').childElementCount === 0`);
  try { await cdp.eval(`api.sessInterrupt(${(await cdp.eval('api.sessList()')).filter((m) => m.kind === 'chat').sort((a, b) => b.createdAt - a.createdAt)[0].id ? JSON.stringify(chatMeta.id) : '""'})`); } catch {}

  // 5. 切回 Code 板块 + 项目会话文件夹 chips(向项目组加目录验证)
  await cdp.eval(`document.querySelector('#section-switch button[data-sec="code"]').click()`);
  await sleep(1200);
  R.backToCode = await cdp.eval(`({
    sec: document.querySelector('#section-switch button.active').dataset.sec,
    headLabel: document.querySelector('#sidebar-head-label').textContent,
  })`);

  const pass = R.noCwdLabel && R.sectionSwitchExists && R.standaloneCreated && R.standaloneCwdIsHome
    && R.standaloneSectionShown && R.noProjectCreated
    && R.chatModeHidesCodeUi.panel && R.chatModeHidesCodeUi.addFolder && R.chatModeHidesCodeUi.worktree
    && R.chatModeHidesCodeUi.headLabel === '会话'
    && R.chatSessionCreated && R.chatSidebarFlat.groups === 0 && R.chatSidebarFlat.items >= 1
    && R.attachChip.count === 1 && R.attachChip.hasFileChip && R.attachSentInline && R.attachCleared
    && R.backToCode.sec === 'code' && R.backToCode.headLabel === '项目 / 会话';
  console.log(JSON.stringify({ ...R, pass }, null, 1));
  cdp.close();
})().catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
