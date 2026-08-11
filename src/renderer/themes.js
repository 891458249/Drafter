// 皮肤/主题系统(v0.9.31):主题 = 一组 CSS 变量覆盖,boot 时按 settings.theme 应用,
// 设置面板点击即时预览并持久化。「默认深色」= 移除全部内联覆盖,回落到 styles.css 的 :root。
// 注意:只覆盖 :root 变量;代码卡片/hljs 配色为硬编码深色,各主题下保持统一。
import { api } from './state.js';

export const THEMES = [
  { id: 'dark', name: '深色(默认)', swatch: ['#1a1815', '#26231f', '#d97757'], vars: {} },
  {
    id: 'light', name: '浅色', swatch: ['#f5f4f1', '#ffffff', '#c2572f'],
    vars: {
      '--bg': '#f5f4f1', '--bg-elevated': '#ffffff', '--bg-input': '#eceae6',
      '--border': '#d8d3cc', '--text': '#2b2723', '--text-dim': '#6e675f',
      '--accent': '#c2572f', '--accent-hover': '#d97757',
      '--user-bubble': '#e8e2d9', '--tool-bg': '#efede9', '--tool-border': '#d8d3cc',
      '--green': '#3d8a3d', '--red': '#c0392b', '--yellow': '#9a7b1c',
      '--accent-bg': 'rgba(194,87,47,.12)', '--bg-hover': 'rgba(0,0,0,.06)',
    },
  },
  {
    id: 'midnight', name: '暗夜蓝', swatch: ['#0f1420', '#161d2e', '#5b8def'],
    vars: {
      '--bg': '#0f1420', '--bg-elevated': '#161d2e', '--bg-input': '#1c2539',
      '--border': '#2a3550', '--text': '#e2e8f5', '--text-dim': '#8a96ad',
      '--accent': '#5b8def', '--accent-hover': '#7ba3f3',
      '--user-bubble': '#1d2940', '--tool-bg': '#131a2b', '--tool-border': '#2a3550',
      '--green': '#6fbf73', '--red': '#e06c75', '--yellow': '#d8b356',
      '--accent-bg': 'rgba(91,141,239,.16)', '--bg-hover': 'rgba(255,255,255,.07)',
    },
  },
  {
    id: 'forest', name: '墨绿护眼', swatch: ['#14201a', '#1b2b23', '#d97757'],
    vars: {
      '--bg': '#14201a', '--bg-elevated': '#1b2b23', '--bg-input': '#22352b',
      '--border': '#31473a', '--text': '#dce8df', '--text-dim': '#8ba393',
      '--accent': '#d97757', '--accent-hover': '#e08a6e',
      '--user-bubble': '#24382d', '--tool-bg': '#182621', '--tool-border': '#31473a',
      '--green': '#7cae7a', '--red': '#d67d6a', '--yellow': '#d6b46a',
      '--accent-bg': 'rgba(217,119,87,.16)', '--bg-hover': 'rgba(255,255,255,.07)',
    },
  },
];

const ALL_VARS = [...new Set(THEMES.flatMap((t) => Object.keys(t.vars)))];

let current = 'dark';
export function currentTheme() { return current; }

// apply: 只改 documentElement 内联变量;persist: 写 settings.theme(设置面板点选时 true)
export function applyTheme(id, { persist = false } = {}) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  const root = document.documentElement;
  for (const k of ALL_VARS) {
    if (t.vars[k] !== undefined) root.style.setProperty(k, t.vars[k]);
    else root.style.removeProperty(k);
  }
  current = t.id;
  if (persist) api.setSetting('theme', t.id);
  return current;
}

// boot 时调用:读 settings.theme 应用(无记录 = 默认深色)
export async function bootTheme() {
  try {
    const st = await api.getStore();
    const id = st && st.settings && st.settings.theme;
    if (id && THEMES.some((t) => t.id === id)) applyTheme(id);
  } catch {}
}
