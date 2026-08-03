// B17 冲突路径:脏缓冲 + 外部修改 + 保存 → 冲突提示 → 重新加载
const fs = require('fs');
const path = require('path');
const { CDP, sleep } = require('./cdp');
const target = path.join(process.env.TEMP, 'claude-ui-reg', 'edit-me.txt');

(async () => {
  const cdp = await new CDP().connect();
  // 1. 编辑器里改成脏缓冲
  await cdp.eval(`(() => {
    const a = document.querySelector('#editor-area');
    a.value = a.value + String.fromCharCode(10) + 'my-edit';
    a.dispatchEvent(new Event('input'));
  })()`);
  await sleep(300);
  // 2. 外部修改同一文件
  fs.writeFileSync(target, 'external-v2\n');
  await sleep(1500);
  const warn1 = await cdp.eval(`({
    visible: !document.querySelector('#editor-warning').classList.contains('hidden'),
    text: document.querySelector('#editor-warning').textContent.slice(0, 60),
  })`);
  // 3. 保存 → 冲突提示 + 两个处理按钮
  await cdp.eval(`document.querySelector('#btn-editor-save').click()`);
  await sleep(1000);
  const warn2 = await cdp.eval(`({
    visible: !document.querySelector('#editor-warning').classList.contains('hidden'),
    text: document.querySelector('#editor-warning').textContent.slice(0, 60),
    buttons: [...document.querySelectorAll('#editor-warning button')].map((b) => b.textContent),
  })`);
  // 4. 放弃修改重新加载 → 回到 external-v2
  const reloadClicked = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('#editor-warning button')].find((x) => x.textContent.includes('重新加载'));
    if (b) { b.click(); return true; } return false;
  })()`);
  await sleep(1200);
  const finalContent = await cdp.eval(`document.querySelector('#editor-area').value`);
  console.log(JSON.stringify({
    dirtyWarn: warn1, conflictOnSave: warn2, reloadClicked,
    finalContent: String(finalContent).trim(),
    pass: warn2.visible && warn2.buttons.length === 2 && String(finalContent).includes('external-v2'),
  }));
  cdp.close();
})().catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
