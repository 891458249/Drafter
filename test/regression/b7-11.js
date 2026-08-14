// 批次2:B7 Diff 视图 / B8 行内评论回传 / B9 Review code / B10 PR 监控(环境判定)/ B11 worktree 隔离
// 用法: node test/regression/b7-11.js <b7|b8|b9|b10|b11>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { CDP, sleep } = require('./cdp');
const WS_DIR = path.join(process.env.TEMP, 'drafter-reg');
const SID_FILE = path.join(__dirname, '.reg-sid.json');
const loadSids = () => JSON.parse(fs.readFileSync(SID_FILE, 'utf8'));

async function openDiffPanel(cdp) {
  await cdp.eval(`(() => {
    const rp = document.querySelector('#right-panel');
    if (rp.classList.contains('hidden')) document.querySelector('#btn-panel').click();
    document.querySelector('.ptab[data-panel="diff"]').click();
  })()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('#btn-diff-refresh').click()`);
  await sleep(1200);
}

async function main(step) {
  const cdp = await new CDP().connect();
  await cdp.tapEvents();
  const { sid } = loadSids();

  if (step === 'b7') {
    await openDiffPanel(cdp);
    const rows = await cdp.eval(`[...document.querySelectorAll('#diff-files .diff-file-row')].map((r) => r.textContent.trim())`);
    await cdp.eval(`(() => { const r = [...document.querySelectorAll('#diff-files .diff-file-row')].find((x) => x.textContent.includes('edit-me.txt')); if (r) r.click(); })()`);
    await sleep(1200);
    const view = await cdp.eval(`({
      adds: document.querySelectorAll('#diff-view .diff-line.add').length,
      dels: document.querySelectorAll('#diff-view .diff-line.del').length,
      text: (document.querySelector('#diff-view')||{textContent:''}).textContent.slice(0, 200),
    })`);
    const hasIndicators = rows.some((r) => r.includes('edit-me.txt') && /\+\d/.test(r));
    const pass = hasIndicators && view.adds >= 1 && view.text.includes('line2');
    console.log(JSON.stringify({ step, rows, adds: view.adds, dels: view.dels, hasIndicators, diffShowsLine2: view.text.includes('line2'), pass }));
    return cdp.close();
  }

  if (step === 'b8') {
    await openDiffPanel(cdp);
    await cdp.eval(`(() => { const r = [...document.querySelectorAll('#diff-files .diff-file-row')].find((x) => x.textContent.includes('edit-me.txt')); if (r) r.click(); })()`);
    await sleep(1200);
    // 点击一个新增行的行号 → 评论编辑器
    const opened = await cdp.eval(`(() => {
      const ln = document.querySelector('#diff-view .diff-line.add .ln');
      if (!ln) return false; ln.click(); return true;
    })()`);
    await sleep(400);
    await cdp.eval(`(() => {
      const ed = document.querySelector('.diff-comment-editor textarea');
      ed.value = 'REG_B8_COMMENT 这里建议加个注释';
      ed.dispatchEvent(new Event('input'));
    })()`);
    await cdp.eval(`document.querySelector('.diff-comment-editor [data-op="add"]').click()`);
    await sleep(400);
    const chipOk = await cdp.eval(`({
      chip: !!document.querySelector('.diff-comment'),
      btnVisible: !document.querySelector('#btn-send-comments').classList.contains('hidden'),
      count: document.querySelector('#comment-count').textContent,
    })`);
    // 发送评论 → 应作为用户消息发给当前会话
    const prevResults = await cdp.resultCount(sid);
    await cdp.eval(`document.querySelector('#btn-send-comments').click()`);
    await sleep(600);
    const sent = await cdp.eval(`document.querySelector('#messages').textContent.includes('REG_B8_COMMENT')`);
    await cdp.waitIdle(sid, prevResults, 180000);
    const store = fs.readFileSync(path.join(process.env.APPDATA, 'claude-ui', 'sessions', sid + '.jsonl'), 'utf8');
    const persisted = store.includes('REG_B8_COMMENT') && store.includes('代码评审意见');
    const results = (await cdp.events()).filter((p) => p.sid === sid && p.ev.type === 'result');
    const lastOk = results.length && !results[results.length - 1].ev.is_error;
    console.log(JSON.stringify({ step, editorOpened: opened, ...chipOk, messageInUi: sent, persistedToLog: persisted, turnOk: !!lastOk,
      pass: opened && chipOk.chip && chipOk.btnVisible && sent && persisted && !!lastOk }));
    return cdp.close();
  }

  if (step === 'b9') {
    await openDiffPanel(cdp);
    const prevResults = await cdp.resultCount(sid);
    await cdp.eval(`document.querySelector('#btn-review').click()`);
    await sleep(800);
    const store = () => fs.readFileSync(path.join(process.env.APPDATA, 'claude-ui', 'sessions', sid + '.jsonl'), 'utf8');
    await cdp.waitIdle(sid, prevResults, 180000);
    const content = store();
    const reviewSent = /review|评审/i.test(content.split('\n').slice(-30).join('\n'));
    const results = (await cdp.events()).filter((p) => p.sid === sid && p.ev.type === 'result');
    const last = results[results.length - 1];
    const evs = await cdp.events();
    const lastAssistant = evs.filter((p) => p.sid === sid && p.ev.type === 'assistant').slice(-1)[0];
    const answerLen = lastAssistant ? JSON.stringify(lastAssistant.ev.message.content).length : 0;
    console.log(JSON.stringify({ step, reviewPromptSent: reviewSent, turnOk: last && !last.ev.is_error, answerLen,
      pass: !!reviewSent && !!(last && !last.ev.is_error) }));
    return cdp.close();
  }

  if (step === 'b10') {
    // 环境判定:本机无 gh CLI、测试仓库无 PR —— 验证优雅降级即可,功能本身标记跳过
    const res = await cdp.eval(`api.gitPrStatus(${JSON.stringify(WS_DIR)})`);
    const prBoxHidden = await cdp.eval(`document.querySelector('#pr-box').classList.contains('hidden')`);
    console.log(JSON.stringify({ step, apiResult: res, prBoxHidden, graceful: res && res.ok === false && prBoxHidden, skipped: true }));
    return cdp.close();
  }

  if (step === 'b11') {
    const meta = await cdp.eval(`api.sessCreate({ cwd: ${JSON.stringify(WS_DIR)}, permissionMode: 'default', title: 'REG-B11', useWorktree: true })`);
    const wt = meta.worktreePath;
    const wtExists = wt && fs.existsSync(wt);
    const wtList = execFileSync('git', ['worktree', 'list'], { cwd: WS_DIR }).toString();
    const registered = wt && wtList.includes(path.basename(wt));
    // 隔离验证:在 worktree 里写文件,主工作区不应出现
    fs.writeFileSync(path.join(wt, 'wt-only.txt'), 'isolated');
    const isolated = !fs.existsSync(path.join(WS_DIR, 'wt-only.txt'));
    // 归档 → worktree 应被清理
    await cdp.eval(`api.sessArchive(${JSON.stringify(meta.id)}, true)`);
    await sleep(1500);
    const cleaned = !fs.existsSync(wt);
    console.log(JSON.stringify({ step, worktreePath: wt, wtExists, registeredInGit: registered, isolated, cleanedAfterArchive: cleaned,
      pass: !!(wtExists && registered && isolated && cleaned) }));
    return cdp.close();
  }

  throw new Error('unknown step: ' + step);
}

main(process.argv[2]).catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
