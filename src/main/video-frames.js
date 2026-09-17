// 视频关键帧抽取(v0.15.12 起):用 Electron 自带 Chromium 的 <video>+<canvas> 解码,
// 不新增原生依赖(Electron 已带 ffmpeg)。在隐藏 BrowserWindow 里加载本地视频,
// 导出 JPEG base64,供「视频辅助模型走图像通道」使用。
// v0.15.13:场景切换检测——先在隐藏窗口内做轻量缩略图差异扫描找镜头边界,
// 再在各场景代表点抽高清帧;边界不足/过多时用分层均匀采样补足/筛选,
// 保证任意时长、任意内容的输出帧数稳定受控且时间分布均匀。
// v0.15.15:禁用均匀抽帧——选点全部由前后帧对比驱动:场景点不足/无场景时
// 用扫描期记录的帧差样本(diff 越高画面变化越大)贪心补齐,段内无场景点用段内
// 帧差最高点兜底;仅在扫描完全失败(无任何帧差数据)时才用最大空隙二分兜底,
// 不再使用 (i+0.5)/n 均匀公式。
// 仅主进程可用(需要 electron);aux-models 通过依赖注入使用,单测不经过本模块。
// 纯函数 framesForDuration/isSceneCut/pickFrameTimes 可脱离 electron 单测;
// 页面内脚本用同一套算法(sceneCutInPage/pickFrameTimesInPage/framesForDurationInPage,逻辑保持一致)。
const path = require('path');
const fs = require('fs');

const MAX_FRAME_WIDTH = 768;       // 帧最大宽度,等比缩放,控制 base64 体积
const JPEG_QUALITY = 0.72;         // JPEG 质量,兼顾清晰度与体积
const SEEK_TIMEOUT_MS = 12000;     // 单帧 seek 超时
const EXTRACT_TIMEOUT_MS = 90000;  // 整个抽帧流程超时(扫描增加 seek 次数)
const MAX_VIDEO_BYTES = 64 * 1024 * 1024; // 读入内存转 blob 的体积上限
const SCAN_MAX_POINTS = 48;        // 场景扫描的缩略采样点上限
const SCAN_MIN_STEP = 0.5;         // 扫描步长下限(秒)
const SCAN_MAX_STEP = 2.5;         // 扫描步长上限(秒)
const SCENE_DIFF_THRESHOLD = 26;   // 场景切换判定的帧差阈值(0~255 标度;淡入淡出渐变通常 8~20,硬切 >35)
const BLACK_LUMA = 8;              // 平均亮度低于此视为全黑帧(黑场是剪辑点不是新场景,不计切换)
const THUMB_W = 64, THUMB_H = 36;  // 扫描用缩略图尺寸(越小越快,够判镜头切换即可)
const FIRST_FRAME_KEEP_S = 1.0;    // 首个场景点距 0 小于此时长则固定保留(封面/标题帧信息密度高)

// 时长分档输出帧数:短视频少取省 token,长视频多取保覆盖;显式传 frames 时以传入值为准。
function framesForDuration(duration) {
  const d = Number(duration);
  if (!isFinite(d) || d <= 0) return 4;
  if (d < 30) return 4;
  if (d < 180) return 6;
  if (d < 600) return 8;
  return 10;
}

// 两个缩略图(RGBA Uint8ClampedArray)的差异判定场景切换。
// 指标:平均绝对亮度差(Y 权重 1.0)+ 每通道 RGB 平均绝对差(各 0.33),归一到 0~255 标度。
// 返回 { cut, diff, luma };luma 为第二张图的平均亮度,全黑帧不计切换(黑场是剪辑点而非新场景)。
function isSceneCut(a, b, threshold = SCENE_DIFF_THRESHOLD) {
  if (!a || !b || !a.length || a.length !== b.length) return { cut: false, diff: 0, luma: 255 };
  const n = a.length / 4;
  let sumY = 0, sumR = 0, sumG = 0, sumB = 0, lumaB = 0;
  for (let i = 0; i < a.length; i += 4) {
    const yA = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    const yB = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
    sumY += Math.abs(yA - yB);
    sumR += Math.abs(a[i] - b[i]);
    sumG += Math.abs(a[i + 1] - b[i + 1]);
    sumB += Math.abs(a[i + 2] - b[i + 2]);
    lumaB += yB;
  }
  const diff = (sumY / n) + 0.33 * ((sumR + sumG + sumB) / 3 / n);
  const luma = lumaB / n;
  if (luma < BLACK_LUMA) return { cut: false, diff, luma };
  return { cut: diff > threshold, diff, luma };
}

