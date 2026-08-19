// AIGC 生成任务闭环(Kuro 网关,v0.9.0):创建任务 → 轮询状态 → 下载产物。
// 端点:{apiRoot}/aigc/api/create-{image|video|audio|3D}、task-detail、download_wm_sts;
// 参考图上传:apply-upload → COS 直传(PUT) → commit-upload。
// 本模块不依赖 electron(便于单测 mock fetch),目录/窗口交互由 main.js 负责。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CREATE_ENDPOINT = { image: 'create-image', video: 'create-video', audio: 'create-audio', model: 'create-3D' };
const TERMINAL = new Set(['done', 'fail', 'timeout']); // 网关终态
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 总超时按 timeout 处理
const HTTP_TIMEOUT_MS = 15000;

// 生成类型解析(v0.9.38 四大媒体板块合并):创作会话统一 kind='media',生成类型
// 改由所选模型的 model_type 决定。modelTypeOf(keyId, model) 由调用方注入
// (主进程传 keys.modelType,便于单测);查不到类型时回退会话旧 kind(降级/未迁移
// 存量),再不行返回 null——调用方应拦截发送并提示重选模型。
function resolveBoard(modelTypeOf, keyId, model, legacyKind) {
  let t = null;
  try { t = modelTypeOf && modelTypeOf(keyId, model); } catch {}
  if (CREATE_ENDPOINT[t]) return t;
  if (CREATE_ENDPOINT[legacyKind]) return legacyKind;
  return null;
}

// 与 keys.js 相同的归一化:去掉末尾 / 与 /v1 后缀
function apiRoot(baseUrl) {
  return (baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function authHeaders(keyEntry) {
  // Kuro 网关一律 Bearer;兼容 x-api-key 形式的 key
  if (keyEntry.kind === 'authToken') return { authorization: `Bearer ${keyEntry.key}` };
  return { 'x-api-key': keyEntry.key };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

// --- 腾讯云 COS XML API 签名(q-sign-algorithm=sha1,Node crypto 手写,不引依赖) ---
// SignKey = HMAC-SHA1(SecretKey, KeyTime);StringToSign = sha1(HttpString);
// AuthString 放 Authorization 头,临时密钥另带 x-cos-security-token。
function cosSign({ method, cosPath, secretId, secretKey, headers = {}, params = {} }) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now - 60};${now + 900}`;
  const signKey = crypto.createHmac('sha1', secretKey).update(keyTime).digest('hex');
  const kv = (obj) => Object.keys(obj)
    .map((k) => k.toLowerCase())
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(obj[Object.keys(obj).find((x) => x.toLowerCase() === k)])}`)
    .join('&');
  const paramStr = kv(params);
  const headerStr = kv(headers);
  const httpString = [method.toLowerCase(), cosPath, paramStr, headerStr, ''].join('\n');
  const stringToSign = ['sha1', keyTime, crypto.createHash('sha1').update(httpString).digest('hex'), ''].join('\n');
  const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
  const listOf = (obj) => Object.keys(obj).map((k) => k.toLowerCase()).sort().map(encodeURIComponent).join(';');
  return 'q-sign-algorithm=sha1'
    + `&q-ak=${encodeURIComponent(secretId)}`
    + `&q-sign-time=${keyTime}&q-key-time=${keyTime}`
    + `&q-header-list=${listOf(headers)}&q-url-param-list=${listOf(params)}`
    + `&q-signature=${signature}`;
}

// 带 STS 临时密钥的 COS 请求(GET 下载 / PUT 直传);cosPath 以 / 开头
async function cosFetch({ method, bucket, region, cosPath, cert, body, contentType }) {
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const headers = { host };
  if (contentType) headers['content-type'] = contentType;
  const auth = cosSign({ method, cosPath, secretId: cert.SecretId || cert.secret_id, secretKey: cert.SecretKey || cert.secret_key, headers });
  const sendHeaders = { authorization: auth, 'x-cos-security-token': cert.Token || cert.session_token };
  if (contentType) sendHeaders['content-type'] = contentType;
  const res = await fetch(`https://${host}${encodeURI(cosPath)}`, { method, headers: sendHeaders, body });
  return res;
}

