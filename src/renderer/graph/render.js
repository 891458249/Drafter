// 渲染驱动(md「渲染驱动与失效机制」「原生绘制图层顺序管线」):
// Canvas 2D 双通道脏标记渲染——背景通道(网格/分组底色/连线)与前景通道
// (节点 8 层管线/选框/临时交互图元)分画布叠加,仅脏通道重绘,空闲零占用。
// 视口变换与 DPI 级联进根变换矩阵;视口 AABB 剔除 + LOD 三级精简。

import { toScreen, viewAABB, lod } from './viewport.js';
import { bezierControls, rectsIntersect } from './geom.js';
import { LAYOUT, slotPos, slotLabel, widgetBounds } from './model.js';

// 节点类型配色(Bifrost/ComfyUI 风格,标题色块 + 端口圆点)
export const TYPE_COLORS = {
  text: '#3fb68b', llmtext: '#b58cff', upload: '#e8b339', image: '#58a6ff',
  video: '#f778ba', audio: '#d29922', model3d: '#76e3ea', external: '#a371f7', unknown: '#8b949e',
};
const TYPE_LABEL = {
  text: '文本', llmtext: '文本生成', upload: '参考图', image: '图片生成',
  video: '视频生成', audio: '音频生成', model3d: '3D 生成', external: 'ComfyUI', unknown: '未知',
};
const SLOT_TYPE_COLORS = {
  text: '#3fb68b', image: '#58a6ff', video: '#f778ba', audio: '#d29922', model: '#76e3ea',
  MODEL: '#a371f7', LATENT: '#f778ba', CONDITIONING: '#e8b339', CLIP: '#b58cff', VAE: '#d29922',
  IMAGE: '#58a6ff', MASK: '#8b949e', '*': '#c9d1d9',
};
const C = {
  bg: '#14161b', grid: '#22262e', groupFill: 'rgba(88,166,255,0.06)', groupBorder: 'rgba(88,166,255,0.35)',
  nodeBody: 'rgba(33,38,45,0.96)', nodeBorder: '#3d444d', nodeShadow: 'rgba(0,0,0,0.45)',
  titleText: '#f0f3f6', slotText: '#c9d1d9', widgetBg: '#161b22', widgetBorder: '#30363d',
  select: '#58a6ff', linkDefault: '#8b949e', bypass: '#da77f2', muted: '#6e7681',
  error: '#f85149', progress: '#3fb950',
};
const GRID_STEP = 24;
const LINK_HIT_TOL = 8;   // 连线拾取阈值(px,世界坐标,拾取在交互层换算)
export const SNAP_GUIDE_TOL = 6;

