// 用户消息缩略导航栏(v0.9.9,类 GPT 右侧条):列出当前会话每条用户消息摘要,
// 点击滚动定位到对应消息;滚动时联动高亮当前所在位置;无消息时隐藏。
import { $, on, state } from './state.js';

const itemText = (msgEl) => {
  const u = msgEl._umsg;
  let t = '';
  if (u && u.content) {
    if (typeof u.content === 'string') t = u.content;
    else if (Array.isArray(u.content)) {
      t = u.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ');
    }
  }
  if (!t) t = (msgEl.querySelector('.bubble') || {}).innerText || '';
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 48) || '(空消息)';
};

const activeLogEl = () => $('messages').querySelector('.session-log:not(.hidden)');
const navBtns = () => $('msg-nav').querySelectorAll('.msg-nav-list button');

function rebuild() {
  const rail = $('msg-nav');
  const list = rail.querySelector('.msg-nav-list');
  list.innerHTML = '';
  const logEl = activeLogEl();
  const msgs = logEl ? [...logEl.querySelectorAll(':scope > .msg.user')] : [];
  rail.classList.toggle('hidden', !msgs.length);
  for (const m of msgs) {
    // 槽位 + 按钮(v0.9.18):槽位布局尺寸恒定,按钮绝对定位于槽内用 transform
    // 缩放——悬停放大不推挤邻近项,上下衰减对称(修「上下缩放不平均」)
    const slot = document.createElement('div');
    slot.className = 'msg-nav-slot';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = itemText(m);
    b.title = b.textContent;
    b.onclick = () => {
      // 瞬时跳转(v0.9.14)/平滑滚动按设置项切换(v0.9.15)
      m.scrollIntoView({ block: 'start', ...(state.instantJump ? {} : { behavior: 'smooth' }) });
      m.classList.add('flash');
      setTimeout(() => m.classList.remove('flash'), 1200);
    };
    m._navItem = b; // 反向引用:滚动联动时按 DOM 序一次遍历
    slot.appendChild(b);
    list.appendChild(slot);
  }
  // v0.9.27:密度自适应——消息不多时槽距 16px/横杠 6px(同 v0.9.20),装不下时
  // 按比例压缩槽距与横杠厚度,让所有项始终全部可见、Dock 悬停放大始终可用
  // (修「消息过多时显示不正确」:旧方案把列表收成 34% 高的小窗+悬停代理滚动,
  // 展开回退 scale(0.674,1) 被遮罩/裁切,与正常会话效果不一致)。
  // 仅在极端数量(压缩到最小槽距仍装不下)时才退回可滚动小窗。
  updateDensity();
  updateFade();
  requestAnimationFrame(markActive);
}

// 密度自适应:全部项装进 rail 高度内;装不下则等比压缩槽距(横杠随之变薄)
function updateDensity() {
  const rail = $('msg-nav');
  const list = rail.querySelector('.msg-nav-list');
  const n = list.children.length;
  if (!n || rail.classList.contains('hidden')) return;
  const avail = rail.clientHeight - 4; // list padding 2px×2
  const PITCH0 = 16, BAR0 = 6, MIN_PITCH = 3;
  let pitch = PITCH0;
  if (n * PITCH0 > avail) pitch = Math.max(MIN_PITCH, Math.floor(avail / n));
  const barH = Math.min(BAR0, Math.max(2, pitch - 2));
  list.style.setProperty('--pitch', pitch + 'px');
  list.style.setProperty('--bar-h', barH + 'px');
  list.style.setProperty('--bar-k', (barH / 22).toFixed(3)); // 横杠纵向缩放系数(按钮高 22px)
  // mag(=Dock 悬停放大)仅在内容无需滚动时启用:overflow-y:auto 时
  // transform 放大必被裁切/出横向滚动条(CSS 溢出规则限制)
  list.classList.toggle('mag', n * pitch <= avail + 1);
}

// 边界渐出(v0.9.27 重写):不给整列表加 mask 遮罩,而是按各槽位中心距列表可视
// 窗口上/下缘的距离,逐项改变按钮自身的 opacity——靠近边缘的项自身渐淡,
// 未探到边界的一侧自然渐出,探到顶/底即该侧恢复全亮(滚动监听驱动,代理滚动覆盖)
function updateFade() {
  const list = $('msg-nav').querySelector('.msg-nav-list');
  const mag = list.classList.contains('mag');
  const lr = list.getBoundingClientRect();
  const FADE = 28; // 渐出区高度(px)
  for (const slot of list.children) {
    const b = slot.firstChild;
    if (mag) {
      // mag 态无滚动不需渐出;只清非 mag 残留的渐出透明度,不碰 Dock 悬停写的
      if (b._fade != null) { b._fade = null; b.style.opacity = ''; }
      continue;
    }
    const r = slot.getBoundingClientRect(); // 槽位不动,悬停/滚动期间测量稳定
    const c = r.top + r.height / 2;
    let f = 1;
    if (c < lr.top + FADE) f = (c - lr.top) / FADE;
    else if (c > lr.bottom - FADE) f = (lr.bottom - c) / FADE;
    f = Math.min(1, Math.max(0, f));
    const base = b.classList.contains('active') || b.matches(':hover') ? 1 : 0.6;
    b._fade = f;
    b.style.opacity = (base * f).toFixed(2);
  }
}

// 滚动联动:视口参考线(顶部偏下)之上最后一条用户消息 = 当前位置
function markActive() {
  const rail = $('msg-nav');
  if (rail.classList.contains('hidden')) return;
  const logEl = activeLogEl();
  if (!logEl) return;
  const mid = $('messages').getBoundingClientRect().top + 120;
  let current = null;
  for (const m of logEl.querySelectorAll(':scope > .msg.user')) {
    if (!m._navItem) continue;
    if (m.getBoundingClientRect().top <= mid) current = m._navItem;
  }
  const first = navBtns()[0] || null;
  for (const b of navBtns()) b.classList.toggle('active', b === (current || first));
  updateFade(); // active 基准透明度 0.6→1,渐出按新基准重算
}

