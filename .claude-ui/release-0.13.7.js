const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.13.7';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.13.7.exe', remote: 'Drafter-Setup-0.13.7.exe' },
  { local: 'Drafter Setup 0.13.7.exe.blockmap', remote: 'Drafter-Setup-0.13.7.exe.blockmap' },
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
    '### v0.13.7(2026-09-04):悬浮球——上下边缘吸附修复 + 平滑变形 + 斑马纹加载环', '',
    '- **修复上下边缘吸附失效**:吸附判定误用窗口中心而非球心计算距离(悬浮窗 96×340,窗口中心偏离球心 170px),球贴到屏幕顶/底时永远达不到吸附阈值。现按球心精确判定,四边吸附一致可靠。',
    '- **贴边变形平滑过渡**:整圆球 → 半圆页签的变形从「瞬时切换」改为**随果冻弹簧进度逐帧驱动**(位置、形变、圆角全程连续);从贴边态拖起时 220ms 平滑圆回。',
    '- **任务小球加载动效**:进行中的进度读条换成**斑马纹旋转环**(金色条纹 1.1s/圈匀速旋转),完成仍变绿、点击定位会话不变。',
    '- 贴边停靠的持久化坐标增加界内夹取,重启恢复更稳。', '',
    '验证:npm test 245/245;交互冒烟 17/17(新增拖向顶缘吸附回归场景);真实回合任务态冒烟 11/11(斑马环样式+截图确认)。重启 App 生效(electron-updater 可自动更新)。'
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
  const sha = yml.match(/sha512:\s*(\S+)/)[1];
  const crypto = require('crypto');
  const actual = crypto.createHash('sha512').update(fs.readFileSync(path.join(DIST, 'Drafter Setup 0.13.7.exe'))).digest('base64');
  if (sha !== actual) throw new Error('latest.yml sha512 与 exe 不匹配,中止');
  console.log('sha512 verified: latest.yml matches exe');
})().catch(error => { console.error('RELEASE FAILED:', error.message); process.exit(1); });
