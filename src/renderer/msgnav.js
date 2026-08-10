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
  updateFade();
  requestAnimationFrame(markActive);
}

// 边界淡出(v0.9.23):滚动未探到的一侧保持淡出,探到边界(顶/底)即去除该侧
function updateFade() {
  const list = $('msg-nav').querySelector('.msg-nav-list');
  const max = list.scrollHeight - list.clientHeight;
  list.classList.toggle('at-top', list.scrollTop <= 1);
  list.classList.toggle('at-bottom', list.scrollTop >= max - 1);
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
  const list = $('msg-nav').querySelector('.msg-nav-list');
  const MAG_RADIUS = 70;          // 影响半径(px)
  const SX0 = 26 / 190, SY0 = 6 / 22; // 横杠缩放系数(与 CSS 默认值一致,v0.9.20 横杠 6px 厚)
  const SMAX = 1.15;              // 中心项最大放大倍数
  const resetItem = (b) => { b.style.transform = ''; b.style.zIndex = ''; b.style.opacity = ''; b.classList.remove('hot'); };
  list.addEventListener('mousemove', (e) => {
    // 装不下(非 mag)时(v0.9.21):列表是居中的小窗,悬停位置即总列表的
    // 相应位置——按光标在小窗内的纵向比例直接代理 scrollTop(数学上光标所指
    // 恰好对应整体内容的同一比例处),配合上下淡出实现「省略但有定位感」
    if (!list.classList.contains('mag')) {
      const lr = list.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientY - lr.top) / lr.height));
      // v0.9.24:按项距 16px(槽位 6+间距 10)吸附取整——连续值会让窗口上下
      // 边缘的项只显示半条,吸附后边缘项要么完整显示要么完整隐入淡出区
      const PITCH = 16;
      const raw = ratio * (list.scrollHeight - list.clientHeight);
      list.scrollTop = Math.round(raw / PITCH) * PITCH;
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
  list.addEventListener('mouseleave', () => {
    for (const slot of list.children) resetItem(slot.firstChild);
  });
  // 边界淡出维护(v0.9.23):代理滚动/滚轮都会触发 scroll,据 scrollTop 刷新
  list.addEventListener('scroll', updateFade);
}