// --- 参考文件上传:apply-upload → COS PUT → commit-upload,返回公网 MediaUrl ---
// file: { name, mediaType, data(base64) }
async function uploadRefFile(keyEntry, file) {
  const base = apiRoot(keyEntry.baseUrl);
  const ext = ((file.name.split('.').pop() || '') || 'png').toLowerCase().replace('jpeg', 'jpg');
  const { res, json } = await fetchJson(`${base}/aigc/api/apply-upload`, {
    method: 'POST', headers: authHeaders(keyEntry),
    body: { MediaType: ext, MediaName: file.name },
  });
  const info = json && json.Response;
  if (!res.ok || !info || !info.TempCertificate) {
    throw new Error('apply-upload 失败:HTTP ' + res.status + (json && json.error ? ' ' + json.error : ''));
  }
  const buf = Buffer.from(file.data, 'base64');
  const up = await cosFetch({
    method: 'PUT',
    bucket: info.StorageBucket,
    region: info.StorageRegion,
    cosPath: info.MediaUploadPath,
    cert: info.TempCertificate,
    body: buf,
    contentType: file.mediaType || 'application/octet-stream',
  });
  if (!up.ok) throw new Error('参考文件 COS 直传失败:HTTP ' + up.status);
  const c = await fetchJson(`${base}/aigc/api/commit-upload`, {
    method: 'POST', headers: authHeaders(keyEntry),
    body: { VodSessionKey: info.VodSessionKey },
  });
  const mediaUrl = c.json && c.json.Response && c.json.Response.MediaUrl;
  if (!c.res.ok || !mediaUrl) throw new Error('commit-upload 失败:HTTP ' + c.res.status);
  return mediaUrl;
}

// --- 创建任务 ---------------------------------------------------------------
// board: image/video/audio/model;opts: { modelKey, prompt, refImages? }
// refImages 仅 image/video 板块使用:先上传得 MediaUrl 组 FileInfos
async function createTask(keyEntry, board, { modelKey, prompt, refImages = [] }) {
  const endpoint = CREATE_ENDPOINT[board];
  if (!endpoint) throw new Error('未知的 AIGC 板块:' + board);
  const base = apiRoot(keyEntry.baseUrl);
  let body;
  if (board === 'audio') {
    // 音频统一入口:create-audio;首版只做文生语音(tts)
    body = { model: modelKey, type: 'tts', text: prompt };
    applyAudioDefaults(modelKey, body);
  } else if (board === 'model') {
    // 混元 3D:首版只支持文生 3D
    body = { ModelKey: modelKey, type: 'text_to_model', prompt };
  } else {
    body = { ModelKey: modelKey, Prompt: prompt };
    if (refImages.length) {
      // 图生图 / 图生视频:参考图先走上传链拿公网 URL;视频参考图按首帧语义提交
      const usage = board === 'video' ? 'FirstFrame' : 'Reference';
      body.FileInfos = [];
      for (const f of refImages) {
        const url = await uploadRefFile(keyEntry, f);
        body.FileInfos.push({ Type: 'Url', Category: 'Image', Usage: usage, Url: url });
      }
    }
  }
  const { res, json } = await fetchJson(`${base}/aigc/api/${endpoint}`, {
    method: 'POST', headers: authHeaders(keyEntry), body,
  });
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || '';
    throw new Error(`创建任务失败:HTTP ${res.status}${msg ? ' ' + msg : ''}`);
  }
  // trace_id 优先取响应头 X-Trace-ID(body 可能没有;3D 等部分接口 body 带 trace_id)
  const traceId = res.headers.get('x-trace-id')
    || (json && (json.trace_id || json.TraceID || (json.Response && json.Response.TraceID)));
  if (!traceId) throw new Error('创建任务响应缺少 trace_id');
  return { traceId };
}

// tts 必填音色:按模型给默认音色,无通用默认的(如 eleven_v3)不传,失败原因会展示在任务卡片
function applyAudioDefaults(modelKey, body) {
  if (/^seed-audio/i.test(modelKey)) body.references = [{ speaker: 'zh_female_vv_uranus_bigtts' }]; // 豆包系统音色
  else if (/^speech-/i.test(modelKey)) body.voice_id = 'Chinese (Mandarin)_News_Anchor'; // MiniMax 系统音色
}