export function init() {
  // 回放时逐条 emit,合并到一帧重建,避免 O(n²)
  let scheduled = false;
  const scheduleRebuild = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; rebuild(); });
  };
  on('user-msg-added', scheduleRebuild);
  on('history-replayed', scheduleRebuild);
  on('session-activated', scheduleRebuild);
  let ticking = false;
  $('messages').addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; markActive(); });
  });
  // Dock 式悬停展开(v0.9.19 调优):槽位布局尺寸恒定(26×6,v0.9.20 加厚防误触),距离一律按槽位中心
  // 测量——槽位在悬停期间不移动,因此无布局反馈抖动、上下衰减严格对称。
  // 对比强化:衰减指数 1.5(两侧项更快退回小横杠)+ 中心项最大放到 1.15x 并打
  // .hot 高亮(主题色描边/底色),同时远处项压暗到 0.35——中心项明显更醒目。
  // 只改 transform/opacity,不触发列表重排。离开列表全部复位。
  //
  // v0.9.25:①监听提升到整条 rail(pointer-events:auto),感应区不再只有小窗;
  // ②macOS Dock 式边缘钳制——光标 Y 先钳到首/末槽位中心之间:光标在导航上缘
  //   之上时最上面一条按「光标在其中心」拿到满放大,越过下缘同理(macOS Dock
  //   光标越过端点图标时端点保持满倍放大的行为);
  // ③滚轮对导航栏禁用(wheel preventDefault),只允许悬停代理滚动。
  const rail = $('msg-nav');
  const list = rail.querySelector('.msg-nav-list');
  const SX0 = 26 / 190;             // 横杠横向缩放系数(槽宽 26px / 按钮宽 190px)
  const SMAX = 1.15;                // 中心项最大放大倍数
  // v0.9.27:槽距/横杠厚度/感应半径随密度自适应(见 updateDensity),从 CSS 变量回读
  const curPitch = () => parseFloat(list.style.getPropertyValue('--pitch')) || 16;
  const curSy0 = () => (parseFloat(list.style.getPropertyValue('--bar-h')) || 6) / 22;
  const curRadius = () => Math.max(40, curPitch() * 4.375); // 槽距 16 → 70px(同旧常量)
  const resetItem = (b) => { b.style.transform = ''; b.style.zIndex = ''; b.style.opacity = ''; b.classList.remove('hot'); };
  list.addEventListener('wheel', (e) => e.preventDefault(), { passive: false }); // ③
  rail.addEventListener('mousemove', (e) => {
    // 装不下(非 mag)时(v0.9.21):列表是居中的小窗,悬停位置即总列表的
    // 相应位置——按光标在小窗内的纵向比例直接代理 scrollTop(数学上光标所指
    // 恰好对应整体内容的同一比例处);v0.9.25 光标超出小窗上/下缘时 ratio 钳到
    // 0/1(探到边界),与 macOS Dock 端点行为一致
    if (!list.classList.contains('mag')) {
      const lr = list.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientY - lr.top) / lr.height));
      // v0.9.24:按槽距吸附取整——连续值会让窗口上下边缘的项只显示半条,
      // 吸附后边缘项要么完整显示要么完整隐入淡出区
      const raw = ratio * (list.scrollHeight - list.clientHeight);
      list.scrollTop = Math.round(raw / curPitch()) * curPitch();
      return;
    }
    // ② 边缘钳制:光标在上缘之上 → 作用于首槽位中心(首项满放大);下缘同理
    const slots = list.children;
    if (!slots.length) return;
    const fr = slots[0].getBoundingClientRect();
    const br = slots[slots.length - 1].getBoundingClientRect();
    const cy = Math.min(br.top + br.height / 2, Math.max(fr.top + fr.height / 2, e.clientY));
    const MAG_RADIUS = curRadius(), SY0 = curSy0();
    let hot = null, hotK = 0;
    for (const slot of slots) {
      const b = slot.firstChild;
      const r = slot.getBoundingClientRect();
      const d = Math.abs(cy - (r.top + r.height / 2));
      const t = Math.max(0, 1 - d / MAG_RADIUS);
      const k = t * t; // 二次衰减
      if (k < 0.02) { resetItem(b); continue; }
      const kk = Math.pow(k, 1.5); // 再压一次指数,拉开中心项与两侧的差距
      b.style.transform = `scale(${(SX0 + (SMAX - SX0) * kk).toFixed(3)}, ${(SY0 + (SMAX - SY0) * kk).toFixed(3)})`;
      b.style.zIndex = String(Math.round(k * 100)); // 展开大的压在上面
      b.style.opacity = (0.35 + 0.65 * k).toFixed(2); // 远处压暗,衬托中心项
      if (k > hotK) { hotK = k; hot = b; }
    }
    for (const slot of slots) {
      slot.firstChild.classList.toggle('hot', slot.firstChild === hot && hotK > 0.5);
    }
  });
  rail.addEventListener('mouseleave', () => {
    for (const slot of list.children) resetItem(slot.firstChild);
  });
  // 边界淡出维护(v0.9.23):代理滚动触发 scroll,据 scrollTop 刷新
  list.addEventListener('scroll', updateFade);
  // v0.9.27:窗口尺寸变化 → rail 高度变 → 重算槽距密度
  window.addEventListener('resize', () => { updateDensity(); updateFade(); });
}
