// Preview panel: webview for localhost previews; external sites need confirm.
import { $, } from './state.js';

let webview = null;

function ensureWebview() {
  if (webview) return webview;
  webview = document.createElement('webview');
  webview.setAttribute('allowpopups', 'false');
  $('preview-host').appendChild(webview);
  return webview;
}

function navigate(url) {
  if (!url) return;
  if (!/^https?:\/\//.test(url)) url = 'http://' + url;
  let host = '';
  try { host = new URL(url).hostname; } catch { return; }
  const isLocal = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(host);
  if (!isLocal && !confirm(`将在预览面板中加载外部站点:\n${url}\n\n继续?`)) return;
  ensureWebview().src = url;
  $('preview-url').value = url;
}

export function init() {
  $('btn-preview-go').onclick = () => navigate($('preview-url').value.trim());
  $('preview-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigate($('preview-url').value.trim());
  });
  $('btn-preview-reload').onclick = () => { if (webview && webview.src) webview.reload(); };
}