// --- 轮询 -------------------------------------------------------------------
// onStatus(detail) 在状态变化时回调(detail 为 task-detail 响应体);
// 返回 { promise(终态 detail / 取消时 null), cancel() }
function pollTask(keyEntry, traceId, onStatus, { intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS } = {}) {
  let stopped = false;
  const base = apiRoot(keyEntry.baseUrl);
  const promise = (async () => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (!stopped) {
      let detail = null;
      try {
        const { res, json } = await fetchJson(`${base}/aigc/api/task-detail?trace_id=${encodeURIComponent(traceId)}`, {
          headers: authHeaders(keyEntry),
        });
        if (res.ok && json && json.status) detail = json;
      } catch {} // 网络抖动:死线前继续轮询
      if (detail && detail.status !== last) {
        last = detail.status;
        try { onStatus(detail); } catch {}
        if (TERMINAL.has(detail.status)) return detail;
      }
      if (Date.now() >= deadline) {
        const t = { status: 'timeout', fail_reason: '本地轮询超时(10 分钟)' };
        try { onStatus(t); } catch {}
        return t;
      }
      await sleep(intervalMs);
    }
    return null; // 已取消
  })();
  return { promise, cancel: () => { stopped = true; } };
}

// --- 下载产物 ---------------------------------------------------------------
// download_wm_sts 两分支:watermark_required → files[].download_url 直接 GET(带水印);
// done → COS STS 签名 GET。产物落盘到 outDir/<filename>,返回 [{ path, name }]
async function downloadResults(keyEntry, traceId, outDir) {
  const base = apiRoot(keyEntry.baseUrl);
  const { res, json } = await fetchJson(`${base}/aigc/api/download_wm_sts`, {
    method: 'POST', headers: authHeaders(keyEntry), body: { trace_id: traceId },
  });
  if (!res.ok || !json) {
    const reason = (json && (json.fail_reason || json.error || json.message)) || '';
    throw new Error(`获取下载凭证失败:HTTP ${res.status}${reason ? ' ' + reason : ''}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const saved = [];
  const saveOne = async (index, filename, getRes) => {
    if (!getRes.ok) throw new Error(`产物下载失败:HTTP ${getRes.status}`);
    const safe = String(filename || `${index}`).replace(/[\\/:*?"<>|]/g, '_') || `${index}`;
    const fp = path.join(outDir, safe);
    fs.writeFileSync(fp, Buffer.from(await getRes.arrayBuffer()));
    saved.push({ path: fp, name: safe });
  };
  if (json.status === 'watermark_required') {
    // 未审批:每个文件用自己的 download_url 下带水印版本(单文件模式兜底顶层字段)
    const files = Array.isArray(json.files) && json.files.length
      ? json.files
      : [{ index: 0, download_url: json.download_url, filename: json.filename }];
    for (const f of files) {
      if (!f.download_url) continue;
      // 网关可能返回相对路径(如 /aigc/api/download_wm_url?...),按 base 解析为绝对 URL;
      // 同源(回网关)才带鉴权头,跨域预签名 URL 不附带以免破坏签名
      const href = new URL(f.download_url, base + '/').href;
      const sameOrigin = new URL(href).origin === new URL(base + '/').origin;
      const name = f.filename || guessNameFromUrl(href) || `${f.index ?? saved.length}`;
      await saveOne(f.index ?? saved.length, name,
        await fetch(href, sameOrigin ? { headers: authHeaders(keyEntry) } : {}));
    }
  } else if (json.status === 'done') {
    // 已审批/无门禁:同一组 STS 凭证逐个签名下载 files[].cos_path(兼容单文件模式)
    const cert = { secret_id: json.secret_id, secret_key: json.secret_key, session_token: json.session_token };
    const files = Array.isArray(json.files) && json.files.length
      ? json.files
      : [{ index: 0, cos_path: json.cos_path, filename: json.filename }];
    for (const f of files) {
      if (!f.cos_path) continue;
      const cosPath = '/' + String(f.cos_path).replace(/^\/+/, '');
      const name = f.filename || cosPath.split('/').pop();
      await saveOne(f.index ?? saved.length, name, await cosFetch({
        method: 'GET', bucket: json.bucket, region: json.region, cosPath, cert,
      }));
    }
  } else {
    throw new Error('任务未到可下载状态:' + json.status);
  }
  if (!saved.length) throw new Error('下载响应中没有可下载的文件');
  return saved;
}

function guessNameFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { return ''; }
}

module.exports = { createTask, pollTask, downloadResults, uploadRefFile, cosSign, apiRoot, resolveBoard };
