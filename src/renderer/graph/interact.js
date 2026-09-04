// 交互系统(md「交互系统、空间编排与导航导览」):
// 指针状态机(idle→pending→deadband→drag/connect/marquee/pan)、四阶连接验证+引脚吸附、
// 网格吸附+智能参考线、分组联动、minimap 双向漫游、框选、快捷键。
// hitTest 为纯函数(node --test 可测);DOM 事件层在 attach() 里。

import { toWorld, zoomAt, panBy } from './viewport.js';
import { rectContains, rectsIntersect, distToBezier, bezierControls, snapToGrid } from './geom.js';
import { LAYOUT, slotPos, widgetBounds, validateConnection, connect, disconnect, computeSize, moveGroup, groupsOfNode, snapNodePos } from './model.js';

const DEADBAND = 4;        // 点击死区(px,曼哈顿距离,md「指针微小物理抖动」)
const SLOT_HIT_R = 10;     // 插槽命中半径(世界 px,基准 scale=1)
const LINK_HIT_R = 8;      // 连线拾取阈值
const SNAP_DIST = 16;      // 引脚智能吸附半径
const GUIDE_TOL = 6;       // 智能参考线吸附阈值
const GROUP_TITLE_H = 28;  // 分组框标题条高度

// ---------------------------------------------------------------------------
// 命中检测(纯函数):slot > widget > 节点体 > 连线 > 分组 > 空白
// ---------------------------------------------------------------------------
export function hitTest(model, pt, scale = 1, opts = {}) {
  const slotR = SLOT_HIT_R / scale;
  // 节点倒序(后添加的在顶层)
  const nodes = [...model.nodes.values()].reverse();
  for (const node of nodes) {
    const pad = 8 / scale;
    const r = { x: node.pos.x - pad, y: node.pos.y - pad, w: node.size.w + pad * 2, h: node.size.h + pad * 2 };
    if (!rectContains(r, pt)) continue;
    // 选中节点的尺寸抓手(右下角三角区)
    if (opts.selected && opts.selected.has(node.id) && !node.collapsed) {
      const gx = node.pos.x + node.size.w, gy = node.pos.y + node.size.h;
      if (pt.x >= gx - 14 / scale && pt.y >= gy - 14 / scale) return { type: 'resize', node };
    }
    for (let i = 0; i < node.inputs.length; i++) {
      const p = slotPos(node, 'input', i);
      if (Math.hypot(pt.x - node.pos.x - p.x, pt.y - node.pos.y - p.y) <= slotR) return { type: 'slot', node, kind: 'input', index: i };
    }
    for (let i = 0; i < node.outputs.length; i++) {
      const p = slotPos(node, 'output', i);
      if (Math.hypot(pt.x - node.pos.x - p.x, pt.y - node.pos.y - p.y) <= slotR) return { type: 'slot', node, kind: 'output', index: i };
    }
    if (!rectContains({ x: node.pos.x, y: node.pos.y, w: node.size.w, h: node.size.h }, pt)) continue;
    if (pt.y < node.pos.y + LAYOUT.TITLE_H) return { type: 'title', node };
    if (!node.collapsed) {
      for (let i = 0; i < node.widgets.length; i++) {
        const b = widgetBounds(node, i);
        if (rectContains({ x: node.pos.x + b.x, y: node.pos.y + b.y, w: b.w, h: b.h }, pt)) return { type: 'widget', node, widget: node.widgets[i], index: i };
      }
    }
    return { type: 'node', node };
  }
  // 连线拾取:贝塞尔打散为线段,最短距离判定
  for (const link of model.links.values()) {
    const ends = linkEndsOf(model, link);
    if (!ends) continue;
    if (distToBezier(pt, bezierControls(ends.p0, ends.p3)) <= LINK_HIT_R / scale) return { type: 'link', link };
  }
  // 分组:标题条可拖动,内部区域命中分组
  for (const group of [...model.groups.values()].reverse()) {
    const r = group.rect;
    if (!rectContains({ x: r.x, y: r.y, w: r.w, h: r.h }, pt)) continue;
    if (pt.y < r.y + GROUP_TITLE_H) return { type: 'group-title', group };
    return { type: 'group', group };
  }
  return { type: 'canvas' };
}

