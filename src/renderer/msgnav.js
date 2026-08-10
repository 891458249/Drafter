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
  // 悬停放大(v0.9.14)仅在内容无需滚动时启用:列表 overflow-y:auto 时
  // transform 放大必被裁切/出横向滚动条(CSS 溢出规则限制),可滚动时退回普通 hover
  list.classList.toggle('mag', list.scrollHeight <= list.clientHeight + 1);
  list.style.transform = ''; // v0.9.22:清掉小窗跟随位移,避免换会话/模式后残留偏移
  requestAnimationFrame(markActive);
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
  // v0.9.22:监听从 list 提升到整条 rail(.msg-nav)——整条右缘都是悬停区:
  // · 装不下(非 mag)时,小窗跟随光标滑动:windowTop=ratio·(H-W)、
  //   scrollTop=ratio·(total-W) 由同一 ratio 驱动,光标始终正指总列表的同比例
  //   位置,且小窗移到哪光标都在窗内,任何位置的项都可点;scrollTop 按项距
  //   16px 吸附取整,边缘不再只显示半条;
  // · 装得下(mag)时维持 Dock 放大(光标远离列表时各项自然衰减为横杠)。
  const rail = $('msg-nav');
  const list = rail.querySelector('.msg-nav-list');
  const MAG_RADIUS = 70;          // 影响半径(px)
  const SX0 = 26 / 190, SY0 = 6 / 22; // 横杠缩放系数(与 CSS 默认值一致,v0.9.20 横杠 6px 厚)
  const SMAX = 1.15;              // 中心项最大放大倍数
  const PITCH = 16;               // 槽位 6px + 间距 10px(v0.9.20)
  const resetItem = (b) => { b.style.transform = ''; b.style.zIndex = ''; b.style.opacity = ''; b.classList.remove('hot'); };
  rail.addEventListener('mousemove', (e) => {
    if (!list.classList.contains('mag')) {
      const H = rail.clientHeight, W = list.offsetHeight, total = list.scrollHeight;
      if (total <= W) return;
      const rr = rail.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientY - rr.top) / H));
      // 列表自身居中于 rail,窗口目标位置 = 居中位 + 偏移;scrollTop 吸附整项
      list.scrollTop = Math.round((ratio * (total - W)) / PITCH) * PITCH;
      list.style.transform = `translateY(${((ratio - 0.5) * (H - W)).toFixed(1)}px)`;
      return;
    }
    let hot = null, hotK = 0;
    for (const slot of list.children) {
      const b = slot.firstChild;
      const r = slot.getBoundingClientRect();
      const d = Math.abs(e.clientY - (r.top + r.height / 2));
      const t = Math.max(0, 1 - d / MAG_RADIUS);
      const k = t * t; // 二次衰减
      if (k < 0.02) { resetItem(b); continue; }
      const kk = Math.pow(k, 1.5); // 再压一次指数,拉开中心项与两侧的差距
      b.style.transform = `scale(${(SX0 + (SMAX - SX0) * kk).toFixed(3)}, ${(SY0 + (SMAX - SY0) * kk).toFixed(3)})`;
      b.style.zIndex = String(Math.round(k * 100)); // 展开大的压在上面
      b.style.opacity = (0.35 + 0.65 * k).toFixed(2); // 远处压暗,衬托中心项
      if (k > hotK) { hotK = k; hot = b; }
    }
    for (const slot of list.children) {
      slot.firstChild.classList.toggle('hot', slot.firstChild === hot && hotK > 0.5);
    }
  });
  rail.addEventListener('mouseleave', () => {
    // 只复位展开/高亮;非 mag 的小窗位置保留在上次悬停处,不回弹
    for (const slot of list.children) resetItem(slot.firstChild);
  });
}