// 由场景边界(秒,升序)+ 时长 + 目标帧数 + 帧差样本,选最终采样时间点(秒,升序,长度 ≤ frames)。
// 规则(v0.15.15,禁用均匀抽帧,全部由前后帧对比驱动):
// 候选取各场景中点;首场景点距 0 < FIRST_FRAME_KEEP_S 时固定保留(封面/标题帧);
// 场景少则全保留,先用帧差样本按差值贪心补齐(带最小间隔防扎堆、黑帧排除),
// 仅在完全无帧差数据(扫描失败)时才用最大空隙二分兜底;场景多按时间均匀分层挑 frames 个,
// 段内无场景点改用段内帧差最高点兜底。
// samples: [{t, diff, luma}] — diff 为该扫描点与前一点的缩略图帧差(0~255),luma 为该点亮度。
function pickFrameTimes(duration, sceneBoundaries, frames, samples) {
  const d = Number(duration);
  const n = Math.max(1, Math.floor(frames) || 1);
  if (!isFinite(d) || d <= 0) return [0];
  const cap = Math.max(0, d - 0.05); // 避开末尾黑帧
  const clampT = (t) => Math.min(cap, Math.max(0, t));
  const bounds = (Array.isArray(sceneBoundaries) ? sceneBoundaries : [])
    .map(Number).filter((t) => isFinite(t) && t > 0 && t < d).sort((x, y) => x - y);
  // 场景区间中点作为候选(避开边界本身的过渡帧);无边界时不造内容无关的中点,交给帧差选点
  const cuts = [0, ...bounds, d];
  let candidates = [];
  if (bounds.length) {
    for (let i = 0; i + 1 < cuts.length; i++) {
      const mid = (cuts[i] + cuts[i + 1]) / 2;
      if (mid > 0 && mid < d) candidates.push(mid);
    }
  }
  // 帧差样本:过滤越界/黑帧(黑场不做代表帧),按时间排序
  const diffs = (Array.isArray(samples) ? samples : [])
    .map((s) => ({ t: Number(s && s.t), diff: Number(s && s.diff), luma: Number(s && s.luma) }))
    .filter((s) => isFinite(s.t) && s.t > 0 && s.t < d && isFinite(s.diff))
    .filter((s) => !(s.luma < BLACK_LUMA))
    .sort((x, y) => x.t - y.t);
  const minSep = Math.max(0.5, d / (n * 3)); // 帧差补齐的最小时间间隔,避免挤在一次动作爆发上
  // 按帧差从大到小贪心取点,要求与所有已选点间距 ≥ minSep
  const fillByDiff = (pts, target) => {
    const ranked = diffs.slice().sort((x, y) => y.diff - x.diff);
    for (const s of ranked) {
      if (pts.length >= target) break;
      if (pts.every((t) => Math.abs(t - s.t) >= minSep)) {
        pts.push(s.t);
        pts.sort((x, y) => x - y);
      }
    }
  };
  const picked = [];
  // 首帧保护:封面/标题帧固定保留
  if (candidates.length && candidates[0] < FIRST_FRAME_KEEP_S) picked.push(candidates.shift());
  if (candidates.length + picked.length <= n) {
    // 场景不足/无场景:全保留,先帧差补齐;仍不够(无帧差数据)再最大空隙二分兜底
    const pts = [...picked, ...candidates];
    fillByDiff(pts, n);
    while (pts.length < n) {
      const seq = [0, ...pts, d];
      let gi = 0, gw = -1;
      for (let i = 0; i + 1 < seq.length; i++) {
        const w = seq[i + 1] - seq[i];
        if (w > gw) { gw = w; gi = i; }
      }
      const mid = (seq[gi] + seq[gi + 1]) / 2;
      if (!(mid > 0 && mid < d) || gw <= 0.01) break;
      pts.push(mid);
      pts.sort((x, y) => x - y);
    }
    return dedupSort(pts.map(clampT)).slice(0, n);
  }
  // 场景过多:按时长等分剩余名额段,每段取距段中心最近的候选;段内无场景点用段内帧差最高点兜底,再无才用段中心
  const rest = n - picked.length;
  const chosen = [];
  for (let i = 0; i < rest; i++) {
    const lo = (d * i) / rest, hi = (d * (i + 1)) / rest, center = (lo + hi) / 2;
    let best = null, bd = Infinity;
    for (const c of candidates) {
      if (c < lo || c >= hi) continue;
      const dist = Math.abs(c - center);
      if (dist < bd) { bd = dist; best = c; }
    }
    if (best == null) {
      let bDiff = -1;
      for (const s of diffs) {
        if (s.t < lo || s.t >= hi) continue;
        if (s.diff > bDiff) { bDiff = s.diff; best = s.t; }
      }
    }
    chosen.push(best == null ? center : best);
  }
  return dedupSort([...picked, ...chosen].map(clampT)).slice(0, n);
}

