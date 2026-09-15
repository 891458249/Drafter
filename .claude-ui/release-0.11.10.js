const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.11.10';
const DIST = 'D:\\ClaudeUI\\dist';
// 上传名必须与 latest.yml 里的 url 完全一致(连字符,无空格)——
// electron-updater 按 latest.yml 的 url 拼下载地址,GitHub 会把空格净化成点导致 404。
const ASSETS = [
  { local: 'Drafter Setup 0.11.10.exe', remote: 'Drafter-Setup-0.11.10.exe' },
  { local: 'Drafter Setup 0.11.10.exe.blockmap', remote: 'Drafter-Setup-0.11.10.exe.blockmap' },
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
    '### v0.11.10(2026-08-26):修复 Harness「Agent 预设」整页空白,新会话可按预设组合启动',
    '',
    '**问题**:设置 → Agent 预设整页空白(原生应有 标准/PTC/极简/创造 四张卡片);',
    '同时 Harness 板块新建会话因预设挂载失败而无法创建。',
    '',
    '**根因**:官方 apps/cli 的启动拼装会把随部署发布的 Agent 预设根目录',
    '(apps/cli/config/agent-presets,含四套官方预设)以 system 信任补进 agent-presets 插件行;',
    'Drafter 手工组装补丁层时漏了这一步,花名册只剩空的用户根目录,',
    '前端把空花名册当「未部署预设」整页隐藏,默认预设 standard 也解析不到导致建会话失败。',
    '另外 tool-web 的网页抓取链(turndown → @mixmark-io/domino)在我们环境里因 CJS 解析问题加载失败,',
    '使 standard 预设挂载被拒。',
    '',
    '**修复**:',
    '- 补丁层补回 agent-presets 行的发布根与 default(standard);',
    '- 修 CJS 索引:包入口指向目录时落到其 index 文件;',
    '- vendor-deps 补收 @mixmark-io/domino(turndown 的依赖);',
    '- 打包配置让预设目录与 cordis 预设自带的技能文件以真实文件落地。',
    '',
    '**验证**:四套预设逐一建会话挂载通过、预设切换(minimal)成功;npm test 152/152。',
    '重启 App 生效(electron-updater 可自动更新)。',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'Drafter v0.11.10', body: notes, draft: false, prerelease: false });
    console.log('release created, id', rel.id);
  }

  for (const { local, remote } of ASSETS) {
    const file = path.join(DIST, local);
    const buf = fs.readFileSync(file);
    const existing = (rel.assets || []).find(a => a.name === remote);
    if (existing && existing.size === buf.length) { console.log('skip (same size):', remote); continue; }
    if (existing) { await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`); console.log('deleted old:', existing.name); }
    const mime = remote.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(remote)}`;
    await api('POST', url, null, { 'Content-Type': mime }, buf);
    console.log('uploaded:', remote, buf.length);
  }
  // 上传后校验:latest.yml 里的 url 必须能 200/302 下载(防止名字不匹配 404)
  const yml = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
  const m = yml.match(/url:\s*(\S+)/);
  if (m) {
    const check = await new Promise((res) => {
      https.get(`https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${m[1]}`, { headers: { 'User-Agent': 'x' } }, (r) => { res(r.statusCode); r.resume(); }).on('error', () => res(0));
    });
    console.log('download URL check:', m[1], '→', check, check === 302 || check === 200 ? 'OK' : 'FAIL(资产名不匹配!)');
  }
  console.log('DONE');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
