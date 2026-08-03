// 批次1:B2 中断不销毁会话 / B4 多会话并行 / B5 运行中追加消息 / B6 模式下拉
// 用法: node test/regression/b2-6.js <b2|b3-prepare|b4|b5|b6>
const fs = require('fs');
const path = require('path');
const { CDP, sleep } = require('./cdp');
const WS_DIR = path.join(process.env.TEMP, 'claude-ui-reg');
const SID_FILE = path.join(__dirname, '.reg-sid.json');
const loadSids = () => JSON.parse(fs.readFileSync(SID_FILE, 'utf8'));
const saveSids = (o) => fs.writeFileSync(SID_FILE, JSON.stringify({ ...loadSids(), ...o }));

async function main(step) {
  const cdp = await new CDP().connect();
  await cdp.tapEvents();
  const { sid } = loadSids();

  if (step === 'b2') {
    // 中断不销毁会话:长输出中途 interrupt,随后会话仍能正常对话
    const prevResults = await cdp.resultCount(sid);
    await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '从 1 数到 300,每个数字单独一行,不要解释')`);
    await cdp.waitFor(`(window.__regEvents||[]).some((p) => p.sid === ${JSON.stringify(sid)} && p.ev.type === 'stream_event')`, 60000);
    await sleep(4000); // 让它输出一段
    await cdp.eval(`api.sessInterrupt(${JSON.stringify(sid)})`);
    await cdp.waitIdle(sid, prevResults, 60000);
    // 会话应仍存活:再发一条消息能正常完成
    const prev2 = await cdp.resultCount(sid);
    await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '只回复 REG_B2_OK 六个字符')`);
    await cdp.waitIdle(sid, prev2, 120000);
    const evs = await cdp.events();
    const results = evs.filter((p) => p.sid === sid && p.ev.type === 'result');
    const last = results[results.length - 1];
    const assistants = evs.filter((p) => p.sid === sid && p.ev.type === 'assistant');
    const lastText = JSON.stringify(assistants[assistants.length - 1].ev.message.content).slice(0, 100);
    const ok = last && !last.ev.is_error;
    console.log(JSON.stringify({ step, interrupted: true, sessionAliveAfterInterrupt: !!ok, lastAssistant: lastText, pass: !!ok }));
    return cdp.close();
  }

  if (step === 'b4') {
    // 多会话并行:新会话记住暗号,老会话不应知道(上下文隔离)
    const meta = await cdp.eval(`api.sessCreate({ cwd: ${JSON.stringify(WS_DIR)}, permissionMode: 'default', title: 'REG-B4' })`);
    saveSids({ sidB4: meta.id });
    const sdkB1 = (await cdp.eval(`api.sessList()`)).find((m) => m.id === sid).sdkSessionId;
    const sdkB4 = meta.sdkSessionId;
    // 在 B4 里存暗号
    const prevB4 = await cdp.resultCount(meta.id);
    await cdp.eval(`api.sessSend(${JSON.stringify(meta.id)}, '记住暗号 ALPHA-771,只回复"记住了"')`);
    await cdp.waitIdle(meta.id, prevB4, 120000);
    // 在 B1 里问暗号(它从未听过)
    const prevB1 = await cdp.resultCount(sid);
    await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '我在另一个会话里告诉你一个暗号,是什么?只回答暗号本身,不知道就回答"不知道"')`);
    await cdp.waitIdle(sid, prevB1, 120000);
    const evs = await cdp.events();
    const b1Assist = evs.filter((p) => p.sid === sid && p.ev.type === 'assistant').slice(-1)[0];
    const b1Text = JSON.stringify(b1Assist.ev.message.content);
    const leaks = b1Text.includes('ALPHA-771');
    console.log(JSON.stringify({ step, sdkDifferent: sdkB1 !== sdkB4, isolationHolds: !leaks, pass: sdkB1 !== sdkB4 && !leaks }));
    return cdp.close();
  }

  if (step === 'b5') {
    // 运行中追加消息:长任务进行中再发一条,应排队注入不打断
    const prevResults = await cdp.resultCount(sid);
    await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '从 1 数到 100,每个数字一行,数完后停下')`);
    await cdp.waitFor(`(window.__regEvents||[]).some((p) => p.sid === ${JSON.stringify(sid)} && p.ev.type === 'stream_event')`, 60000);
    await sleep(2500);
    // 回合进行中追加消息(B5 的核心)
    const sentMid = await cdp.eval(`api.sessSend(${JSON.stringify(sid)}, '补充:数完后额外加一行 REG_B5_TAIL')`);
    const evs1 = await cdp.events();
    const midQueued = evs1.some((p) => p.sid === sid && p.ev.type === 'user' && JSON.stringify(p.ev.message).includes('REG_B5_TAIL'));
    await cdp.waitIdle(sid, prevResults, 180000);
    const results = (await cdp.events()).filter((p) => p.sid === sid && p.ev.type === 'result');
    const last = results[results.length - 1];
    console.log(JSON.stringify({ step, midSendAccepted: !!sentMid, midMessageQueued: midQueued, turnCompleted: !!last, noError: last && !last.ev.is_error, pass: !!sentMid && midQueued && !!last && !last.ev.is_error }));
    return cdp.close();
  }

  if (step === 'b6') {
    // 权限模式下拉:应含全部 SDK 模式,无 Auto
    const opts = await cdp.eval(`[...document.querySelectorAll('#perm-mode option')].map((o) => o.value)`);
    const need = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];
    const pass = need.every((v) => opts.includes(v)) && !opts.includes('auto');
    console.log(JSON.stringify({ step, options: opts, pass }));
    return cdp.close();
  }

  throw new Error('unknown step: ' + step);
}

main(process.argv[2]).catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