function dedupSort(arr) {
  const s = arr.slice().sort((x, y) => x - y);
  const out = [];
  for (const t of s) if (!out.length || Math.abs(t - out[out.length - 1]) > 0.05) out.push(t);
  return out;
}

// ---- 页面内脚本(序列化注入,自包含,不依赖 Node 侧闭包) --------------------
// 与上面三个纯函数同一算法;改任一侧须同步另一侧。
function framesForDurationInPage(duration) {
  const d = Number(duration);
  if (!isFinite(d) || d <= 0) return 4;
  if (d < 30) return 4;
  if (d < 180) return 6;
  if (d < 600) return 8;
  return 10;
}

function sceneCutInPage(a, b, threshold, blackLuma) {
  if (!a || !b || !a.length || a.length !== b.length) return { cut: false, diff: 0, luma: 255 };
  const n = a.length / 4;
  let sumY = 0, sumR = 0, sumG = 0, sumB = 0, lumaB = 0;
  for (let i = 0; i < a.length; i += 4) {
    const yA = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    const yB = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
    sumY += Math.abs(yA - yB);
    sumR += Math.abs(a[i] - b[i]);
    sumG += Math.abs(a[i + 1] - b[i + 1]);
    sumB += Math.abs(a[i + 2] - b[i + 2]);
    lumaB += yB;
  }
  const diff = (sumY / n) + 0.33 * ((sumR + sumG + sumB) / 3 / n);
  const luma = lumaB / n;
  if (luma < blackLuma) return { cut: false, diff, luma };
  return { cut: diff > threshold, diff, luma };
}

