const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.14.1';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.14.1.exe', remote: 'Drafter-Setup-0.14.1.exe' },
  { local: 'Drafter Setup 0.14.1.exe.blockmap', remote: 'Drafter-Setup-0.14.1.exe.blockmap' },
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
  // sha512 硬校验(v0.13.6 教训:latest.yml 与 exe 必须出自同一次构建)
  const ymlText = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
  const shaInYml = (ymlText.match(/sha512:\s*(\S+)/) || [])[1];
  const exeData = fs.readFileSync(path.join(DIST, ASSETS[0].local));
  const shaActual = crypto.createHash('sha512').update(exeData).digest('base64');
  if (!shaInYml || shaInYml !== shaActual) throw new Error('latest.yml sha512 与 exe 不匹配,中止发布');
  console.log('sha512 一致:', shaInYml.slice(0, 16) + '…');
  const notes = [
    '### v0.14.1 (2026-09-08):子 Agent 模型守卫 + 悬浮球回归修复 + Key 模型列表主流过滤', '',
    '- **子 Agent 不再偷跑 Claude**:勾选子 Agent 模型后,内置 Agent 与显式 model 覆盖(如 model:"sonnet")一律被 PreToolUse 守卫拦截,取消勾选立即生效;禁止嵌套派发绕过;回合用量按真实执行模型拆账。运行中修改支持「⏹ 停止并立即应用」。',
    '- **悬浮球三项回归修复**:原生右键菜单可正常交互(临时可聚焦);拖拽按光标所在屏 workArea 夹取,不再误入任务栏弹回;底部吸附态拖起不再跳坐标。',
    '- **setModel 修复**:未运行的会话切换模型直接持久化生效,不再误报「模型类型不兼容」。',
    '- **ChatGPT Key 401 修复**:ChatGPT 预设认证方式改为 Bearer(OpenAI 不认 x-api-key);存量 Key 请在编辑弹窗把类型改为「Auth Token(网关 Bearer)」。',
    '- **模型列表主流过滤**:OpenAI 官方「刷新模型」不再列出 119 个模型——自动剔除 whisper/tts/嵌入/图像生成等非对话模型与冗余日期快照,只留 GPT-6/5.x/4o/o 系列等主流对话模型;已保存的勾选白名单自动修剪。', '',
    '验证:npm test 283/283(含真实 SDK+假网关的子 Agent 路由回归);overlay 拖拽单测 7 例。重启 App 生效;已缓存旧模型列表的 Key 请重新点「刷新模型」。'
  ].join('\n');
  let release;
  try { release = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`); } catch { release = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: `Drafter ${TAG}`, body: notes, draft: false, prerelease: false }); }
  for (const { local, remote } of ASSETS) {
    const file = path.join(DIST, local); const data = fs.readFileSync(file); const existing = (release.assets || []).find(asset => asset.name === remote);
    if (existing && existing.size === data.length) { console.log('skip:', remote); continue; } if (existing) await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`);
    await api('POST', `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(remote)}`, null, { 'Content-Type': remote.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' }, data); console.log('uploaded:', remote, data.length);
  }
  const match = ymlText.match(/url:\s*(\S+)/); if (!match) throw new Error('latest.yml 缺少 url');
  const status = await new Promise(resolve => https.get(`https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${match[1]}`, { headers: { 'User-Agent': 'drafter-release-check' } }, response => { resolve(response.statusCode); response.resume(); }).on('error', () => resolve(0)));
  if (status !== 200 && status !== 302) throw new Error(`下载 URL 校验失败:${status}`); console.log('download URL verified:', match[1], status);
})().catch(error => { console.error('RELEASE FAILED:', error.message); process.exit(1); });
