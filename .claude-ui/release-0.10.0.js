const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.10.0';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  'Drafter Setup 0.10.0.exe',
  'Drafter Setup 0.10.0.exe.blockmap',
  'latest.yml',
];

function api(method, urlPath, body, extraHeaders = {}, raw = null) {
  return new Promise((resolve, reject) => {
    const isUpload = urlPath.startsWith('https://');
    const u = new URL(isUpload ? urlPath : 'https://api.github.com' + urlPath);
    const data = raw !== null ? raw : (body ? Buffer.from(JSON.stringify(body), 'utf8') : null);
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': 'drafter-release',
        'Authorization': 'token ' + process.env.GH_TOKEN,
        'Accept': 'application/vnd.github+json',
        ...(data ? { 'Content-Type': extraHeaders['Content-Type'] || 'application/json', 'Content-Length': data.length } : {}),
      },
    }, res => {
      let buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => {
        const text = Buffer.concat(buf).toString();
        let json = null; try { json = JSON.parse(text); } catch {}
        if (res.statusCode >= 400) return reject(new Error(method + ' ' + u.pathname + ' -> ' + res.statusCode + ': ' + text.slice(0, 500)));
        resolve(json);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const token = out.split('\n').find(l => l.startsWith('password=')).slice(9).trim();
  process.env.GH_TOKEN = token;
  console.log('token ok, len', token.length);

  const notes = [
    '### v0.10.0(2026-08-19):无限画布 + 素材库 + 四大媒体板块合并「创作」',
    '',
    '**创作板块(v0.9.38 并入)**:image/video/audio/model 四大板块合并为一个「创作」板块——选什么模型就生成什么类型,同一会话可先生成图片、再把产物当参考图生成视频;侧栏新增工坊筛选(全部/图片/视频/音频/3D)。旧会话自动迁移。',
    '',
    '**无限画布(新板块)**:节点式工作流画布——文本/参考图上传/图片·视频·音频·3D 生成六类节点,类型槽连线校验;**多模型 fan-out**:节点内勾选多个模型同屏对比,采用最优版本喂给下游;节点保留全部生成历史可翻页;画布自动保存,任务在后台跑完自动写回画布。',
    '',
    '**素材库(新板块)**:全部生成产物的归档网格(会话+画布双源聚合),类型筛选+搜索;图片产物一键「用作参考图」发回创作会话,打通图→视频主链路。',
    '',
    '正在运行的 App 需重启进程生效(electron-updater 可自动更新)。',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
    await api('PATCH', `/repos/${OWNER}/${REPO}/releases/${rel.id}`, { name: 'Drafter v0.10.0', body: notes });
    console.log('notes updated');
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'Drafter v0.10.0', body: notes, draft: false, prerelease: false });
    console.log('release created, id', rel.id);
  }

  for (const name of ASSETS) {
    const file = path.join(DIST, name);
    const buf = fs.readFileSync(file);
    // GitHub 会把资产名空格净化成点(v0.9.27 踩坑):两种形态都匹配
    const existing = (rel.assets || []).find(a => a.name === name || a.name === name.replace(/ /g, '.'));
    if (existing && existing.size === buf.length) { console.log('skip (same size):', name); continue; }
    if (existing) { await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`); console.log('deleted old:', existing.name); }
    const mime = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`;
    await api('POST', url, null, { 'Content-Type': mime }, buf);
    console.log('uploaded:', name, buf.length);
  }
  console.log('DONE');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
