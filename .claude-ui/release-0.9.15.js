const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.9.15';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  'DeskTopUI Setup 0.9.15.exe',
  'DeskTopUI Setup 0.9.15.exe.blockmap',
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
  console.log('token ok, len', token.length);

  const notes = [
    '### v0.9.15(2026-08-10):消息导航 Dock 式悬停放大 + 瞬时跳转设置项',
    '',
    '- **Dock 式悬停放大**(v0.9.14):鼠标在右侧消息缩略导航上滑动时,光标所在项放大最多(1.35x),邻近项按距离二次衰减;仅内容无需滚动时启用,可滚动时退回普通高亮',
    '- **瞬时跳转**(v0.9.14):消息导航点击定位、「↓ 回到底部」按钮由平滑滚动改为瞬时跳转',
    '- **瞬时跳转设置项**(v0.9.15):右上角 ⋯ 菜单新增「⚡ 瞬时跳转定位」勾选(默认开),关闭则恢复平滑滚动;作用于导航点击定位与回到底部按钮',
    '',
    '正在运行的 App 需重启进程生效。',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'DeskTopUI v0.9.15', body: notes, draft: false, prerelease: false });
    console.log('release created, id', rel.id);
  }

  for (const name of ASSETS) {
    const file = path.join(DIST, name);
    const buf = fs.readFileSync(file);
    const existing = (rel.assets || []).find(a => a.name === name);
    if (existing && existing.size === buf.length) { console.log('skip (same size):', name); continue; }
    if (existing) { await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`); console.log('deleted old:', name); }
    const mime = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`;
    await api('POST', url, null, { 'Content-Type': mime }, buf);
    console.log('uploaded:', name, buf.length);
  }
  console.log('DONE');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