export function createRenderer(host, model, viewport, hooks = {}) {
  // 双通道:背景画布(网格/分组/连线) + 前景画布(节点/交互),绝对定位叠加
  host.style.position = host.style.position || 'relative';
  const bgCanvas = document.createElement('canvas');
  const fgCanvas = document.createElement('canvas');
  for (const c of [bgCanvas, fgCanvas]) {
    c.style.position = 'absolute';
    c.style.inset = '0';
    c.style.width = '100%';
    c.style.height = '100%';
    host.appendChild(c);
  }
  bgCanvas.style.zIndex = '0';
  fgCanvas.style.zIndex = '1';
  fgCanvas.style.pointerEvents = 'none'; // 指针事件统一由 host 上的交互层捕获
  const bgCtx = bgCanvas.getContext('2d');
  const fgCtx = fgCanvas.getContext('2d');

  const r = {
    canvas: fgCanvas, bgCanvas, fgCanvas,
    selection: new Set(),        // 选中节点 id
    hoverSlot: null,             // {nodeId, kind, index} 引脚吸附高亮
    dragLink: null,              // {from:{x,y}, to:{x,y}, valid} 世界坐标临时连线
    marquee: null,               // 世界坐标框选矩形
    guides: [],                  // 智能参考线 [{axis:'x'|'y', pos}]
    execState: new Map(),        // nodeId → {status, progress} 执行高亮/进度
    errors: new Map(),           // nodeId → [消息] 校验错误角标
    previewImages: new Map(),    // nodeId → HTMLImageElement(由集成层注入)
    dirtyBg: true, dirtyFg: true, dirtyMini: true,
    running: false,
  };

  let cssW = 0, cssH = 0, dpr = 1;
  function resize() {
    const rect = host.getBoundingClientRect();
    cssW = Math.max(1, rect.width);
    cssH = Math.max(1, rect.height);
    dpr = window.devicePixelRatio || 1; // md「高分屏」:逻辑点计算,物理像素仅级联在根矩阵
    for (const c of [bgCanvas, fgCanvas]) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    }
    r.dirtyBg = r.dirtyFg = r.dirtyMini = true;
    schedule();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  // ---------------------------------------------------------------------------
  // 主循环:rAF 合帧,仅脏通道重绘;有执行动画时持续驱动正弦脉冲
  // ---------------------------------------------------------------------------
  let rafId = null;
  function schedule() {
    if (!r.running || rafId != null) return;
    rafId = requestAnimationFrame(frame);
  }
  function frame(t) {
    rafId = null;
    if (r.dirtyBg) { drawBackground(); r.dirtyBg = false; }
    if (r.dirtyFg) { drawForeground(t); r.dirtyFg = false; }
    if (r.dirtyMini) { drawMinimap(); r.dirtyMini = false; }
    // 执行中节点的脉冲高亮需要持续重绘前景
    if ([...r.execState.values()].some((s) => s.status === 'running')) {
      r.dirtyFg = true;
      schedule();
    }
  }
  r.invalidate = (channel = 'all') => {
    if (channel === 'all' || channel === 'bg') r.dirtyBg = true;
    if (channel === 'all' || channel === 'fg') r.dirtyFg = true;
    if (channel === 'all' || channel === 'mini') r.dirtyMini = true;
    schedule();
  };
  r.start = () => { r.running = true; r.invalidate(); };
  r.stop = () => { r.running = false; if (rafId != null) cancelAnimationFrame(rafId); rafId = null; };
  r.destroy = () => { r.stop(); ro.disconnect(); bgCanvas.remove(); fgCanvas.remove(); };
  r.viewSize = () => ({ w: cssW, h: cssH, dpr });

  r.setExecState = (nodeId, st) => {
    if (st) r.execState.set(String(nodeId), st);
    else r.execState.delete(String(nodeId));
    r.invalidate('fg');
  };
  r.setNodeErrors = (nodeId, errs) => {
    if (errs && errs.length) r.errors.set(String(nodeId), errs);
    else r.errors.delete(String(nodeId));
    r.invalidate('fg');
  };
  r.setPreviewImage = (nodeId, img) => {
    if (img) r.previewImages.set(String(nodeId), img);
    else r.previewImages.delete(String(nodeId));
    r.invalidate('fg');
  };

  // 应用视口+DPI 根变换:screen = world*scale + offset,再级联 dpr(md「双向仿射变换数学模型」)
  function applyTransform(ctx) {
    ctx.setTransform(dpr * viewport.scale, 0, 0, dpr * viewport.scale, dpr * viewport.tx, dpr * viewport.ty);
  }

  // ---------------------------------------------------------------------------
  // 背景通道:网格 → 分组框 → 连线
  // ---------------------------------------------------------------------------
  function drawBackground() {
    bgCtx.setTransform(1, 0, 0, 1, 0, 0);
    bgCtx.fillStyle = C.bg;
    bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
    const level = lod(viewport);
    const view = viewAABB(viewport, cssW, cssH);
    applyTransform(bgCtx);

    if (level < 2) drawGrid(view);
    for (const group of model.groups.values()) drawGroup(group, level);
    for (const link of model.links.values()) drawLink(link, level, view);
  }

  function drawGrid(view) {
    bgCtx.fillStyle = C.grid;
    const step = GRID_STEP;
    const x0 = Math.floor(view.x / step) * step, y0 = Math.floor(view.y / step) * step;
    const dot = Math.max(1, viewport.scale * 0.8) / viewport.scale; // 屏幕上恒定 ~1px 圆点
    for (let x = x0; x < view.x + view.w; x += step) {
      for (let y = y0; y < view.y + view.h; y += step) {
        bgCtx.fillRect(x - dot / 2, y - dot / 2, dot, dot);
      }
    }
  }

  function drawGroup(group, level) {
    bgCtx.fillStyle = group.color ? hexAlpha(group.color, 0.12) : C.groupFill;
    bgCtx.strokeStyle = group.color ? hexAlpha(group.color, 0.5) : C.groupBorder;
    bgCtx.lineWidth = 1 / viewport.scale;
    bgCtx.fillRect(group.rect.x, group.rect.y, group.rect.w, group.rect.h);
    bgCtx.strokeRect(group.rect.x, group.rect.y, group.rect.w, group.rect.h);
    if (level === 0 && group.title) {
      bgCtx.fillStyle = 'rgba(240,243,246,0.75)';
      bgCtx.font = '600 16px system-ui, sans-serif';
      bgCtx.fillText(group.title, group.rect.x + 10, group.rect.y + 24);
    }
  }

  function linkEnds(link) {
    const src = model.nodes.get(link.from);
    const dst = model.nodes.get(link.to);
    if (!src || !dst) return null;
    const sp = slotPos(src, 'output', link.fromSlot);
    const tp = slotPos(dst, 'input', link.toSlot);
    return {
      p0: { x: src.pos.x + sp.x, y: src.pos.y + sp.y },
      p3: { x: dst.pos.x + tp.x, y: dst.pos.y + tp.y },
      src, dst,
    };
  }

  function drawLink(link, level, view) {
    const ends = linkEnds(link);
    if (!ends) return;
    // 剔除:两端节点均在视口外且线段包围盒与视口不相交
    const minX = Math.min(ends.p0.x, ends.p3.x), maxX = Math.max(ends.p0.x, ends.p3.x);
    const minY = Math.min(ends.p0.y, ends.p3.y), maxY = Math.max(ends.p0.y, ends.p3.y);
    if (!rectsIntersect({ x: minX - 80, y: minY - 80, w: maxX - minX + 160, h: maxY - minY + 160 }, view)) return;
    bgCtx.strokeStyle = SLOT_TYPE_COLORS[link.type] || C.linkDefault;
    bgCtx.lineWidth = (level === 2 ? 2.5 : 2) / viewport.scale;
    bgCtx.beginPath();
    bgCtx.moveTo(ends.p0.x, ends.p0.y);
    if (level === 2) {
      bgCtx.lineTo(ends.p3.x, ends.p3.y); // 极简宏观:降级为直线
    } else {
      const c = bezierControls(ends.p0, ends.p3, level === 1 ? 24 : 40); // 概览收紧控制点
      bgCtx.bezierCurveTo(c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y);
    }
    bgCtx.stroke();
  }

  // ---------------------------------------------------------------------------
  // 前景通道:节点 8 层管线 → 交互叠加层(框选/临时连线/参考线)
  // ---------------------------------------------------------------------------
  function drawForeground(t) {
    fgCtx.setTransform(1, 0, 0, 1, 0, 0);
    fgCtx.clearRect(0, 0, fgCanvas.width, fgCanvas.height);
    const level = lod(viewport);
    const view = viewAABB(viewport, cssW, cssH);
    applyTransform(fgCtx);
    for (const node of model.nodes.values()) {
      const rect = { x: node.pos.x, y: node.pos.y, w: node.size.w, h: node.size.h };
      if (!rectsIntersect(rect, view)) continue; // md「视口剔除」:视口外完全跳过
      drawNode(node, level, t);
    }
    drawOverlay(level);
  }

  // 单节点 8 层:投影→底板→背景钩子→标题栏→端口→控件→前景钩子→轮廓选框
  function drawNode(node, level, t) {
    const { x, y } = node.pos;
    const { w, h } = node.size;
    const status = (node.data && node.data.nodeStatus) || 'normal';
    const muted = status === 'disabled';
    const bypass = status === 'bypass';
    const color = node.color || TYPE_COLORS[node.type] || TYPE_COLORS.unknown;

    fgCtx.save();
    if (muted) fgCtx.globalAlpha = 0.4; // Mute:全局透明度降 40%

    // 1. 投影层
    fgCtx.shadowColor = C.nodeShadow;
    fgCtx.shadowBlur = level === 0 ? 12 * viewport.scale : 0;
    fgCtx.shadowOffsetY = 3 * viewport.scale;
    // 2. 底板层
    roundRect(fgCtx, x, y, w, h, 8);
    fgCtx.fillStyle = C.nodeBody;
    fgCtx.fill();
    fgCtx.shadowColor = 'transparent';
    fgCtx.shadowBlur = 0;
    fgCtx.shadowOffsetY = 0;

    if (level === 2) {
      // 极简宏观:纯色外壳 + 标题色条,跳过一切文字测量与绘制
      fgCtx.fillStyle = hexAlpha(color, 0.55);
      roundRect(fgCtx, x, y, w, Math.min(10, h), 5);
      fgCtx.fill();
      fgCtx.restore();
      return;
    }

    // 3. 背景钩子:媒体预览(Letterbox 等比居中)
    const img = r.previewImages.get(node.id);
    const previewH = node.collapsed ? 0 : (Number(node.previewH) || 0);
    if (previewH > 0) {
      const py = y + h - LAYOUT.PAD_BOTTOM - previewH;
      fgCtx.fillStyle = '#0d1117';
      fgCtx.fillRect(x + 6, py, w - 12, previewH);
      if (img && img.complete && img.naturalWidth) {
        const s = Math.min((w - 12) / img.naturalWidth, previewH / img.naturalHeight);
        const iw = img.naturalWidth * s, ih = img.naturalHeight * s;
        fgCtx.drawImage(img, x + 6 + (w - 12 - iw) / 2, py + (previewH - ih) / 2, iw, ih);
      }
    }

    // 4. 标题栏:色块 + 折叠指示 + 标题文本 + 模式标示
    fgCtx.fillStyle = hexAlpha(color, 0.85);
    roundRect(fgCtx, x, y, w, LAYOUT.TITLE_H, 8);
    fgCtx.fill();
    fgCtx.fillRect(x, y + LAYOUT.TITLE_H - 8, w, 8); // 标题下缘补方角
    fgCtx.fillStyle = C.titleText;
    fgCtx.font = '600 13px system-ui, sans-serif';
    fgCtx.textBaseline = 'middle';
    const title = node.title || node.data?.comfyDisplayName || TYPE_LABEL[node.type] || node.classType;
    fgCtx.fillText((node.collapsed ? '▸ ' : '▾ ') + title, x + LAYOUT.PAD_X, y + LAYOUT.TITLE_H / 2, w - LAYOUT.PAD_X * 2 - 20);
    if (bypass) {
      fgCtx.fillStyle = C.bypass;
      fgCtx.font = '11px system-ui, sans-serif';
      fgCtx.textAlign = 'right';
      fgCtx.fillText('⤳ 忽略', x + w - LAYOUT.PAD_X, y + LAYOUT.TITLE_H / 2);
      fgCtx.textAlign = 'left';
    }

    if (!node.collapsed) {
      if (level === 0) {
        drawSlots(node);   // 5. 端口插槽层
        drawWidgets(node); // 6. 组件内容层
      } else {
        // 概览:只画端口圆点,跳控件
        for (let i = 0; i < node.inputs.length; i++) drawSlotDot(node, 'input', i);
        for (let i = 0; i < node.outputs.length; i++) drawSlotDot(node, 'output', i);
      }
    }

    // 7. 前景钩子:执行脉冲 + 进度条 + 错误角标
    const exec = r.execState.get(node.id);
    if (exec && exec.status === 'running') {
      const pulse = 0.5 + 0.5 * Math.sin(t / 280); // md:正弦调制周期性脉冲发光框
      fgCtx.strokeStyle = hexAlpha('#3fb950', 0.35 + 0.55 * pulse);
      fgCtx.lineWidth = (2.5 + 1.5 * pulse) / viewport.scale;
      roundRect(fgCtx, x - 2, y - 2, w + 4, h + 4, 10);
      fgCtx.stroke();
      if (typeof exec.progress === 'number') {
        fgCtx.fillStyle = hexAlpha(C.progress, 0.9);
        fgCtx.fillRect(x + 6, y + h - LAYOUT.PAD_BOTTOM - 4, (w - 12) * Math.min(1, Math.max(0, exec.progress)), 4);
      }
    }
    const errs = r.errors.get(node.id);
    if (errs && errs.length) {
      fgCtx.fillStyle = C.error;
      fgCtx.beginPath();
      fgCtx.arc(x + w - 10, y - 2, 8 / viewport.scale > 1 ? 8 : 8 / viewport.scale, 0, Math.PI * 2);
      fgCtx.fill();
      fgCtx.fillStyle = '#fff';
      fgCtx.font = 'bold 11px system-ui';
      fgCtx.textAlign = 'center';
      fgCtx.fillText('!', x + w - 10, y - 2);
      fgCtx.textAlign = 'left';
    }

    // 8. 外层轮廓与选框
    fgCtx.lineWidth = (r.selection.has(node.id) ? 2 : 1) / viewport.scale;
    if (bypass) {
      fgCtx.strokeStyle = C.bypass; // Bypass:紫粉醒目边框
      fgCtx.setLineDash([6 / viewport.scale, 4 / viewport.scale]);
    } else if (muted) {
      fgCtx.strokeStyle = C.muted;
      fgCtx.setLineDash([4 / viewport.scale, 4 / viewport.scale]);
    } else {
      fgCtx.strokeStyle = r.selection.has(node.id) ? C.select : C.nodeBorder;
    }
    roundRect(fgCtx, x, y, w, h, 8);
    fgCtx.stroke();
    fgCtx.setLineDash([]);
    // Bypass 直通虚线:输入原样拷贝至输出的视觉语义
    if (bypass && node.inputs.length && node.outputs.length && level === 0) {
      fgCtx.strokeStyle = hexAlpha(C.bypass, 0.6);
      fgCtx.setLineDash([3, 3]);
      const sp = slotPos(node, 'output', 0);
      for (let i = 0; i < node.inputs.length; i++) {
        const tp = slotPos(node, 'input', i);
        fgCtx.beginPath();
        fgCtx.moveTo(x + tp.x + 6, y + tp.y);
        fgCtx.lineTo(x + sp.x - 6, y + sp.y);
        fgCtx.stroke();
      }
      fgCtx.setLineDash([]);
    }
    // 选中态尺寸调整抓手(右下角)
    if (r.selection.has(node.id) && level === 0 && !node.collapsed) {
      fgCtx.fillStyle = C.select;
      fgCtx.beginPath();
      fgCtx.moveTo(x + w, y + h);
      fgCtx.lineTo(x + w - 10, y + h);
      fgCtx.lineTo(x + w, y + h - 10);
      fgCtx.closePath();
      fgCtx.fill();
    }
    fgCtx.restore();
  }

  function drawSlots(node) {
    for (let i = 0; i < node.inputs.length; i++) {
      drawSlotDot(node, 'input', i);
      const slot = node.inputs[i];
      const p = slotPos(node, 'input', i);
      fgCtx.fillStyle = slot.link != null ? C.slotText : hexAlpha('#c9d1d9', 0.55);
      fgCtx.font = '12px system-ui, sans-serif';
      fgCtx.textAlign = 'left';
      fgCtx.fillText(slotLabel(slot), node.pos.x + 12, node.pos.y + p.y);
    }
    for (let i = 0; i < node.outputs.length; i++) {
      drawSlotDot(node, 'output', i);
      const p = slotPos(node, 'output', i);
      fgCtx.fillStyle = C.slotText;
      fgCtx.font = '12px system-ui, sans-serif';
      fgCtx.textAlign = 'right';
      fgCtx.fillText(slotLabel(node.outputs[i]), node.pos.x + p.x - 12, node.pos.y + p.y);
      fgCtx.textAlign = 'left';
    }
  }

  function drawSlotDot(node, kind, index) {
    const slot = kind === 'input' ? node.inputs[index] : node.outputs[index];
    const p = slotPos(node, kind, index);
    const hovered = r.hoverSlot && r.hoverSlot.nodeId === node.id && r.hoverSlot.kind === kind && r.hoverSlot.index === index;
    fgCtx.beginPath();
    fgCtx.arc(node.pos.x + p.x, node.pos.y + p.y, hovered ? 7 : 5, 0, Math.PI * 2);
    fgCtx.fillStyle = SLOT_TYPE_COLORS[slot.type] || C.linkDefault;
    fgCtx.fill();
    if (hovered) { // 吸附高亮外发光
      fgCtx.strokeStyle = '#fff';
      fgCtx.lineWidth = 2 / viewport.scale;
      fgCtx.stroke();
    }
  }

  function drawWidgets(node) {
    node.widgets.forEach((wd, i) => {
      const b = widgetBounds(node, i);
      const x = node.pos.x + b.x, y = node.pos.y + b.y;
      roundRect(fgCtx, x, y, b.w, b.h, 4);
      fgCtx.fillStyle = C.widgetBg;
      fgCtx.fill();
      fgCtx.strokeStyle = C.widgetBorder;
      fgCtx.lineWidth = 1 / viewport.scale;
      fgCtx.stroke();
      fgCtx.fillStyle = hexAlpha('#c9d1d9', 0.8);
      fgCtx.font = '11px system-ui, sans-serif';
      fgCtx.textBaseline = 'middle';
      fgCtx.fillText(wd.name, x + 8, y + b.h / 2, b.w * 0.45);
      fgCtx.textAlign = 'right';
      fgCtx.fillStyle = C.titleText;
      if (wd.kind === 'BOOLEAN') {
        fgCtx.fillText(wd.value ? '✓ 开' : '✕ 关', x + b.w - 8, y + b.h / 2);
      } else if ((wd.kind === 'INT' || wd.kind === 'FLOAT') && wd.min != null && wd.max != null) {
        // 数值滑块:导轨 + 进度填充 + 数值文本
        const ratio = Math.min(1, Math.max(0, (Number(wd.value) - wd.min) / (wd.max - wd.min || 1)));
        fgCtx.fillStyle = hexAlpha('#58a6ff', 0.3);
        fgCtx.fillRect(x + 2, y + b.h - 5, (b.w - 4) * ratio, 3);
        fgCtx.fillStyle = C.titleText;
        fgCtx.fillText(String(wd.value ?? ''), x + b.w - 8, y + b.h / 2);
      } else {
        const text = String(wd.value ?? '');
        fgCtx.fillText(text.length > 18 ? text.slice(0, 17) + '…' : text, x + b.w - 8, y + b.h / 2, b.w * 0.5);
        if (wd.options && wd.options.length) fgCtx.fillText('▾', x + b.w - 2 - 4, y + b.h / 2);
      }
      fgCtx.textAlign = 'left';
    });
  }

  // 交互叠加层:临时连线/框选/智能参考线(世界坐标)
  function drawOverlay(level) {
    if (r.dragLink) {
      const d = r.dragLink;
      fgCtx.strokeStyle = d.valid === false ? C.error : C.select;
      fgCtx.lineWidth = 2 / viewport.scale;
      fgCtx.setLineDash([6 / viewport.scale, 4 / viewport.scale]);
      fgCtx.beginPath();
      fgCtx.moveTo(d.from.x, d.from.y);
      const c = bezierControls(d.from, d.to);
      fgCtx.bezierCurveTo(c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y);
      fgCtx.stroke();
      fgCtx.setLineDash([]);
    }
    if (r.marquee) {
      const q = r.marquee;
      fgCtx.fillStyle = 'rgba(88,166,255,0.08)';
      fgCtx.strokeStyle = C.select;
      fgCtx.lineWidth = 1 / viewport.scale;
      fgCtx.setLineDash([5 / viewport.scale, 4 / viewport.scale]);
      fgCtx.fillRect(q.x, q.y, q.w, q.h);
      fgCtx.strokeRect(q.x, q.y, q.w, q.h);
      fgCtx.setLineDash([]);
    }
    if (r.guides.length && level === 0) {
      const view = viewAABB(viewport, cssW, cssH);
      fgCtx.strokeStyle = '#f778ba';
      fgCtx.lineWidth = 1 / viewport.scale;
      fgCtx.setLineDash([4 / viewport.scale, 4 / viewport.scale]);
      for (const g of r.guides) {
        fgCtx.beginPath();
        if (g.axis === 'x') { fgCtx.moveTo(g.pos, view.y); fgCtx.lineTo(g.pos, view.y + view.h); }
        else { fgCtx.moveTo(view.x, g.pos); fgCtx.lineTo(view.x + view.w, g.pos); }
        fgCtx.stroke();
      }
      fgCtx.setLineDash([]);
    }
  }

  // ---------------------------------------------------------------------------
  // 鹰眼图(md「Minimap 双向视口映射」):全局包围盒收敛 → 等比缩放 → 色块 + 视口线框
  // ---------------------------------------------------------------------------
  let miniTransform = null; // {scale, ox, oy} 世界 → 小地图像素
  function contentBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of model.nodes.values()) {
      minX = Math.min(minX, node.pos.x); minY = Math.min(minY, node.pos.y);
      maxX = Math.max(maxX, node.pos.x + node.size.w); maxY = Math.max(maxY, node.pos.y + node.size.h);
    }
    const view = viewAABB(viewport, cssW, cssH);
    minX = Math.min(minX, view.x); minY = Math.min(minY, view.y);
    maxX = Math.max(maxX, view.x + view.w); maxY = Math.max(maxY, view.y + view.h);
    if (!isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1 };
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }

  function drawMinimap() {
    const mini = hooks.minimapCanvas;
    if (!mini) return;
    const mw = mini.clientWidth || 180, mh = mini.clientHeight || 120;
    const mdpr = window.devicePixelRatio || 1;
    if (mini.width !== Math.round(mw * mdpr)) { mini.width = Math.round(mw * mdpr); mini.height = Math.round(mh * mdpr); }
    const ctx = mini.getContext('2d');
    ctx.setTransform(mdpr, 0, 0, mdpr, 0, 0);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, mw, mh);
    const bounds = contentBounds();
    const scale = Math.min((mw - 8) / bounds.w, (mh - 8) / bounds.h);
    const ox = (mw - bounds.w * scale) / 2 - bounds.x * scale;
    const oy = (mh - bounds.h * scale) / 2 - bounds.y * scale;
    miniTransform = { scale, ox, oy };
    for (const node of model.nodes.values()) {
      ctx.fillStyle = hexAlpha(node.color || TYPE_COLORS[node.type] || TYPE_COLORS.unknown, 0.8);
      ctx.fillRect(node.pos.x * scale + ox, node.pos.y * scale + oy, Math.max(2, node.size.w * scale), Math.max(2, node.size.h * scale));
    }
    // 当前视口线框
    const view = viewAABB(viewport, cssW, cssH);
    ctx.strokeStyle = C.select;
    ctx.lineWidth = 1;
    ctx.strokeRect(view.x * scale + ox, view.y * scale + oy, view.w * scale, view.h * scale);
  }

  // 小地图像素 → 世界坐标(交互层拖动漫游用)
  r.miniToWorld = (p) => {
    if (!miniTransform) return null;
    return { x: (p.x - miniTransform.ox) / miniTransform.scale, y: (p.y - miniTransform.oy) / miniTransform.scale };
  };
  r.worldToMini = (p) => {
    if (!miniTransform) return null;
    return { x: p.x * miniTransform.scale + miniTransform.ox, y: p.y * miniTransform.scale + miniTransform.oy };
  };
  r.linkEnds = linkEnds;
  r.typeColor = (node) => node.color || TYPE_COLORS[node.type] || TYPE_COLORS.unknown;

  return r;
}

function roundRect(ctx, x, y, w, h, radius) {
  const rad = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function hexAlpha(hex, alpha) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const r2 = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r2},${g},${b},${alpha})`;
}
