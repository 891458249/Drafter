// v0.9.27 发布修正:并行会话先建了 Release 并上传了「只有导航密度」的构建,
// 且 GitHub 把资产名空格净化成点导致按空格名查不到 → 422。
// 本脚本:删掉旧的点命名资产,上传本地最新构建(含导航密度 + 附件路径引用两个特性),
// 并把 Release 说明合并为两个特性。
const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', REL_ID = 367756803;
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  'DeskTopUI Setup 0.9.27.exe',
  'DeskTopUI Setup 0.9.27.exe.blockmap',
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
        'User-Agent': 'claudeui-release',
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

  const rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/${REL_ID}`);
  // GitHub 净化资产名(空格→点):两种形态都匹配
  const match = (a, name) => a.name === name || a.name === name.replace(/ /g, '.');
  for (const name of ASSETS) {
    const existing = (rel.assets || []).find((a) => match(a, name));
    if (existing) { await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`); console.log('deleted old:', existing.name); }
    const file = path.join(DIST, name);
    const buf = fs.readFileSync(file);
    const mime = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${REL_ID}/assets?name=${encodeURIComponent(name)}`;
    await api('POST', url, null, { 'Content-Type': mime }, buf);
    console.log('uploaded:', name, buf.length);
  }

  const notes = [
    '### v0.9.27(2026-08-10):消息导航密度自适应 + 文本附件路径引用',
    '',
    '- **导航密度自适应**:消息过多时导航项自动等比压缩槽距与横杠厚度,全部可见;上下边缘渐出改为消息按键自身透明度变淡,不再加整栏遮罩',
    '- **文本附件改路径引用**:附件不再把内容内联进消息,UI 只显示文件卡片(📄 文件名),AI 按路径用 Read 工具自行查看,大文件不再撑爆会话篇幅;旧版内联全文的历史附件消息同样折叠为卡片;粘贴的无路径文本自动暂存本地后按路径引用',
    '',
    '正在运行的 App 需重启进程生效(electron-updater 可自动更新)。',
  ].join('\n');
  await api('PATCH', `/repos/${OWNER}/${REPO}/releases/${REL_ID}`, { body: notes });
  console.log('notes updated');
  console.log('DONE');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