export function linkEndsOf(model, link) {
  const src = model.nodes.get(link.from);
  const dst = model.nodes.get(link.to);
  if (!src || !dst) return null;
  const sp = slotPos(src, 'output', link.fromSlot);
  const tp = slotPos(dst, 'input', link.toSlot);
  return {
    p0: { x: src.pos.x + sp.x, y: src.pos.y + sp.y },
    p3: { x: dst.pos.x + tp.x, y: dst.pos.y + tp.y },
  };
}

// 智能参考线:拖动节点时提取其关键边界(左/中/右/顶/底),与周边节点比对吸附
export function smartGuides(model, draggedIds, rect, scale) {
  const tol = GUIDE_TOL / scale;
  const dragged = new Set(draggedIds);
  const myX = [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
  const myY = [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
  let bestX = null, bestY = null;
  for (const node of model.nodes.values()) {
    if (dragged.has(node.id)) continue;
    const nx = [node.pos.x, node.pos.x + node.size.w / 2, node.pos.x + node.size.w];
    const ny = [node.pos.y, node.pos.y + node.size.h / 2, node.pos.y + node.size.h];
    for (const a of myX) for (const b of nx) {
      const d = b - a;
      if (Math.abs(d) <= tol && (!bestX || Math.abs(d) < Math.abs(bestX.delta))) bestX = { delta: d, pos: b };
    }
    for (const a of myY) for (const b of ny) {
      const d = b - a;
      if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < Math.abs(bestY.delta))) bestY = { delta: d, pos: b };
    }
  }
  return { dx: bestX ? bestX.delta : 0, dy: bestY ? bestY.delta : 0, guides: [bestX && { axis: 'x', pos: bestX.pos }, bestY && { axis: 'y', pos: bestY.pos }].filter(Boolean) };
}

