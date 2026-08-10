const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = '891458249', REPO = 'Drafter', TAG = 'v0.9.12';
const DIST = 'D:\\ClaudeUI\\dist';
const ASSETS = [
  'DeskTopUI Setup 0.9.12.exe',
  'DeskTopUI Setup 0.9.12.exe.blockmap',
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
    '### v0.9.12(2026-08-07):Gem 自定义助手(全板块)+ 聊天代码块 IDE 化',
    '',
    '- **Gem 自定义助手**:类 Gemini Gem 的可复用「角色包」——名称/说明/指令/默认工具/知识文件(≤10)。编辑界面三栏对齐 Gemini(列表 / 表单 / 预览含近期对话+开始对话)。内置 4 个预置 Gem(编程伙伴/写作编辑/头脑风暴/学习辅导,可复制副本编辑);「✨ AI 优化指令」按官方四要素(角色/任务/情境/形式)一句话扩写。SDK 会话经 systemPrompt 注入(与项目组上下文合并),媒体板块(image/video/audio/model)经 prompt 前缀注入;composer 💎 选择器一键绑定/切换,会话徽标展示',
    '- **聊天代码块 IDE 化**:代码块升级为带头部条的卡片——右上角「复制」一键复制源码原文,左上角语言标签;按围栏语言着色(highlight.js 30+ 语言,py/sh/ts 等别名映射,未注册语言自动检测),主题 github-dark。覆盖流式输出/用户消息/计划卡片/历史回放',
    '',
    '<details><summary>说明</summary>',
    '',
    '- 默认工具目前是指令级偏好注入,未做 SDK allowedTools 硬约束(后续迭代)',
    '- 正在运行的 App 需重启进程生效',
    '',
    '</details>',
  ].join('\n');

  let rel;
  try {
    rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('release exists, id', rel.id);
  } catch {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, { tag_name: TAG, name: 'DeskTopUI v0.9.12', body: notes, draft: false, prerelease: false });
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
