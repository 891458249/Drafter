// Publish the already verified build. Upload into a draft before marking it latest.
const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const REPO = '/repos/891458249/Drafter';
const TAG = 'v0.15.9';
const DIST = path.join(ROOT, 'dist/release-0.15.9');
const names = [
  ['Drafter Setup 0.15.9.exe', 'Drafter-Setup-0.15.9.exe'],
  ['Drafter Setup 0.15.9.exe.blockmap', 'Drafter-Setup-0.15.9.exe.blockmap'],
  ['latest.yml', 'latest.yml'],
];
const NOTES = `新增「拆分子任务」:当前会话的 AI 把需求拆成多个子任务,确认后建多个会话并行执行。

- 点 composer 工具栏「⧉ 拆任务」,需求取自输入框(为空时取当前会话最近一条用户消息)。
- AI 拆分后弹出可编辑的确认卡片:可改标题/说明、增删条目,确认才执行。
- 确认后为每个子任务新建一个并行 code 会话(继承当前会话的项目/模型/Key/权限/推理深度/子 Agent/Gem),标题前缀 ⧉,各自并行运行,不打断当前视图。

验证:364 项测试通过;端到端冒烟(本地假 OpenAI 服务 + 真 Key)实测真实拆分→可编辑卡片→并行会话创建全链路。

安装更新后重启 Drafter 生效。`;
let token;
function api(method, route, body, raw = null) {
  const url = new URL(route.startsWith('https:') ? route : 'https://api.github.com' + route);
  if (!['api.github.com', 'uploads.github.com'].includes(url.hostname)) throw new Error('Unexpected API host');
  const data = raw || (body ? Buffer.from(JSON.stringify(body)) : null);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers: { 'User-Agent': 'drafter-release', Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { value = {}; }
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`${method} ${url.pathname}: HTTP ${res.statusCode} ${value.message || ''}`), { status: res.statusCode }));
        resolve(value);
      });
    });
    req.setTimeout(raw ? 600000 : 120000, () => req.destroy(new Error('GitHub request timed out')));
    req.on('error', reject);
    if (raw) {
      let sent = 0;
      let reported = 0;
      const pump = () => {
        while (sent < raw.length) {
          const chunk = raw.subarray(sent, Math.min(sent + 1024 * 1024, raw.length));
          sent += chunk.length;
          const ready = req.write(chunk);
          if (sent - reported >= 20 * 1024 * 1024) {
            reported = sent;
            console.log('upload progress:', Math.round(sent / raw.length * 100) + '% sent');
          }
          if (!ready) { req.once('drain', pump); return; }
        }
        req.end();
      };
      pump();
    } else req.end(data);
  });
}
function publicGet(url, hashOnly = false, redirects = 0) {
  if (redirects > 6) throw new Error('Too many download redirects');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Drafter-App', 'Cache-Control': 'no-cache' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); resolve(publicGet(new URL(res.headers.location, url), hashOnly, redirects + 1)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Public download returned HTTP ${res.statusCode}`)); return; }
      const hash = crypto.createHash('sha256');
      const chunks = [];
      res.on('data', (chunk) => hashOnly ? hash.update(chunk) : chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve(hashOnly ? hash.digest('hex') : Buffer.concat(chunks)));
    });
    req.setTimeout(120000, () => req.destroy(new Error('Public download timed out')));
    req.on('error', reject);
  });
}
async function main() {
  const verifyOnly = process.argv.includes('--verify');
  const yml = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
  const assets = names.map(([local, remote]) => {
    const data = fs.readFileSync(path.join(DIST, local));
    return { local, remote, data, digest: 'sha256:' + crypto.createHash('sha256').update(data).digest('hex') };
  });
  if (!/^version: 0\.15\.8\s*$/m.test(yml) || !yml.includes('url: ' + assets[0].remote)) throw new Error('Update metadata mismatch');
  if (crypto.createHash('sha512').update(assets[0].data).digest('base64') !== /sha512:\s*(\S+)/.exec(yml)?.[1]) throw new Error('Installer SHA-512 mismatch');
  const credential = execFileSync('git', ['credential', 'fill'], { cwd: ROOT, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true });
  token = credential.split(/\r?\n/).find((line) => line.startsWith('password='))?.slice(9);
  if (!token) throw new Error('GitHub credential unavailable');
  const ref = await api('GET', REPO + '/git/ref/tags/' + TAG);
  const localTag = execFileSync('git', ['rev-parse', TAG], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim();
  if (ref.object.sha !== localTag) throw new Error('Remote tag differs from verified local tag');
  let release = (await api('GET', REPO + '/releases?per_page=100')).find((r) => r.tag_name === TAG);
  if (!release && verifyOnly) throw new Error('Release not found');
  if (!release) release = await api('POST', REPO + '/releases', { tag_name: TAG, name: 'Drafter ' + TAG, body: NOTES, draft: true, prerelease: false });
  console.log('release:', release.id, release.draft ? 'draft' : 'published');
  for (const asset of assets) {
    let existing = (await api('GET', REPO + `/releases/${release.id}/assets?per_page=100`)).find((a) => a.name === asset.remote);
    if (existing && existing.state !== 'uploaded' && release.draft && !verifyOnly) {
      await api('DELETE', REPO + '/releases/assets/' + existing.id);
      console.log('removed incomplete draft upload:', asset.remote);
      existing = null;
    }
    if (existing) {
      if (existing.size !== asset.data.length || (existing.digest && existing.digest !== asset.digest)) throw new Error('Existing asset differs; refusing to replace: ' + asset.remote);
      console.log('asset present:', asset.remote, existing.digest ? 'SHA-256 verified' : 'size verified');
      continue;
    }
    if (verifyOnly) throw new Error('Missing asset: ' + asset.remote);
    const uploaded = await api('POST', `https://uploads.github.com${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(asset.remote)}`, null, asset.data);
    if (uploaded.size !== asset.data.length || (uploaded.digest && uploaded.digest !== asset.digest)) throw new Error('Uploaded asset validation failed');
    console.log('uploaded:', asset.remote, uploaded.size, uploaded.digest ? 'SHA-256 verified' : 'size verified');
  }
  if (!verifyOnly) {
    release = await api('PATCH', REPO + `/releases/${release.id}`, { draft: false, prerelease: false, make_latest: 'true', body: NOTES });
    console.log('published:', release.html_url);
  }
  const latest = await api('GET', REPO + '/releases/latest');
  if (latest.tag_name !== TAG) throw new Error('GitHub latest release has not updated');
  const publicYml = await publicGet(`https://github.com/891458249/Drafter/releases/latest/download/latest.yml`);
  if (!publicYml.equals(assets[2].data)) throw new Error('Public latest.yml differs from build');
  for (const asset of assets.slice(0, 2)) {
    const digest = await publicGet(`https://github.com/891458249/Drafter/releases/download/${TAG}/${asset.remote}`, true);
    if ('sha256:' + digest !== asset.digest) throw new Error('Public asset hash mismatch: ' + asset.remote);
    console.log('public download SHA-256 verified:', asset.remote);
  }
  // Exercise the exact version-check function used by the installed 0.15.7 UI.
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { app: { getVersion: () => '0.15.7', isPackaged: true } };
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const result = await require('../src/main/updater').checkRepoVersion();
    if (result.latest !== '0.15.9' || !result.hasUpdate) throw new Error('App update check did not detect 0.15.9: ' + JSON.stringify(result));
    console.log('app update check:', JSON.stringify(result));
  } finally { Module._load = originalLoad; }
}
main().catch((error) => { console.error('RELEASE FAILED:', error.message); process.exitCode = 1; });