// ---------------------------------------------------------------------------
// DOM 事件绑定
// ---------------------------------------------------------------------------
// hooks: {
//   getGridStep(): 0|10|50; onSelectionChange(ids); onChange(kind); onHistorySnapshot()（拓扑变更前）;
//   onWidgetEdit(node, widget, screenRect, commit); onNodeAction(node, action);
//   onCanvasDoubleClick(worldPt); onContextMenu(target, evt); onLinkClick(link, evt);
//   beforeTopologyChange(); afterChange();
// }
export function attach(host, model, viewport, renderer, hooks = {}) {
  const state = {
    mode: 'idle',          // idle|pending|drag-node|pan|marquee|connect|resize|drag-group
    startScreen: null, startWorld: null, hit: null,
    dragOrigin: null,      // 节点拖拽起始位置 Map(id → {x,y})
    moved: false,
    connectFrom: null,     // {nodeId, kind, index, worldPos}
    resizeStart: null,
    spaceDown: false,
  };
  const gridStep = () => (hooks.getGridStep ? hooks.getGridStep() : 0);

  function screenPt(evt) {
    const r = host.getBoundingClientRect();
    return { x: evt.clientX - r.left, y: evt.clientY - r.top };
  }

  function emitChange(kind) { hooks.onChange && hooks.onChange(kind); }
  function snapshot() { hooks.beforeTopologyChange && hooks.beforeTopologyChange(); }

  // ---------------------------------------------------------------------------
  // 指针按下:命中检测分发状态机
  // ---------------------------------------------------------------------------
  function onPointerDown(evt) {
    if (evt.button === 1 || (evt.button === 0 && state.spaceDown)) {
      state.mode = 'pan';
      state.startScreen = screenPt(evt);
      host.setPointerCapture(evt.pointerId);
      evt.preventDefault();
      return;
    }
    if (evt.button !== 0) return;
    const sp = screenPt(evt);
    const wp = toWorld(viewport, sp);
    const hit = hitTest(model, wp, viewport.scale, { selected: renderer.selection });
    state.startScreen = sp;
    state.startWorld = wp;
    state.hit = hit;
    state.moved = false;
    state.mode = 'pending'; // 死区判定前保持待定态(md「操作死区」)
    host.setPointerCapture(evt.pointerId);
  }

  // pending → 正式态迁移(超过死区才认定拖拽)
  function promote() {
    const hit = state.hit;
    switch (hit.type) {
      case 'slot': {
        const node = hit.node;
        if (hit.kind === 'input' && node.inputs[hit.index].link != null) {
          // 从已占用输入槽拖出:摘除旧连线,从源输出端继续拖(ComfyUI 惯例)
          const linkId = node.inputs[hit.index].link;
          const link = model.links.get(String(linkId));
          snapshot();
          disconnect(model, linkId);
          const src = model.nodes.get(link.from);
          const sp = slotPos(src, 'output', link.fromSlot);
          state.connectFrom = { nodeId: src.id, kind: 'output', index: link.fromSlot, worldPos: { x: src.pos.x + sp.x, y: src.pos.y + sp.y } };
          renderer.dragLink = { from: state.connectFrom.worldPos, to: state.startWorld, valid: true };
          emitChange('topology');
        } else {
          const lp = slotPos(node, hit.kind, hit.index);
          state.connectFrom = { nodeId: node.id, kind: hit.kind, index: hit.index, worldPos: { x: node.pos.x + lp.x, y: node.pos.y + lp.y } };
          renderer.dragLink = { from: state.connectFrom.worldPos, to: state.startWorld, valid: true };
        }
        state.mode = 'connect';
        break;
      }
      case 'resize': {
        state.mode = 'resize';
        state.resizeStart = { w: hit.node.size.w, h: hit.node.size.h };
        break;
      }
      case 'title': case 'node': case 'widget': {
        if (hit.type === 'widget' && hit.widget.kind === 'BOOLEAN') break; // 留给 click
        const id = hit.node.id;
        if (!renderer.selection.has(id)) {
          if (!hooks.shiftKey) renderer.selection.clear();
          renderer.selection.add(id);
          hooks.onSelectionChange && hooks.onSelectionChange([...renderer.selection]);
        }
        // 移动/位置变更走差量命令(md 双轨):拖拽起点位置在 pointerup 时与终点一起提交
        state.dragOrigin = new Map([...renderer.selection].map((nid) => {
          const n = model.nodes.get(nid);
          return [nid, { x: n.pos.x, y: n.pos.y }];
        }));
        state.mode = 'drag-node';
        break;
      }
      case 'group-title': {
        snapshot();
        state.mode = 'drag-group';
        break;
      }
      case 'canvas': case 'group': {
        if (hit.type === 'canvas' || hit.type === 'group') {
          state.mode = 'marquee';
          renderer.marquee = { x: state.startWorld.x, y: state.startWorld.y, w: 0, h: 0 };
          if (!hooks.shiftKey) {
            renderer.selection.clear();
            hooks.onSelectionChange && hooks.onSelectionChange([]);
          }
        }
        break;
      }
      default: break;
    }
    renderer.invalidate('fg');
  }

  function onPointerMove(evt) {
    const sp = screenPt(evt);
    const wp = toWorld(viewport, sp);
    if (state.mode === 'idle') return;
    if (state.mode === 'pending') {
      const dx = Math.abs(sp.x - state.startScreen.x), dy = Math.abs(sp.y - state.startScreen.y);
      if (dx + dy <= DEADBAND) return; // 死区内:不激活任何拖拽
      promote();
    }
    state.moved = true;
    switch (state.mode) {
      case 'pan': {
        panBy(viewport, sp.x - state.startScreen.x, sp.y - state.startScreen.y);
        state.startScreen = sp;
        renderer.invalidate('all');
        break;
      }
      case 'drag-node': {
        const dx = wp.x - state.startWorld.x, dy = wp.y - state.startWorld.y;
        // 多选整体位移:以主节点(h hit 节点)为参照算吸附/参考线
        const primary = state.hit.node;
        const o0 = state.dragOrigin.get(primary.id);
        let nx = o0.x + dx, ny = o0.y + dy;
        const step = gridStep();
        if (step) { nx = snapToGrid(nx, step); ny = snapToGrid(ny, step); }
        const rect = { x: nx, y: ny, w: primary.size.w, h: primary.size.h };
        const g = smartGuides(model, [...state.dragOrigin.keys()], rect, viewport.scale);
        const fdx = (nx + g.dx) - o0.x, fdy = (ny + g.dy) - o0.y;
        for (const [nid, origin] of state.dragOrigin) {
          const n = model.nodes.get(nid);
          if (n.locked) continue;
          n.pos.x = origin.x + fdx;
          n.pos.y = origin.y + fdy;
        }
        renderer.guides = g.guides;
        renderer.invalidate('all'); // 连线在背景通道,需联动
        break;
      }
      case 'drag-group': {
        const dx = wp.x - state.startWorld.x, dy = wp.y - state.startWorld.y;
        moveGroup(model, state.hit.group.id, dx, dy);
        state.startWorld = wp; // 增量式(moveGroup 内部按位移差叠加)
        renderer.invalidate('all');
        break;
      }
      case 'resize': {
        const node = state.hit.node;
        node.size.w = Math.max(LAYOUT.MIN_W, state.resizeStart.w + (wp.x - state.startWorld.x));
        node.size.h = Math.max(LAYOUT.TITLE_H + LAYOUT.PAD_BOTTOM, state.resizeStart.h + (wp.y - state.startWorld.y));
        renderer.invalidate('all');
        break;
      }
      case 'marquee': {
        const x0 = state.startWorld.x, y0 = state.startWorld.y;
        renderer.marquee = { x: Math.min(x0, wp.x), y: Math.min(y0, wp.y), w: Math.abs(wp.x - x0), h: Math.abs(wp.y - y0) };
        renderer.invalidate('fg');
        break;
      }
      case 'connect': {
        renderer.dragLink.to = wp;
        // 引脚智能吸附:半径内候选端口满足类型校验即吸附高亮
        renderer.hoverSlot = null;
        renderer.dragLink.valid = true;
        let best = null, bestD = SNAP_DIST / viewport.scale;
        for (const node of model.nodes.values()) {
          const kind = state.connectFrom.kind === 'output' ? 'input' : 'output';
          const slots = kind === 'input' ? node.inputs : node.outputs;
          for (let i = 0; i < slots.length; i++) {
            const lp = slotPos(node, kind, i);
            const p = { x: node.pos.x + lp.x, y: node.pos.y + lp.y };
            const d = Math.hypot(wp.x - p.x, wp.y - p.y);
            if (d > bestD) continue;
            const v = state.connectFrom.kind === 'output'
              ? validateConnection(model, state.connectFrom.nodeId, state.connectFrom.index, node.id, i)
              : validateConnection(model, node.id, i, state.connectFrom.nodeId, state.connectFrom.index);
            if (v.ok) { best = { nodeId: node.id, kind, index: i, pos: p }; bestD = d; }
          }
        }
        if (best) {
          renderer.hoverSlot = best;
          renderer.dragLink.to = best.pos; // 端点吸附到端口圆心
        }
        renderer.invalidate('fg');
        break;
      }
      default: break;
    }
  }

  function onPointerUp(evt) {
    const sp = screenPt(evt);
    const wp = toWorld(viewport, sp);
    const hit = state.hit;
    switch (state.mode) {
      case 'pending': {
        // 死区内抬起 = 纯单击业务逻辑
        handleClick(hit, wp, evt);
        break;
      }
      case 'connect': {
        renderer.dragLink = null;
        const hover = renderer.hoverSlot;
        renderer.hoverSlot = null;
        if (hover) {
          snapshot();
          const r = state.connectFrom.kind === 'output'
            ? connect(model, state.connectFrom.nodeId, state.connectFrom.index, hover.nodeId, hover.index)
            : connect(model, hover.nodeId, hover.index, state.connectFrom.nodeId, state.connectFrom.index);
          if (r.ok) emitChange('topology');
        }
        renderer.invalidate('all');
        break;
      }
      case 'drag-node': {
        renderer.guides = [];
        if (state.moved && hooks.onDelta) {
          const origins = state.dragOrigin;
          const finals = new Map([...origins.keys()].map((nid) => {
            const n = model.nodes.get(nid);
            return [nid, { x: n.pos.x, y: n.pos.y }];
          }));
          const setPos = (map) => { for (const [nid, p] of map) { const n = model.nodes.get(nid); if (n) { n.pos.x = p.x; n.pos.y = p.y; } } };
          hooks.onDelta({
            key: 'move:' + [...origins.keys()].join(','),
            revert: () => { setPos(origins); renderer.invalidate('all'); },
            apply: () => { setPos(finals); renderer.invalidate('all'); },
          });
          emitChange('geometry');
        }
        renderer.invalidate('all');
        break;
      }
      case 'drag-group': emitChange('geometry'); break;
      case 'resize': {
        const node = state.hit.node;
        const before = state.resizeStart;
        const after = { w: node.size.w, h: node.size.h };
        if (hooks.onDelta && (before.w !== after.w || before.h !== after.h)) {
          hooks.onDelta({
            key: 'resize:' + node.id,
            revert: () => { node.size.w = before.w; node.size.h = before.h; renderer.invalidate('all'); },
            apply: () => { node.size.w = after.w; node.size.h = after.h; renderer.invalidate('all'); },
          });
        }
        emitChange('geometry');
        break;
      }
      case 'marquee': {
        const q = renderer.marquee;
        renderer.marquee = null;
        if (q && q.w * viewport.scale > DEADBAND && q.h * viewport.scale > DEADBAND) {
          for (const node of model.nodes.values()) {
            if (node.locked) continue;
            const r = { x: node.pos.x, y: node.pos.y, w: node.size.w, h: node.size.h };
            if (rectsIntersect(q, r)) renderer.selection.add(node.id);
          }
          hooks.onSelectionChange && hooks.onSelectionChange([...renderer.selection]);
        }
        renderer.invalidate('fg');
        break;
      }
      default: break;
    }
    state.mode = 'idle';
    state.hit = null;
    hooks.breakHistoryMerge && hooks.breakHistoryMerge();
  }

  function handleClick(hit, wp, evt) {
    switch (hit.type) {
      case 'widget': {
        const wd = hit.widget;
        if (wd.kind === 'BOOLEAN') {
          const prev = wd.value;
          const sync = () => { if (hit.node.data.comfyInputs) hit.node.data.comfyInputs[wd.name] = wd.value; renderer.invalidate('fg'); };
          wd.value = !prev;
          sync();
          hooks.onDelta && hooks.onDelta({
            key: 'widget:' + hit.node.id + ':' + wd.name,
            revert: () => { wd.value = prev; sync(); },
            apply: () => { wd.value = !prev; sync(); },
          });
          emitChange('config');
        } else if (hooks.onWidgetEdit) {
          const b = widgetBounds(hit.node, hit.index);
          const rect = { x: (hit.node.pos.x + b.x) * viewport.scale + viewport.tx, y: (hit.node.pos.y + b.y) * viewport.scale + viewport.ty, w: b.w * viewport.scale, h: b.h * viewport.scale };
          hooks.onWidgetEdit(hit.node, wd, rect);
        }
        break;
      }
      case 'title': case 'node': {
        const id = hit.node.id;
        if (!hooks.shiftKey) renderer.selection.clear();
        renderer.selection.add(id);
        hooks.onSelectionChange && hooks.onSelectionChange([...renderer.selection]);
        renderer.invalidate('fg');
        break;
      }
      case 'link': hooks.onLinkClick && hooks.onLinkClick(hit.link, evt); break;
      case 'canvas':
        renderer.selection.clear();
        hooks.onSelectionChange && hooks.onSelectionChange([]);
        renderer.invalidate('fg');
        break;
      default: break;
    }
  }

  function onDoubleClick(evt) {
    const sp = screenPt(evt);
    const wp = toWorld(viewport, sp);
    const hit = hitTest(model, wp, viewport.scale, { selected: renderer.selection });
    if (hit.type === 'title') {
      hit.node.collapsed = !hit.node.collapsed;
      computeSize(hit.node);
      emitChange('geometry');
      renderer.invalidate('all');
    } else if (hit.type === 'canvas') {
      hooks.onCanvasDoubleClick && hooks.onCanvasDoubleClick(wp);
    }
  }

  function onContextMenu(evt) {
    const sp = screenPt(evt);
    const wp = toWorld(viewport, sp);
    const hit = hitTest(model, wp, viewport.scale, { selected: renderer.selection });
    if (hooks.onContextMenu) {
      evt.preventDefault();
      hooks.onContextMenu(hit, evt);
    }
  }

  function onWheel(evt) {
    evt.preventDefault();
    const sp = screenPt(evt);
    const factor = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(viewport, sp.x, sp.y, factor); // md「指针中心缩放无漂移算法」
    renderer.invalidate('all');
  }

  function onKeyDown(evt) {
    if (evt.code === 'Space' && !isEditableTarget(evt)) { state.spaceDown = true; evt.preventDefault(); }
    if (evt.key === 'Escape' && state.mode === 'connect') {
      renderer.dragLink = null;
      renderer.hoverSlot = null;
      state.mode = 'idle';
      renderer.invalidate('fg');
    }
  }
  function onKeyUp(evt) {
    if (evt.code === 'Space') state.spaceDown = false;
  }

  // minimap 双向漫游:点击/拖动小地图 → 主视口中心移到对应世界点
  function bindMinimap(mini) {
    if (!mini) return;
    let dragging = false;
    const jump = (evt) => {
      const r = mini.getBoundingClientRect();
      const w = renderer.miniToWorld({ x: evt.clientX - r.left, y: evt.clientY - r.top });
      if (!w) return;
      const view = renderer.viewSize();
      viewport.tx = view.w / 2 - w.x * viewport.scale;
      viewport.ty = view.h / 2 - w.y * viewport.scale;
      renderer.invalidate('all');
    };
    mini.addEventListener('pointerdown', (evt) => { dragging = true; mini.setPointerCapture(evt.pointerId); jump(evt); });
    mini.addEventListener('pointermove', (evt) => { if (dragging) jump(evt); });
    mini.addEventListener('pointerup', () => { dragging = false; });
  }
  bindMinimap(hooks.minimapCanvas);

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('dblclick', onDoubleClick);
  host.addEventListener('contextmenu', onContextMenu);
  host.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return {
    destroy() {
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('dblclick', onDoubleClick);
      host.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    },
    isDragging: () => state.mode !== 'idle',
    // 框选后程序态设定选区(集成层用)
    setSelection(ids) { renderer.selection = new Set(ids.map(String)); renderer.invalidate('fg'); },
    // 视野适配(F 键):全部节点 + 边距收进视口
    fitView() {
      const view = renderer.viewSize();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const node of model.nodes.values()) {
        minX = Math.min(minX, node.pos.x); minY = Math.min(minY, node.pos.y);
        maxX = Math.max(maxX, node.pos.x + node.size.w); maxY = Math.max(maxY, node.pos.y + node.size.h);
      }
      if (!isFinite(minX)) { viewport.tx = 0; viewport.ty = 0; viewport.scale = 1; renderer.invalidate('all'); return; }
      const bw = maxX - minX + 120, bh = maxY - minY + 120;
      viewport.scale = Math.max(viewport.minScale, Math.min(1, Math.min(view.w / bw, view.h / bh)));
      viewport.tx = view.w / 2 - (minX + maxX) / 2 * viewport.scale;
      viewport.ty = view.h / 2 - (minY + maxY) / 2 * viewport.scale;
      renderer.invalidate('all');
    },
  };
}

function isEditableTarget(evt) {
  const t = evt.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
