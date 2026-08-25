const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.11.2';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  'Drafter Setup 0.11.2.exe',
  'Drafter Setup 0.11.2.exe.blockmap',
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
    '### v0.11.2(2026-08-26):设置面板更新区 —— 仓库版本检查 + 显式更新按钮',
    '',
    '**✨ 新功能**',
    '- 设置面板(⋯)新增「更新」区:🔄 检查更新按钮 + 状态行,直接对比 GitHub 仓库 latest release 版本号与当前版本',
    '- 检测到新版时显式给出「⬇ 立即更新」按钮:electron-updater 自动下载,按钮实时显示进度(下载中… N%),完成后变「🔁 已就绪 · 重启安装」,点击即重启完成更新',
    '- 兜底「🔗 Release 页」按钮:开发环境或自动下载失败时,一键打开浏览器手动下载安装包',
    '',
    '**🔧 技术细节**',
    '- 版本检查走 github.com/releases/latest 的 302 重定向取 tag,不消耗 GitHub API 配额(未鉴权 API 仅 60 次/小时/IP,共享出口易撞限流)',
    '- 版本号三段语义化比较,仓库版本更高才提示更新,相同或更低显示「已是最新」',
    '- 修复 electron-updater 顶层 require 在非 Electron 环境(单元测试)崩溃的问题(改惰性加载)',
    '',
    '正在运行的 App 需重启进程生效(electron-updater 可自动更新)。',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'Drafter v0.11.2', body: notes, draft: false, prerelease: false });
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
