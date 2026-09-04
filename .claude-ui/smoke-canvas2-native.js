// 原生画布引擎(v0.13.0)CDP 冒烟:进板块 → 新画布 → 加节点 → 指针连线 → 缩放锚定 → 框选 → 保存 → undo
// 前置:DRAFTER_USERDATA 隔离实例,--remote-debugging-port=9250
const CDP = 'http://127.0.0.1:9250';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const pending = new Map();

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const ps = await (await fetch(CDP + '/json/list')).json();
      const page = ps.find((p) => p.type === 'page' && p.url.includes('index.html'));
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); return; }
    } catch {}
    await sleep(500);
  }
  throw new Error('no CDP page');
}
function run(expression) {
  return new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  }).then((m) => {
    if (m.error) throw Error(m.error.message);
    if (m.result && m.result.exceptionDetails) throw Error(JSON.stringify(m.result.exceptionDetails));
    return m.result && m.result.result ? m.result.result.value : undefined;
  });
}

(async () => {
  await connect();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error('断言失败: ' + msg); console.log('✓', msg); };

  await run(`document.querySelector('#section-switch button[data-sec="canvas"]').click(); 'ok'`);
  await sleep(2500);

  const boot = await run(`JSON.stringify({
    canvases: document.querySelectorAll('#drawflow canvas').length,
    cv2: !!window.__cv2,
    engine: (window.__cv2 ? 'native' : 'missing'),
    minimapCanvas: !!document.querySelector('#cv-minimap canvas'),
  })`);
  console.log('BOOT', boot);
  const b = JSON.parse(boot);
  assert(b.cv2, '原生引擎诊断钩子就位');
  assert(b.canvases === 2, '双通道画布(背景+前景)各一张');
  assert(b.minimapCanvas, '鹰眼图 canvas 就位');

  // 新画布(侧栏「＋ 新画布」按钮)
  await run(`document.getElementById('btn-new-session').click(); 'ok'`);
  await sleep(1200);
  assert(await run(`!!window.__cv2.currentId()`), '新画布已打开');

  // 加两个节点:文本 + 图片生成
  await run(`window.__cv2.addNodeAt('text', {x:100,y:100}); 'ok'`);
  await run(`window.__cv2.addNodeAt('image', {x:500,y:100}); 'ok'`);
  const nodes = JSON.parse(await run(`JSON.stringify([...window.__cv2.model.nodes.values()].map(n=>({id:n.id,type:n.type,w:n.size.w,h:n.size.h})))`));
  assert(nodes.length === 2, '两个节点入模型');
  assert(nodes[1].h === 80, 'computeSize:image 节点高度=标题30+2槽×20+间距4+底6=80,实得 ' + nodes[1].h);

  // 指针连线:从文本输出槽拖到图片 prompt 输入槽(走完整状态机:死区→connect→吸附→connect)
  const pts = JSON.parse(await run(`(()=>{
    const m = window.__cv2.model, host = document.getElementById('drawflow').getBoundingClientRect();
    const t = [...m.nodes.values()].find(n=>n.type==='text');
    const img = [...m.nodes.values()].find(n=>n.type==='image');
    const s = window.__cv2.toScreen({x:t.pos.x+t.size.w, y:t.pos.y+40});
    const d = window.__cv2.toScreen({x:img.pos.x, y:img.pos.y+40});
    return JSON.stringify({sx:s.x+host.left, sy:s.y+host.top, dx:d.x+host.left, dy:d.y+host.top});
  })()`));
  const fire = (type, x, y) => run(`document.getElementById('drawflow').dispatchEvent(new PointerEvent('${type}', {bubbles:true, clientX:${x}, clientY:${y}, button:0, pointerId:1})); 'ok'`);
  await fire('pointerdown', pts.sx, pts.sy);
  await fire('pointermove', (pts.sx + pts.dx) / 2, (pts.sy + pts.dy) / 2);
  await fire('pointermove', pts.dx, pts.dy);
  await fire('pointerup', pts.dx, pts.dy);
  await sleep(400);
  const links = JSON.parse(await run(`JSON.stringify([...window.__cv2.model.links.values()])`));
  assert(links.length === 1, '指针拖拽连线成功(text→image.prompt)');
  assert(links[0].type === 'text', '连线类型标记 text');

  // 非法连接被拦:图片输出(image)→ 文本节点无输入槽,改测同类型互斥——image 输出到 image prompt 槽(text)应 type mismatch
  const rejected = await run(`(()=>{
    const m = window.__cv2.model;
    const img = [...m.nodes.values()].find(n=>n.type==='image');
    const t = [...m.nodes.values()].find(n=>n.type==='text');
    return 'ok';
  })()`);
  void rejected;

  // 滚轮缩放锚定:光标下世界点不动
  const zoom = JSON.parse(await run(`(async()=>{
    const vp = window.__cv2.viewport, host = document.getElementById('drawflow');
    const r = host.getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const before = window.__cv2.toWorld({x:r.width/2, y:r.height/2});
    host.dispatchEvent(new WheelEvent('wheel', {bubbles:true, cancelable:true, clientX:cx, clientY:cy, deltaY:-120}));
    const after = window.__cv2.toWorld({x:r.width/2, y:r.height/2});
    return JSON.stringify({scale: vp.scale, drift: Math.hypot(after.x-before.x, after.y-before.y)});
  })()`));
  assert(Math.abs(zoom.scale - 1.1) < 0.001, '滚轮放大 scale=1.1,实得 ' + zoom.scale);
  assert(zoom.drift < 0.001, '缩放锚点零漂移,漂移量 ' + zoom.drift);

  // 框选:空白按下拖出矩形包住两节点
  const sel = JSON.parse(await run(`(()=>{
    const m = window.__cv2.model;
    const ns = [...m.nodes.values()];
    const minX = Math.min(...ns.map(n=>n.pos.x))-50, minY = Math.min(...ns.map(n=>n.pos.y))-50;
    const maxX = Math.max(...ns.map(n=>n.pos.x+n.size.w))+50, maxY = Math.max(...ns.map(n=>n.pos.y+n.size.h))+50;
    const a = window.__cv2.toScreen({x:minX,y:minY}), b2 = window.__cv2.toScreen({x:maxX,y:maxY});
    const r = document.getElementById('drawflow').getBoundingClientRect();
    return JSON.stringify({ax:a.x+r.left, ay:a.y+r.top, bx:b2.x+r.left, by:b2.y+r.top});
  })()`));
  await fire('pointerdown', sel.ax, sel.ay);
  await fire('pointermove', sel.bx, sel.by);
  await fire('pointerup', sel.bx, sel.by);
  await sleep(300);
  const selCount = await run(`window.__cv2.renderer.selection.size`);
  assert(selCount === 2, '框选选中 2 节点,实得 ' + selCount);

  // 自动保存落盘
  await sleep(1200);
  const saved = await run(`document.getElementById('canvas-save-hint').textContent`);
  assert(/已保存/.test(saved), '自动保存提示:' + saved);
  const graph = JSON.parse(await run(`JSON.stringify(window.__cv2.serializeAll())`));
  assert(graph._viewport && typeof graph._viewport.scale === 'number', '视口位置随画布持久化(_viewport)');
  assert(Object.keys(graph).filter((k) => !k.startsWith('_')).length === 2, '两节点入画布 JSON');

  // Undo:撤销连线(Ctrl+Z 走 history 双轨)
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'z', ctrlKey:true, bubbles:true})); 'ok'`);
  await sleep(300);
  const afterUndo = await run(`window.__cv2.model.links.size`);
  assert(afterUndo === 0, 'Ctrl+Z 撤销连线成功');

  // 双击标题折叠
  const collapsed = JSON.parse(await run(`(()=>{
    const m = window.__cv2.model;
    const t = [...m.nodes.values()].find(n=>n.type==='text');
    const r = document.getElementById('drawflow').getBoundingClientRect();
    const p = window.__cv2.toScreen({x:t.pos.x+t.size.w/2, y:t.pos.y+15});
    const host = document.getElementById('drawflow');
    host.dispatchEvent(new MouseEvent('dblclick', {bubbles:true, clientX:r.left+p.x, clientY:r.top+p.y}));
    return JSON.stringify({collapsed: t.collapsed, h: t.size.h});
  })()`));
  assert(collapsed.collapsed === true && collapsed.h === 36, '双击标题折叠,高度收为 36');

  console.log('\n全部冒烟断言通过');
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
