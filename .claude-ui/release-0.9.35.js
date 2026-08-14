const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.9.35';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  'Drafter Setup 0.9.35.exe',
  'Drafter Setup 0.9.35.exe.blockmap',
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
    '### v0.9.35(2026-08-12):更名 Drafter + 品牌全面出清 + 新 Logo',
    '',
    '- **更名 Drafter**:应用名称/窗口标题/托盘/快捷方式/安装包(Drafter Setup x.y.z.exe)/appId(com.drafter.app)全部改为 Drafter',
    '- **产出物署名出清**:用本 App 写代码/插件时,项目组共享记忆目录改为 `.drafter/`、worktree 分支前缀 `drafter/`、会话内注入标签 `<drafter-project-group>`/`<drafter-gem>`——不再带任何 ClaudeUI 痕迹',
    '- **新 Logo**:层叠草稿纸图形(前页珊瑚色描边+三行文字线,末行较短如「起草中」),呼应 Drafter=起草者',
    '- **用户数据自动迁移**:首次启动从旧品牌 `%AppData%` 目录(DeskTopUI/desktopui/claude-ui)整体复制到 `%AppData%\\Drafter`(只复制不删除,会话/Key/设置无缝接续)',
    '- **存量兼容**:项目组记忆目录(.drafter→.desktopui→.claude-ui)、store 文件名(drafter→desktopui→claude-ui)、环境变量(DRAFTER_/DESKTOPUI_/CLAUDE_UI_USERDATA)三代兜底',
    '',
    '⚠ 注意:appId 变更后,旧版自动更新安装新版时**旧安装目录不会被接管**,会并存为两个安装——请手动卸载一次旧版(数据已自动迁移,不受影响)。',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'Drafter v0.9.35', body: notes, draft: false, prerelease: false });
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
