const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.9.7';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  'DeskTopUI Setup 0.9.7.exe',
  'DeskTopUI Setup 0.9.7.exe.blockmap',
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
  // token from git credential manager
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const token = out.split('\n').find(l => l.startsWith('password=')).slice(9).trim();
  process.env.GH_TOKEN = token;
  console.log('token ok, len', token.length);

  const notes = [
    '### v0.9.7(2026-08-06):「设为项目文件夹」cwd 修复',
    '',
    '- **修复**:「设为项目文件夹」(proj:adoptDir) 现在同步切换会话 cwd 并重启 query;过滤与 cwd 相同的冗余附加目录;清理 settings.local.json 残留;存量 store 会话 cwd 已修正',
    '- **已知**:改动前创建的存量会话首次 resume 会报 No conversation found,自动开新会话接续(一次性);App 需重启进程生效',
    '',
    '<details><summary>v0.9.0–v0.9.6 累计更新(自上个 release)</summary>',
    '',
    '- v0.9.0 Key 编辑/预设 + Image/Video/Audio/Model 六板块 + AIGC 生成闭环(建任务→轮询→COS 下载) + 辅助模型多模态附件分析',
    '- v0.9.1 独立会话项目化确认 + 会话自动命名 + highlight.js 代码预览 + 项目右键菜单',
    '- v0.9.2 /add-dir 客户端拦截修复 + 更名 DeskTopUI + 用户消息贴右 + 模型身份显示',
    '- v0.9.3 辅助模型候选列出全部勾选模型',
    '- v0.9.4 移除首屏落地页,直接进入对话',
    '- v0.9.5 新媒体模型 403「模型未配置」修复',
    '- v0.9.6 控件会话级化(顶栏瘦身) + 板块隔离加固 + 全产物可预览',
    '',
    '</details>',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'DeskTopUI v0.9.7', body: notes, draft: false, prerelease: false });
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