function pickFrameTimesInPage(duration, sceneBoundaries, frames, firstKeepS, samples) {
  const d = Number(duration);
  const n = Math.max(1, Math.floor(frames) || 1);
  if (!isFinite(d) || d <= 0) return [0];
  const cap = Math.max(0, d - 0.05);
  const clampT = (t) => Math.min(cap, Math.max(0, t));
  const bounds = (Array.isArray(sceneBoundaries) ? sceneBoundaries : [])
    .map(Number).filter((t) => isFinite(t) && t > 0 && t < d).sort((x, y) => x - y);
  const cuts = [0, ...bounds, d];
  let candidates = [];
  if (bounds.length) {
    for (let i = 0; i + 1 < cuts.length; i++) {
      const mid = (cuts[i] + cuts[i + 1]) / 2;
      if (mid > 0 && mid < d) candidates.push(mid);
    }
  }
  const diffs = (Array.isArray(samples) ? samples : [])
    .map((s) => ({ t: Number(s && s.t), diff: Number(s && s.diff), luma: Number(s && s.luma) }))
    .filter((s) => isFinite(s.t) && s.t > 0 && s.t < d && isFinite(s.diff))
    .filter((s) => !(s.luma < 8)) // BLACK_LUMA=8,页内自包含不引用 Node 侧常量
    .sort((x, y) => x.t - y.t);
  const minSep = Math.max(0.5, d / (n * 3));
  const fillByDiff = (pts, target) => {
    const ranked = diffs.slice().sort((x, y) => y.diff - x.diff);
    for (const s of ranked) {
      if (pts.length >= target) break;
      if (pts.every((t) => Math.abs(t - s.t) >= minSep)) {
        pts.push(s.t);
        pts.sort((x, y) => x - y);
      }
    }
  };
  const dedup = (arr) => {
    const s = arr.slice().sort((x, y) => x - y), out = [];
    for (const t of s) if (!out.length || Math.abs(t - out[out.length - 1]) > 0.05) out.push(t);
    return out;
  };
  const picked = [];
  if (candidates.length && candidates[0] < firstKeepS) picked.push(candidates.shift());
  if (candidates.length + picked.length <= n) {
    const pts = [...picked, ...candidates];
    fillByDiff(pts, n);
    while (pts.length < n) {
      const seq = [0, ...pts, d];
      let gi = 0, gw = -1;
      for (let i = 0; i + 1 < seq.length; i++) {
        const w = seq[i + 1] - seq[i];
        if (w > gw) { gw = w; gi = i; }
      }
      const mid = (seq[gi] + seq[gi + 1]) / 2;
      if (!(mid > 0 && mid < d) || gw <= 0.01) break;
      pts.push(mid);
      pts.sort((x, y) => x - y);
    }
    return dedup(pts.map(clampT)).slice(0, n);
  }
  const rest = n - picked.length;
  const chosen = [];
  for (let i = 0; i < rest; i++) {
    const lo = (d * i) / rest, hi = (d * (i + 1)) / rest, center = (lo + hi) / 2;
    let best = null, bd = Infinity;
    for (const c of candidates) {
      if (c < lo || c >= hi) continue;
      const dist = Math.abs(c - center);
      if (dist < bd) { bd = dist; best = c; }
    }
    if (best == null) {
      let bDiff = -1;
      for (const s of diffs) {
        if (s.t < lo || s.t >= hi) continue;
        if (s.diff > bDiff) { bDiff = s.diff; best = s.t; }
      }
    }
    chosen.push(best == null ? center : best);
  }
  return dedup([...picked, ...chosen].map(clampT)).slice(0, n);
}

