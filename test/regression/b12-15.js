// 批次3:B12 @文件补全 / B13 图片粘贴+拖拽 / B14 斜杠命令 / B15 Plan 模式审批
// 用法: node test/regression/b12-15.js <b12|b13|b14|b15>
const fs = require('fs');
const path = require('path');
const { CDP, sleep } = require('./cdp');
const WS_DIR = path.join(process.env.TEMP, 'claude-ui-reg');
const sid = JSON.parse(fs.readFileSync(path.join(__dirname, '.reg-sid.json'), 'utf8')).sid;

async function typeInInput(cdp, text) {
  await cdp.eval(`(() => {
    const el = document.querySelector('#input');
    el.focus();
    el.value = ${JSON.stringify(text)};
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(800);
}

async function acState(cdp) {
  return cdp.eval(`({
    visible: !document.querySelector('#autocomplete').classList.contains('hidden'),
    items: [...document.querySelectorAll('#autocomplete .ac-item .ac-name')].map((x) => x.textContent),
  })`);
}

async function lastAssistantText(cdp) {
  const evs = await cdp.events();
  const a = evs.filter((p) => p.sid === sid && p.ev.type === 'assistant').slice(-1)[0];
  return a ? ((a.ev.message.content || []).map((b) => b.text || '').join(' ')) : '';
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

  if (step === 'b12') {
    await typeInInput(cdp, '@a');
    const ac = await acState(cdp);
    const hasTarget = ac.items.some((x) => x === 'a.txt');
    if (hasTarget) await cdp.eval(`(() => { const it = [...document.querySelectorAll('#autocomplete .ac-item')].find((x) => x.textContent.includes('a.txt')); it.click(); })()`);
    await sleep(400);
    const inserted = await cdp.eval(`document.querySelector('#input').value`);
    // 发送验证 Claude 能读到文件
    const prevResults = await cdp.resultCount(sid);
    await typeInInput(cdp, inserted + '这个文件的内容是什么?只回答内容本身');
    await cdp.eval(`document.querySelector('#btn-send').click()`);
    await approveUntilResult(cdp, prevResults, 180000);
    const answer = await lastAssistantText(cdp);
    const pass = ac.visible && hasTarget && inserted.includes('@a.txt') && answer.includes('hello');
    console.log(JSON.stringify({ step, acVisible: ac.visible, hasTarget, inserted, answer: answer.slice(0, 80), pass }));
    return cdp.close();
  }

  if (step === 'b13') {
    const b64 = fs.readFileSync(path.join(__dirname, '..', '..', 'build', 'icon.png')).toString('base64');
    // 粘贴一张
    await cdp.eval(`(() => {
      const bin = atob(${JSON.stringify(b64)});
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const f = new File([buf], 'icon.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(f);
      const el = document.querySelector('#input');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    await sleep(600);
    const afterPaste = await cdp.eval(`document.querySelector('#attachments').childElementCount`);
    // 拖拽一张
    await cdp.eval(`(() => {
      const bin = atob(${JSON.stringify(b64)});
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const f = new File([buf], 'icon2.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(f);
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    await sleep(600);
    const afterDrop = await cdp.eval(`({
      count: document.querySelector('#attachments').childElementCount,
      hidden: document.querySelector('#attachments').classList.contains('hidden'),
    })`);
    // 发送并验证视觉理解(图标:深色底 + 珊瑚色 CU 字母)
    const prevResults = await cdp.resultCount(sid);
    await typeInInput(cdp, '这两张图片(其实相同)的背景色和字母颜色分别是什么?一句话回答');
    await cdp.eval(`document.querySelector('#btn-send').click()`);
    await approveUntilResult(cdp, prevResults, 180000);
    const answer = await lastAssistantText(cdp);
    const mentionsDark = /深|黑|dark/i.test(answer);
    const mentionsCoral = /橙|珊瑚|橘|coral|orange/i.test(answer);
    console.log(JSON.stringify({ step, afterPaste, afterDrop, mentionsDark, mentionsCoral, answer: answer.slice(0, 120),
      pass: afterPaste === 1 && afterDrop.count === 2 && !afterDrop.hidden && mentionsDark && mentionsCoral }));
    return cdp.close();
  }

  if (step === 'b14') {
    await typeInInput(cdp, '/');
    const acAll = await acState(cdp);
    await typeInInput(cdp, '/reg');
    const acReg = await acState(cdp);
    const hasRegtest = acReg.items.some((x) => x.includes('regtest'));
    if (hasRegtest) await cdp.eval(`(() => { const it = [...document.querySelectorAll('#autocomplete .ac-item')].find((x) => x.textContent.includes('regtest')); it.click(); })()`);
    await sleep(400);
    const inserted = await cdp.eval(`document.querySelector('#input').value`);
    const prevResults = await cdp.resultCount(sid);
    await cdp.eval(`document.querySelector('#btn-send').click()`);
    await approveUntilResult(cdp, prevResults, 180000);
    const answer = await lastAssistantText(cdp);
    const pass = acAll.visible && acAll.items.length > 0 && hasRegtest && inserted.includes('/regtest') && answer.includes('REGCMD_OK');
    console.log(JSON.stringify({ step, allCount: acAll.items.length, sample: acAll.items.slice(0, 5), hasRegtest, inserted, answer: answer.slice(0, 80), pass }));
    return cdp.close();
  }

  if (step === 'b15') {
    await cdp.eval(`api.sessSetMode(${JSON.stringify(sid)}, 'plan')`);
    const prevResults = await cdp.resultCount(sid);
    await typeInInput(cdp, '我想给 a.txt 追加一行 world 并确认最终内容,请先制定计划');
    await cdp.eval(`document.querySelector('#btn-send').click()`);
    // 等 ExitPlanMode 审批卡(isPlan)
    const perm = await cdp.waitEvent(`(evs) => evs.find((p) => p.sid === ${JSON.stringify(sid)} && p.ev.type === 'ui_permission' && p.ev.isPlan)`, 240000);
    const req = perm.ev.reqId;
    await sleep(800);
    const card = await cdp.eval(`({
      isPlanCard: !!document.querySelector('.perm-card.plan-card[data-req-id="${req}"]'),
      hasPlanMd: !!document.querySelector('.perm-card[data-req-id="${req}"] .plan-md'),
      approveBtn: (document.querySelector('.perm-card[data-req-id="${req}"] button[data-d="allow"]')||{}).textContent,
    })`);
    await cdp.eval(`document.querySelector('.perm-card[data-req-id="${req}"] button[data-d="allow"]').click()`);
    await sleep(1500);
    const meta = (await cdp.eval(`api.sessList()`)).find((m) => m.id === sid);
    const modeSwitched = meta.permissionMode === 'acceptEdits';
    // 批准后应开始执行(可能有 Edit/Read 权限卡,循环批准)
    const finished = await approveUntilResult(cdp, prevResults, 240000);
    const aTxt = fs.readFileSync(path.join(WS_DIR, 'a.txt'), 'utf8');
    const pass = card.isPlanCard && card.hasPlanMd && modeSwitched && finished;
    console.log(JSON.stringify({ step, ...card, modeSwitched, executedToEnd: finished, aTxtHasWorld: aTxt.includes('world'), pass }));
    return cdp.close();
  }

  throw new Error('unknown step: ' + step);
}

main(process.argv[2]).catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
