// B1 权限确认 UI:拒绝 → 允许一次 → Edit 显示 diff(真实 UI 点击 + 事件断言)
// 用法: node test/regression/b1.js <create|deny-allow|edit>
const fs = require('fs');
const path = require('path');
const { CDP, sleep } = require('./cdp');

const WS_DIR = path.join(process.env.TEMP, 'drafter-reg');
const SID_FILE = path.join(__dirname, '.reg-sid.json');
const loadSid = () => JSON.parse(fs.readFileSync(SID_FILE, 'utf8')).sid;
const saveSid = (sid) => fs.writeFileSync(SID_FILE, JSON.stringify({ sid }));

async function main(step) {
  const cdp = await new CDP().connect();

  if (step === 'create') {
    const meta = await cdp.eval(`api.sessCreate({ cwd: ${JSON.stringify(WS_DIR)}, permissionMode: 'default', title: 'REG-B1' })`);
    saveSid(meta.id);
    // 刷新页面让 landing 自动恢复该会话(渲染端 ensureSession,权限卡才有 DOM 容器)
    await cdp.call('Page.reload');
    await sleep(4000);
    await cdp.tapEvents();
    await cdp.waitFor(`document.body.textContent.includes('REG-B1')`, 20000);
    console.log(JSON.stringify({ step, ok: true, sid: meta.id }));
    return cdp.close();
  }

  const sid = loadSid();
  await cdp.tapEvents();

  if (step === 'deny-allow') {
    // --- 第一轮:拒绝 ---
    await cdp.clearEvents();
    await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '这是权限测试。必须真实使用 PowerShell 工具执行命令: Set-Content -Path reg-b1.txt -Value REG_B1_RUN (它会写入一个新文件,不允许只在文字里假装执行)。工具跑完后只回复 DONE 两个字')`);
    const perm1 = await cdp.waitEvent(`(evs) => evs.find((p) => p.sid === ${JSON.stringify(sid)} && p.ev.type === 'ui_permission')`, 120000);
    const req1 = perm1.ev.reqId;
    await cdp.waitFor(`!!document.querySelector('.perm-card[data-req-id="${req1}"] button[data-d="deny"]')`, 10000);
    const r = { deny: {}, allow: {} };
    r.deny.cardShown = true;
    await cdp.eval(`document.querySelector('.perm-card[data-req-id="${req1}"] button[data-d="deny"]').click()`);
    await cdp.waitIdle(sid);
    r.deny.markedDenied = await cdp.eval(`document.querySelector('.perm-card[data-req-id="${req1}"] .perm-done')?.textContent.includes('已拒绝') || false`);
    const res1 = (await cdp.events()).filter((p) => p.sid === sid && p.ev.type === 'result');
    r.deny.turnEnded = res1.length >= 1;

    // --- 第二轮:允许一次 ---
    await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '再试一次:必须真实使用 PowerShell 工具执行命令 Set-Content -Path reg-b1.txt -Value REG_B1_RUN,工具跑完后只回复 DONE 两个字')`);
    const perm2 = await cdp.waitEvent(`(evs) => evs.find((p) => p.sid === ${JSON.stringify(sid)} && p.ev.type === 'ui_permission' && p.ev.reqId !== '${req1}')`, 120000);
    const req2 = perm2.ev.reqId;
    await cdp.eval(`document.querySelector('.perm-card[data-req-id="${req2}"] button[data-d="allow"]').click()`);
    await cdp.waitIdle(sid);
    r.allow.markedAllowed = await cdp.eval(`document.querySelector('.perm-card[data-req-id="${req2}"] .perm-done')?.textContent.includes('已允许') || false`);
    const res2 = (await cdp.events()).filter((p) => p.sid === sid && p.ev.type === 'result');
    r.allow.turnOk = res2.length >= 2 && !res2[res2.length - 1].ev.is_error;
    r.pass = r.deny.cardShown && r.deny.markedDenied && r.deny.turnEnded && r.allow.markedAllowed && r.allow.turnOk;
    console.log(JSON.stringify({ step, ...r }));
    return cdp.close();
  }

  if (step === 'edit') {
    // --- Edit 权限卡应显示行内 diff;批准后文件真正被修改 ---
    const target = path.join(WS_DIR, 'edit-me.txt');
    const before = fs.readFileSync(target, 'utf8');
    const prevResults = await cdp.resultCount(sid);
    await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '用 Edit 工具把 edit-me.txt 文件里的 line1 改成 line2,改完只回复 DONE 两个字')`);
    const perm = await cdp.waitEvent(`(evs) => evs.find((p) => p.sid === ${JSON.stringify(sid)} && p.ev.type === 'ui_permission' && (p.ev.toolName === 'Edit' || p.ev.toolName === 'Write'))`, 180000);
    const req = perm.ev.reqId;
    await sleep(800);
    const hasDiff = await cdp.eval(`!!document.querySelector('.perm-card[data-req-id="${req}"] .perm-diff')`);
    await cdp.eval(`document.querySelector('.perm-card[data-req-id="${req}"] button[data-d="allow"]').click()`);
    await cdp.waitIdle(sid, prevResults, 180000);
    const after = fs.readFileSync(target, 'utf8');
    const r = { hasDiff, fileChanged: before !== after && after.includes('line2'), pass: hasDiff && before !== after };
    console.log(JSON.stringify({ step, ...r }));
    return cdp.close();
  }

  throw new Error('unknown step: ' + step);
}

main(process.argv[2]).catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
