// 视频关键帧抽取(v0.15.12):用 Electron 自带 Chromium 的 <video>+<canvas> 解码,
// 不新增原生依赖(Electron 已带 ffmpeg)。在隐藏 BrowserWindow 里加载本地视频,
// 按时间轴均匀 seek 抽 K 帧,导出 JPEG base64,供「视频辅助模型走图像通道」使用。
// 仅主进程可用(需要 electron);aux-models 通过依赖注入使用,单测不经过本模块。
const path = require('path');
const fs = require('fs');

const DEFAULT_FRAMES = 6;          // 抽取帧数(时间轴均匀分布)
const MAX_FRAME_WIDTH = 768;       // 帧最大宽度,等比缩放,控制 base64 体积
const JPEG_QUALITY = 0.72;         // JPEG 质量,兼顾清晰度与体积
const SEEK_TIMEOUT_MS = 12000;     // 单帧 seek 超时
const EXTRACT_TIMEOUT_MS = 60000;  // 整个抽帧流程超时
const MAX_VIDEO_BYTES = 64 * 1024 * 1024; // 读入内存转 blob 的体积上限

// 在隐藏窗口内执行的抽帧脚本(媒体源以 Blob 注入,避免 file:// 源被 opaque origin 拦截)。
// 返回 { ok, frames:[{t, jpeg(base64)}], width, height, duration } 或 { ok:false, error }。
function extractInPage(mime, b64, frameCount, maxWidth, quality, seekTimeoutMs) {
  return (async () => {
    function seekTo(v, t) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('seek timeout')); }, seekTimeoutMs);
        function cleanup() { clearTimeout(timer); v.removeEventListener('seeked', onSeek); v.removeEventListener('error', onErr); }
        function onSeek() { cleanup(); resolve(); }
        function onErr() { cleanup(); reject(new Error('video error')); }
        v.addEventListener('seeked', onSeek, { once: true });
        v.addEventListener('error', onErr, { once: true });
        try { v.currentTime = t; } catch (e) { cleanup(); reject(e); }
      });
    }
    // base64 → Blob
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime || 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    const errDetail = () => {
      const c = video.error && video.error.code;
      const map = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE(编码不受支持,可能是 HEVC/AV1 等)', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED(源/格式不支持或加载被拦截)' };
      return '无法加载视频:' + (map[c] || '未知(' + c + ')');
    };
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('metadata timeout')), seekTimeoutMs);
        video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(timer); reject(new Error(errDetail())); }, { once: true });
      });
      const duration = video.duration;
      if (!isFinite(duration) || duration <= 0) return { ok: false, error: '无法读取视频时长' };
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return { ok: false, error: '无法读取视频画面尺寸' };
      const scale = Math.min(1, maxWidth / vw);
      const cw = Math.max(2, Math.round(vw * scale));
      const ch = Math.max(2, Math.round(vh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      const n = Math.max(1, Math.floor(frameCount));
      const frames = [];
      // 避开首尾黑帧:采样点落在 (i+0.5)/n 处
      for (let i = 0; i < n; i++) {
        const t = Math.min(duration - 0.05, (duration * (i + 0.5)) / n);
        await seekTo(video, Math.max(0, t));
        ctx.drawImage(video, 0, 0, cw, ch);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const f = (dataUrl.split(',')[1]) || '';
        if (f) frames.push({ t: Math.round(t * 10) / 10, jpeg: f });
      }
      if (!frames.length) return { ok: false, error: '未能抽取到任何帧' };
      return { ok: true, frames, width: vw, height: vh, duration: Math.round(duration * 10) / 10 };
    } finally {
      try { URL.revokeObjectURL(url); } catch {}
    }
  })();
}

const MIME_BY_EXT = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

// 对外:抽取视频关键帧。
// filePath 本地绝对路径;返回 { ok:true, frames:[{t,jpeg}], width,height,duration } | { ok:false, error }
async function extractVideoFrames(filePath, { frames = DEFAULT_FRAMES, maxWidth = MAX_FRAME_WIDTH, quality = JPEG_QUALITY } = {}) {
  const { BrowserWindow } = require('electron');
  const ext = (path.extname(filePath || '').slice(1) || 'mp4').toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'video/mp4';
  let b64;
  try {
    const st = fs.statSync(filePath);
    if (st.size > MAX_VIDEO_BYTES) return { ok: false, error: '视频超过 ' + Math.round(MAX_VIDEO_BYTES / 1024 / 1024) + 'MB,未做内容分析' };
    b64 = fs.readFileSync(filePath).toString('base64');
  } catch (e) {
    return { ok: false, error: '读取视频失败:' + e.message };
  }
  const win = new BrowserWindow({
    show: false, width: 640, height: 480,
    // webSecurity:false:允许同源策略外加载(本地/媒体资源),本窗口不加载任何外部内容,仅解码本地视频
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: false },
  });
  const timer = setTimeout(() => { try { win.destroy(); } catch {} }, EXTRACT_TIMEOUT_MS);
  try {
    await win.loadURL('about:blank');
    const result = await win.webContents.executeJavaScript(
      `(${extractInPage.toString()})(${JSON.stringify(mime)}, ${JSON.stringify(b64)}, ${frames}, ${maxWidth}, ${quality}, ${SEEK_TIMEOUT_MS})`,
      true
    );
    return result;
  } catch (e) {
    return { ok: false, error: '抽帧失败:' + (e && e.message ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
    try { if (!win.isDestroyed()) win.destroy(); } catch {}
  }
}

module.exports = { extractVideoFrames, DEFAULT_FRAMES, MAX_FRAME_WIDTH, JPEG_QUALITY };
