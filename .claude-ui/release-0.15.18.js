// Publish the already verified build. Upload into a draft before marking it latest.
const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const REPO = '/repos/891458249/Drafter';
const TAG = 'v0.15.18';
const DIST = path.join(ROOT, 'dist/release-0.15.18');
const names = [
  ['Drafter Setup 0.15.18.exe', 'Drafter-Setup-0.15.18.exe'],
  ['Drafter Setup 0.15.18.exe.blockmap', 'Drafter-Setup-0.15.18.exe.blockmap'],
  ['latest.yml', 'latest.yml'],
];
const NOTES = `合并三个并行会话的未发布改动(拆分子任务判断 + 上下文压缩阈值/配色 + 打包面收敛)。

拆分子任务改为「先判断再拆」:
- 拆分前先让 AI 判断:哪些能与其他会话并行(新建子任务会话),哪些必须等谁。判断依据里带上同项目组其他会话的现状(标题 / 是否进行中 / 最近在做),避免撞车。
- 需要等待的不再新建会话,而是排入目标会话的消息队列,自动接着执行——目标忙就排队(等它当前回合做完),目标闲就立即开始。
- 目标会话被删/归档或依赖成环时,回退成新建会话,不会把任务丢掉。
- 弹窗里可逐条改「并行 / 等待」及其等待目标,确认后按结果清单回报落地情况。

上下文占用显示与自动压缩:
- 自动压缩改为只在上下文用满 100% 时触发(此前会在 80% 就自动压缩);未到 100% 时压缩只由「压缩」按钮手动触发。
- 上下文按钮旁的占用圈改为三档配色:<30% 绿色 / 30~80% 蓝色 / >80% 红色。

打包与安装(针对「每次更新后整机变卡」):
- 打包解包面大幅收敛:安装目录里的散文件从 7,713 个降到 214 个(仅保留原生模块与可执行文件),安装包体积 182.8MB → 177.4MB,更新时被重写的文件面显著缩小。
- 应用不再往安装目录(C:\\Program Files)写文件,生成的页面改到用户数据目录。
- 安装方式固定为整机安装(per machine)且安装目录不可改,避免再分叉出用户级副本;代价是每次更新安装会弹一次 UAC。
- 代码签名已预留通道(配置 \`CSC_LINK\`/\`CSC_KEY_PASSWORD\` 即生效),本版仍未签名。若更新后仍感觉卡顿,把 \`C:\\Program Files\\Drafter\` 与 \`%LOCALAPPDATA%\\drafter-updater\` 加入杀软(如火绒)排除目录会有明显改善。

验证:436 项测试通过;打包产物校验(解包文件 214、sha512 一致);打包态冒烟通过(终端、Harness 界面均正常)。

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
  if (!/^version: 0\.15\.18\s*$/m.test(yml) || !yml.includes('url: ' + assets[0].remote)) throw new Error('Update metadata mismatch');
  if (crypto.createHash('sha512').update(assets[0].data).digest('base64') !== /sha512:\s*(\S+)/.exec(yml)?.[1]) throw new Error('Installer SHA-512 mismatch');
  // 签名体检(v0.15.17):证书到位前不阻断发布,但每次发版都必须看见签没签。
  // 拿到证书后设 CSC_LINK / CSC_KEY_PASSWORD 重建即生效;要强制签名可用
  // DRAFTER_REQUIRE_SIGNING=1 跑 build/verify-package.js。详见 docs/code-signing.md。
  try {
    console.log(require('../build/signature-status').signatureLine(path.join(DIST, assets[0].local)));
  } catch (error) { console.log('signed: unknown (' + error.message + ')'); }
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
  // Exercise the exact version-check function used by the installed 0.15.16 UI.
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { app: { getVersion: () => '0.15.16', isPackaged: true } };
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const result = await require('../src/main/updater').checkRepoVersion();
    if (result.latest !== '0.15.18' || !result.hasUpdate) throw new Error('App update check did not detect 0.15.18: ' + JSON.stringify(result));
    console.log('app update check:', JSON.stringify(result));
  } finally { Module._load = originalLoad; }
}
main().catch((error) => { console.error('RELEASE FAILED:', error.message); process.exitCode = 1; });
