// 网络/fetch 错误的人话格式化(纯函数,无依赖,可单测)。
// Node 的 fetch 把真因藏在 e.cause:TypeError('fetch failed') 只是外壳,
// 底层可能是 ECONNRESET(连接被重置,常见于域名被网络阻断)/ETIMEDOUT/ENOTFOUND/证书错误。
// 直接显示 e.message 用户只剩一句「fetch failed」,无从分辨「网关挂了」还是「被墙了」。
// 这里展开 cause 链并给可执行提示。供 oai-proxy / model-guard-proxy / keys 模型刷新复用。

const HINTS = [
  [/ECONNRESET|ECONNABORTED/i, '连接被重置:该网关域名可能被当前网络阻断,或网关正在拒连'],
  [/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|Connect Timeout/i, '连接超时:网络不通或网关无响应'],
  [/ENOTFOUND|EAI_AGAIN/i, 'DNS 解析失败:域名不存在或 DNS 异常'],
  [/ECONNREFUSED/i, '连接被拒绝:目标地址/端口不可达'],
  [/UNABLE_TO_VERIFY|SELF_SIGNED|CERT_|CERTIFICATE|SSL routines|TLS/i, 'TLS 证书校验失败'],
];

// 收集 e 及其 cause 链的描述:「code: message」逐级拼接,去重防空转
function chainText(e) {
  const parts = [];
  const seen = new Set();
  let cur = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    const code = cur.code || cur.errno || '';
    const msg = cur.message || String(cur);
    const text = code && !String(msg).includes(code) ? `${code}: ${msg}` : msg;
    if (!seen.has(text)) { seen.add(text); parts.push(text); }
    cur = cur.cause;
  }
  return parts;
}

// 返回单行人话:「fetch failed(ECONNRESET: read ECONNRESET —— 连接被重置:…)」
function netErrorText(e) {
  if (!e) return '未知网络错误';
  const parts = chainText(e);
  const joined = parts.join(' <= ');
  const hint = HINTS.find(([re]) => re.test(joined));
  if (parts.length <= 1 && !hint) return parts[0] || '未知网络错误';
  const detail = parts.length > 1 ? `${parts[0]}(${parts.slice(1).join(' <= ')})` : parts[0];
  return hint ? `${detail} —— ${hint[1]}` : detail;
}

module.exports = { netErrorText };
