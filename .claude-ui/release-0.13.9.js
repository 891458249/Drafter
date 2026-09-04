const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.13.9';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.13.9.exe', remote: 'Drafter-Setup-0.13.9.exe' },
  { local: 'Drafter Setup 0.13.9.exe.blockmap', remote: 'Drafter-Setup-0.13.9.exe.blockmap' },
  { local: 'latest.yml', remote: 'latest.yml' },
];
function api(method, urlPath, body, extraHeaders = {}, raw = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath.startsWith('https://') ? urlPath : 'https://api.github.com' + urlPath);
    const data = raw !== null ? raw : (body ? Buffer.from(JSON.stringify(body), 'utf8') : null);
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'drafter-release', Authorization: 'token ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json', ...(data ? { 'Content-Type': extraHeaders['Content-Type'] || 'application/json', 'Content-Length': data.length } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch {} if (res.statusCode >= 400) return reject(new Error(`${method} ${u.pathname} -> ${res.statusCode}: ${text.slice(0, 500)}`)); resolve(json); });
    }); req.on('error', reject); if (data) req.write(data); req.end();
  });
}
(async () => {
  const cred = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const token = cred.split('\n').find(line => line.startsWith('password=')); if (!token) throw new Error('未取得 GitHub 凭据'); process.env.GH_TOKEN = token.slice(9).trim();
  const notes = [
    '### v0.13.9(2026-09-04):ComfyUI 节点目录离线缓存(节点不再「丢」)', '',
    '- **节点目录磁盘缓存**:本机 ComfyUI 节点目录(约 900 个节点)每次成功拉取后落盘;ComfyUI 未启动/未连接时自动回退到缓存,节点浏览器不再空白,并显示「离线缓存 · 最后更新时间」提示,启动 ComfyUI 后点 ⟳ 即刷新。',
    '- 含 v0.13.8 存量画布修复(外部节点插槽补建、元数据垃圾行剔除、参数值恢复)与 v0.13.2 汉化/LOD 骨架渲染全部内容。', '',
    '验证:npm test 252/252;CDP 冒烟 16/16;离线缓存目录实测显示正常。重启 App 生效(electron-updater 可自动更新)。'
  ].join('\n');
  let release;
  try { release = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`); } catch { release = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: `Drafter ${TAG}`, body: notes, draft: false, prerelease: false }); }
  for (const { local, remote } of ASSETS) {
    const file = path.join(DIST, local); const data = fs.readFileSync(file); const existing = (release.assets || []).find(asset => asset.name === remote);
    if (existing && existing.size === data.length) { console.log('skip:', remote); continue; } if (existing) await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`);
    await api('POST', `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(remote)}`, null, { 'Content-Type': remote.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' }, data); console.log('uploaded:', remote, data.length);
  }
  const yml = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8'); const match = yml.match(/url:\s*(\S+)/); if (!match) throw new Error('latest.yml 缺少 url');
  const status = await new Promise(resolve => https.get(`https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${match[1]}`, { headers: { 'User-Agent': 'drafter-release-check' } }, response => { resolve(response.statusCode); response.resume(); }).on('error', () => resolve(0)));
  if (status !== 200 && status !== 302) throw new Error(`下载 URL 校验失败:${status}`); console.log('download URL verified:', match[1], status);
})().catch(error => { console.error('RELEASE FAILED:', error.message); process.exit(1); });
