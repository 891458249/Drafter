// Code/Chat 辅助模型调用(v0.9.1):会话里的音频/视频/3D 附件(media_ref 块)与图片,
// 先经设置的「辅助模型」走 OpenAI 格式 /v1/chat/completions 分析出文本,注入发给主模型的
// prompt;分析不可用(未配置/接口不支持/请求失败)时注入附件元信息兜底,让主模型自行用
// 工具读取本地文件。
// 本模块不依赖 electron(便于单测 mock fetch),key 解析由调用方注入(keysById)。
const fs = require('fs');
const path = require('path');

const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // 媒体附件读取上限,超限不做分析
const HTTP_TIMEOUT_MS = 90000; // 大体积 base64 上传 + 多模态推理较慢,超时放宽

const KIND_LABEL = { image: '图片', audio: '音频', video: '视频', model: '3D 模型' };

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  glb: 'model/gltf-binary', obj: 'text/plain', fbx: 'application/octet-stream',
};
// OpenAI input_audio 的 format 只认 mp3/wav;m4a/ogg 映射最接近的 mp3
const AUDIO_FORMAT = { mp3: 'mp3', wav: 'wav', m4a: 'mp3', ogg: 'mp3' };

// 与 keys.js/aigc.js 相同的归一化:去掉末尾 / 与 /v1 后缀,拼端点时补回 /v1
function apiRoot(baseUrl) {
  return (baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function authHeaders(keyEntry) {
  // Kuro 网关一律 Bearer;兼容 x-api-key 形式的 key
  if (keyEntry.kind === 'authToken') return { authorization: `Bearer ${keyEntry.key}` };
  return { 'x-api-key': keyEntry.key };
}

async function fetchJson(url, { headers = {}, body, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

function fmtSize(n) {
  if (n == null) return '未知';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// --- 辅助模型分析 -------------------------------------------------------------
// media: { name, mediaKind, filePath?, data?(base64), mime? }
// 成功 { ok:true, text };接口不支持/读取失败/HTTP 错误 { ok:false, error }
async function analyzeMedia(keyEntry, model, { name, mediaKind, filePath, data, mime }) {
  // 视频/3D:chat 接口没有对应的二进制入参,由调用方直接走元信息兜底
  if (mediaKind === 'video' || mediaKind === 'model') {
    return { ok: false, error: (KIND_LABEL[mediaKind] || '该类型') + '暂不支持内容分析' };
  }
  const ext = ((name || filePath || '').split('.').pop() || '').toLowerCase();
  let b64 = data;
  const mediaType = mime || MIME_BY_EXT[ext];
  if (!b64) {
    try {
      const st = fs.statSync(filePath);
      if (st.size > MAX_MEDIA_BYTES) return { ok: false, error: '文件超过 20MB,未做内容分析' };
      b64 = fs.readFileSync(filePath).toString('base64');
    } catch (e) {
      return { ok: false, error: '读取附件失败:' + e.message };
    }
  }
  const mediaBlock = mediaKind === 'audio'
    ? { type: 'input_audio', input_audio: { data: b64, format: AUDIO_FORMAT[ext] || 'mp3' } }
    : { type: 'image_url', image_url: { url: `data:${mediaType || 'image/png'};base64,${b64}` } };
  const prompt = mediaKind === 'audio'
    ? '请详细描述这段音频的内容(语音内容请转写成文字),用于提供给另一个 AI 助手作为上下文。'
    : '请详细描述这张图片的内容,用于提供给另一个 AI 助手作为上下文。';
  try {
    const { res, json } = await fetchJson(`${apiRoot(keyEntry.baseUrl)}/v1/chat/completions`, {
      headers: authHeaders(keyEntry),
      body: { model, messages: [{ role: 'user', content: [mediaBlock, { type: 'text', text: prompt }] }] },
    });
    if (!res.ok) {
      const msg = (json && (json.error && (json.error.message || json.error) || json.message)) || '';
      return { ok: false, error: `HTTP ${res.status}${msg ? ' ' + msg : ''}` };
    }
    const c = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && p.text) || '').join('\n') : '').trim();
    if (!text) return { ok: false, error: '辅助模型返回空内容' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '辅助分析请求超时' : e.message };
  }
}

// --- 元信息兜底文本 -----------------------------------------------------------
// reason: null = 未配置辅助模型;否则为分析失败/不支持的原因
function metaFallbackText({ name, mediaKind, path: fp, size }, reason) {
  if (size == null && fp) {
    try { size = fs.statSync(fp).size; } catch {}
  }
  const label = KIND_LABEL[mediaKind] || '媒体';
  const mime = MIME_BY_EXT[((name || '').split('.').pop() || '').toLowerCase()];
  const hint = reason && reason.includes('暂不支持')
    ? `${reason};可用工具直接读取该文件。`
    : reason
      ? `${reason};可用工具直接读取该文件,或检查辅助模型配置后重试。`
      : `未配置${label}辅助模型;如需内容分析请在 API Keys 设置中配置辅助模型,可用工具读取该文件。`;
  return `<附件 name="${name || '附件'}">\n`
    + `类型:${label}${mime ? ' (' + mime + ')' : ''}  大小:${fmtSize(size)}\n`
    + `本地路径:${fp || '(无)'}\n`
    + hint + `\n</附件>`;
}

// 单个 media_ref 块 → <附件分析> 或元信息兜底文本
async function resolveMediaRef(b, { auxModels, keysById, onStatus }) {
  const conf = auxModels && auxModels[b.mediaKind];
  if (conf) {
    const i = conf.indexOf('|'); // 值编码 keyId|modelId
    const keyId = i > 0 ? conf.slice(0, i) : null;
    const model = i > 0 ? conf.slice(i + 1) : conf;
    const keyEntry = keyId && keysById ? keysById(keyId) : null;
    if (keyEntry && model) {
      try { onStatus && onStatus(`正在用辅助模型分析附件 ${b.name}…`); } catch {}
      const r = await analyzeMedia(keyEntry, model, {
        name: b.name, mediaKind: b.mediaKind, filePath: b.path, data: b.data, mime: b.mediaType,
      });
      if (r.ok) return `<附件分析 name="${b.name}">\n${r.text}\n</附件分析>`;
      try { onStatus && onStatus(`附件 ${b.name} 辅助分析失败,已注入文件信息兜底`); } catch {}
      return metaFallbackText(b, '辅助分析失败:' + (r.error || '未知错误'));
    }
  }
  return metaFallbackText(b, null);
}

// --- 注入:发送给主模型前改写 content blocks ------------------------------------
// media_ref 块 → 分析文本/元信息文本;图片块原样保留,配置了图像辅助时追加分析文本。
// 返回新的 content(无媒体块时原样返回)。
async function injectMedia(content, { auxModels = {}, keysById, onStatus } = {}) {
  if (!Array.isArray(content)) return content;
  const hasMedia = content.some((b) => b && b.type === 'media_ref');
  const hasImageAux = !!(auxModels && auxModels.image) && content.some((b) => b && b.type === 'image');
  if (!hasMedia && !hasImageAux) return content;
  const out = [];
  for (const b of content) {
    if (b && b.type === 'media_ref') {
      out.push({ type: 'text', text: await resolveMediaRef(b, { auxModels, keysById, onStatus }) });
    } else if (b && b.type === 'image') {
      out.push(b); // 图片块原样直发主模型(未配置图像辅助时维持现状)
      if (auxModels && auxModels.image) {
        // 配置了图像辅助:用块内 base64 追加一份分析文本;失败不兜底(主模型可直接看图)
        const conf = auxModels.image;
        const i = conf.indexOf('|');
        const keyId = i > 0 ? conf.slice(0, i) : null;
        const model = i > 0 ? conf.slice(i + 1) : conf;
        const keyEntry = keyId && keysById ? keysById(keyId) : null;
        if (keyEntry && model) {
          try { onStatus && onStatus('正在用辅助模型分析图片附件…'); } catch {}
          const r = await analyzeMedia(keyEntry, model, {
            name: '图片附件', mediaKind: 'image',
            data: b.source && b.source.data, mime: b.source && b.source.media_type,
          });
          if (r.ok) out.push({ type: 'text', text: `<附件分析 name="图片附件">\n${r.text}\n</附件分析>` });
        }
      }
    } else {
      out.push(b);
    }
  }
  return out;
}

module.exports = { analyzeMedia, injectMedia, metaFallbackText, apiRoot, authHeaders, MAX_MEDIA_BYTES };
