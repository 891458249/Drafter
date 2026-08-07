// 用户消息缩略导航栏(v0.9.9,类 GPT 右侧条):列出当前会话每条用户消息摘要,
// 点击滚动定位到对应消息;滚动时联动高亮当前所在位置;无消息时隐藏。
import { $, on } from './state.js';

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
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = itemText(m);
    b.title = b.textContent;
    b.onclick = () => {
      m.scrollIntoView({ block: 'start', behavior: 'smooth' });
      m.classList.add('flash');
      setTimeout(() => m.classList.remove('flash'), 1200);
    };
    m._navItem = b; // 反向引用:滚动联动时按 DOM 序一次遍历
    list.appendChild(b);
  }
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
}
