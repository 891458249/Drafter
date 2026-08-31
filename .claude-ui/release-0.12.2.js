const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.12.2';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  { local: 'Drafter Setup 0.12.2.exe', remote: 'Drafter-Setup-0.12.2.exe' },
  { local: 'Drafter Setup 0.12.2.exe.blockmap', remote: 'Drafter-Setup-0.12.2.exe.blockmap' },
  { local: 'latest.yml', remote: 'latest.yml' },
];

function api(method, urlPath, body, extraHeaders = {}, raw = null) {
  return new Promise((resolve, reject) => {
    const isUpload = urlPath.startsWith('https://');
    const u = new URL(isUpload ? urlPath : 'https://api.github.com' + urlPath);
    const data = raw !== null ? raw : (body ? Buffer.from(JSON.stringify(body), 'utf8') : null);
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': 'drafter-release', 'Authorization': 'token ' + process.env.GH_TOKEN,
        'Accept': 'application/vnd.github+json',
        ...(data ? { 'Content-Type': extraHeaders['Content-Type'] || 'application/json', 'Content-Length': data.length } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = JSON.parse(text); } catch {}
        if (res.statusCode >= 400) return reject(new Error(`${method} ${u.pathname} -> ${res.statusCode}: ${text.slice(0, 500)}`));
        resolve(json);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const credentials = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const token = credentials.split('\n').find(line => line.startsWith('password='));
  if (!token) throw new Error('未取得 GitHub 凭据');
  process.env.GH_TOKEN = token.slice(9).trim();

  const notes = [
    '### v0.12.2(2026-09-01):画布双后端——外接 ComfyUI 服务', '',
    '- **连接管理**:配置本机、LAN、云端或反代 ComfyUI；认证信息仅保存在本机，远程 HTTP/TLS 例外需明确确认。',
    '- **工作流互通**:支持 ComfyUI Prompt/Workflow JSON 导入导出，读取节点目录后可在画布编辑外部节点。',
    '- **远程执行**:通过 `/prompt`、WebSocket、`/history` 和 `/view` 打通提交、进度、取消和产物下载；画布队列统一显示原生与 ComfyUI 任务。',
    '- **可靠性**:修复画布重开节点空壳；会话恢复记录损坏时自动降级为新 SDK 上下文而保留界面历史。', '',
    '验证:npm test 179/179；隔离 Electron/CDP 冒烟 6/6；安装包 asar 校验通过。',
    '真实 ComfyUI 模型执行需要用户在设置中配置可访问的服务。重启 App 生效(electron-updater 可自动更新)。',
  ].join('\n');

  let release;
  try { release = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`); }
  catch { release = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: `Drafter ${TAG}`, body: notes, draft: false, prerelease: false }); }

  for (const { local, remote } of ASSETS) {
    const file = path.join(DIST, local);
    const data = fs.readFileSync(file);
    const existing = (release.assets || []).find(asset => asset.name === remote);
    if (existing && existing.size === data.length) { console.log('skip:', remote); continue; }
    if (existing) await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`);
    const mime = remote.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    await api('POST', `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(remote)}`, null, { 'Content-Type': mime }, data);
    console.log('uploaded:', remote, data.length);
  }

  const yml = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
  const match = yml.match(/url:\s*(\S+)/);
  if (!match) throw new Error('latest.yml 缺少 url');
  const status = await new Promise(resolve => https.get(`https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${match[1]}`, { headers: { 'User-Agent': 'drafter-release-check' } }, response => { resolve(response.statusCode); response.resume(); }).on('error', () => resolve(0)));
  if (status !== 200 && status !== 302) throw new Error(`下载 URL 校验失败:${status}`);
  console.log('download URL verified:', match[1], status);
})().catch(error => { console.error('RELEASE FAILED:', error.message); process.exit(1); });
