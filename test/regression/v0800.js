// v0.8.0 实测:额度配置/用量显示 + 模型勾选过滤下拉
const { CDP, sleep } = require('./cdp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));

(async () => {
  const cdp = await new CDP().connect();
  // 直接经 API 加库洛 key 并拉模型
  const save = await cdp.eval(`api.keysSave({ name: '库洛网关', key: ${JSON.stringify(cfg.env.ANTHROPIC_AUTH_TOKEN)}, baseUrl: ${JSON.stringify(cfg.env.ANTHROPIC_BASE_URL)} })`);
  const kid = save.id;
  await cdp.eval(`api.keysSetActive(${JSON.stringify(kid)})`);
  const refresh = await cdp.eval(`api.keysRefreshModels(${JSON.stringify(kid)})`);
  console.log('refresh:', JSON.stringify({ ok: refresh.ok, count: refresh.models && refresh.models.length }));

  // 打开弹窗验证额度行渲染
  await cdp.eval(`document.querySelector('#btn-more').click()`);
  await sleep(300);
  await cdp.eval(`document.querySelector('#more-menu button[data-act="apikey"]').click()`);
  await sleep(800);
  const quotaRow = await cdp.eval(`(() => {
    const q = [...document.querySelectorAll('.key-quota')].find((x) => x.dataset.quota === ${JSON.stringify(kid)}) || document.querySelector('.key-quota');
    return q ? q.textContent.replace(/\\s+/g, ' ').slice(0, 120) : null;
  })()`);
  console.log('quotaRow:', quotaRow);

  // 设周/月额度
  await cdp.eval(`(() => {
    document.querySelector('.q-week[data-id="${kid}"]') && (document.querySelector('.q-week[data-id="${kid}"]').value = '50');
    document.querySelector('.q-month[data-id="${kid}"]') && (document.querySelector('.q-month[data-id="${kid}"]').value = '200');
  })()`);
  await cdp.eval(`(() => { [...document.querySelectorAll('.q-save')].find((b) => b.dataset.id === '${kid}' || true)?.click(); })()`);
  await sleep(1000);
  const quotaSaved = (await cdp.eval(`api.keysList()`)).list.find((k) => k.id === kid);
  console.log('quotaSaved:', JSON.stringify({ w: quotaSaved.quotaWeek, m: quotaSaved.quotaMonth, hasUsage: !!quotaSaved.usage }));

  // 打开模型勾选面板,只勾前 3 个模型,保存
  await cdp.eval(`(() => { [...document.querySelectorAll('button[data-op="models"]')].find((b) => b.dataset.id === '${kid}').click(); })()`);
  await sleep(800);
  const panelInfo = await cdp.eval(`(() => {
    const p = document.querySelector('[data-models="${kid}"]');
    const boxes = [...p.querySelectorAll('input[type="checkbox"]')];
    boxes.forEach((b, i) => { b.checked = i < 3; });
    return { total: boxes.length, panel: !p.classList.contains('hidden') };
  })()`);
  await cdp.eval(`(() => { document.querySelector('[data-models="${kid}"] [data-save="1"]').click(); })()`);
  await sleep(1200);
  const active = await cdp.eval(`api.keysActiveModels()`);
  const selOpts = await cdp.eval(`[...document.querySelectorAll('#model-sel option')].map((o) => o.textContent)`);
  console.log(JSON.stringify({ panelInfo, enabledCount: active && active.length, selOpts }));

  const pass = refresh.ok && quotaRow && quotaSaved.w === 50 && quotaSaved.m === 200
    && panelInfo.total > 100 && active && active.length === 3 && selOpts.length === 4;
  console.log(pass ? 'VERIFY PASS' : 'VERIFY FAIL');
  cdp.close();
})().catch((e) => { console.error(JSON.stringify({ fatal: e.message })); process.exit(1); });