// 在隐藏窗口内执行的抽帧脚本(媒体源以 Blob 注入,避免 file:// 源被 opaque origin 拦截)。
// 返回 { ok, frames:[{t, jpeg}], width, height, duration, scenes, scanned } 或 { ok:false, error }。
// scenes: 检测到的场景数(边界数+1);scanned: 缩略扫描点数(0 表示扫描失败,选点退化为二分兜底)。
function extractInPage(mime, b64, frameCountIn, maxWidth, quality, seekTimeoutMs, optsJson) {
  return (async () => {
    const opts = JSON.parse(optsJson || '{}');
    const THW = opts.thumbW, THH = opts.thumbH;
    const SCAN_MAX = opts.scanMaxPoints, SMIN = opts.scanMinStep, SMAX = opts.scanMaxStep;
    const THRESH = opts.threshold, BLK = opts.blackLuma, FIRST_KEEP = opts.firstKeepS;
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

      // 帧数:显式传入(>0)优先,否则按真实时长分档
      const n = (Math.floor(frameCountIn) > 0) ? Math.floor(frameCountIn) : framesForDurationInPage(duration);

      // ① 缩略扫描找场景切换边界,并记录每个采样点的前后帧差样本(v0.15.15 选点数据源);
      // 扫描中途失败不致命:保留已扫到的部分边界/样本,帧差选点照常工作。
      let boundaries = [], scanned = 0;
      const samples = [];
      try {
        const step = Math.min(SMAX, Math.max(SMIN, duration / SCAN_MAX));
        const pts = Math.max(1, Math.min(SCAN_MAX, Math.floor(duration / step)));
        const tc = document.createElement('canvas');
        tc.width = THW; tc.height = THH;
        const tctx = tc.getContext('2d', { willReadFrequently: true });
        let prev = null, prevT = 0;
        for (let i = 0; i < pts; i++) {
          const t = Math.min(duration - 0.05, Math.max(0, step / 2 + i * step));
          await seekTo(video, t);
          tctx.drawImage(video, 0, 0, THW, THH);
          const data = tctx.getImageData(0, 0, THW, THH).data;
          scanned++;
          if (prev) {
            const r = sceneCutInPage(prev, data, THRESH, BLK);
            if (r.cut) boundaries.push((prevT + t) / 2);
            samples.push({ t, diff: r.diff, luma: r.luma });
          } else {
            samples.push({ t, diff: 0, luma: 255 });
          }
          prev = data; prevT = t;
        }
      } catch (e) {
        // 扫描中断:boundaries/samples 保留已采集部分,不再清空
      }

      // ② 由边界+帧差样本+时长选采样点(无帧差数据时二分兜底,不再均匀采样)
      const times = pickFrameTimesInPage(duration, boundaries, n, FIRST_KEEP, samples);

      // ③ 高清取图
      const scale = Math.min(1, maxWidth / vw);
      const cw = Math.max(2, Math.round(vw * scale));
      const ch = Math.max(2, Math.round(vh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      const frames = [];
      for (const t0 of times) {
        const t = Math.min(duration - 0.05, Math.max(0, t0));
        try {
          await seekTo(video, t);
          ctx.drawImage(video, 0, 0, cw, ch);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          const f = (dataUrl.split(',')[1]) || '';
          if (f) frames.push({ t: Math.round(t * 10) / 10, jpeg: f });
        } catch (e) { /* 单点失败跳过,不阻塞整体 */ }
      }
      if (!frames.length) return { ok: false, error: '未能抽取到任何帧' };
      return { ok: true, frames, width: vw, height: vh, duration: Math.round(duration * 10) / 10, scenes: boundaries.length + 1, scanned };
    } finally {
      try { URL.revokeObjectURL(url); } catch {}
    }
  })();
}

const MIME_BY_EXT = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

// 对外:抽取视频关键帧(场景切换检测 + 时长分档帧数)。
// filePath 本地绝对路径;opts.frames 显式传入(>0)时作为帧数上限,默认 0=auto 按时长分档(4/6/8/10)。
// 返回 { ok:true, frames:[{t,jpeg}], width,height,duration, scenes, scanned } | { ok:false, error }
async function extractVideoFrames(filePath, { frames = 0, maxWidth = MAX_FRAME_WIDTH, quality = JPEG_QUALITY } = {}) {
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
    const optsJson = JSON.stringify({
      thumbW: THUMB_W, thumbH: THUMB_H,
      scanMaxPoints: SCAN_MAX_POINTS, scanMinStep: SCAN_MIN_STEP, scanMaxStep: SCAN_MAX_STEP,
      threshold: SCENE_DIFF_THRESHOLD, blackLuma: BLACK_LUMA, firstKeepS: FIRST_FRAME_KEEP_S,
    });
    const src = `(function(){
      const framesForDurationInPage=${framesForDurationInPage.toString()};
      const sceneCutInPage=${sceneCutInPage.toString()};
      const pickFrameTimesInPage=${pickFrameTimesInPage.toString()};
      const extractInPage=${extractInPage.toString()};
      return extractInPage(${JSON.stringify(mime)}, ${JSON.stringify(b64)}, ${Math.floor(frames) || 0}, ${maxWidth}, ${quality}, ${SEEK_TIMEOUT_MS}, ${JSON.stringify(optsJson)});
    })()`;
    return await win.webContents.executeJavaScript(src, true);
  } catch (e) {
    return { ok: false, error: '抽帧失败:' + (e && e.message ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
    try { if (!win.isDestroyed()) win.destroy(); } catch {}
  }
}

module.exports = {
  extractVideoFrames, framesForDuration, pickFrameTimes, isSceneCut,
  MAX_FRAME_WIDTH, JPEG_QUALITY,
  SCAN_MAX_POINTS, SCENE_DIFF_THRESHOLD, EXTRACT_TIMEOUT_MS,
};
