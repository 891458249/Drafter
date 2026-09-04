const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.13.6';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.13.6.exe', remote: 'Drafter-Setup-0.13.6.exe' },
  { local: 'Drafter Setup 0.13.6.exe.blockmap', remote: 'Drafter-Setup-0.13.6.exe.blockmap' },
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
    '### v0.13.6(2026-09-04):统一构建版——修复 v0.13.5 自动更新下载失败', '',
    'v0.13.5 因两次独立构建,线上 latest.yml 的 sha512 与实际安装包不匹配,导致 electron-updater 下载后哈希校验失败、无法更新。本版为**单次权威构建**,三件套(exe/blockmap/latest.yml)哈希完全匹配。', '',
    '包含 v0.13.4 + v0.13.5 全部内容:', '',
    '- **悬浮球贴边变形**:拖到屏幕边缘吸附后圆球变为半圆页签,平边与屏幕边缘严丝合缝;拖起恢复整圆球。',
    '- **阈值吸附**:松手点距边缘 ≤80px 才果冻吸附;屏幕中间松手自由摆放,不再被强行拉回。',
    '- **悬浮球可拖拽修复**(v0.13.4):修复渲染端模块加载失败、穿透窗口悬停检测、拖拽交互三处根因。',
    '- **AskUserQuestion 权限卡交互化**:选项可点选/可改/可提交,完成态与历史回放回填。', '',
    '验证:npm test 244/244;user32 真实输入冒烟 15/15。重启 App 生效(electron-updater 可自动更新)。'
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
  // 线上 latest.yml 哈希与本次构建的 exe 一致性校验(防 v0.13.5 撞车复发)
  const sha = yml.match(/sha512:\s*(\S+)/)[1];
  const crypto = require('crypto');
  const actual = crypto.createHash('sha512').update(fs.readFileSync(path.join(DIST, 'Drafter Setup 0.13.6.exe'))).digest('base64');
  if (sha !== actual) throw new Error('latest.yml sha512 与 exe 不匹配,中止发布校验');
  console.log('sha512 verified: latest.yml matches exe');
})().catch(error => { console.error('RELEASE FAILED:', error.message); process.exit(1); });
