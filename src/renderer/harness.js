// Harness 板块(v0.11.0):在 Drafter 窗口里嵌入 deepseek-harness 的 Web 前端,
// 经 file:// 加载 + IPC 桥与主进程的 harness 运行时通信。
//
// 结构:
//  - enterSection():进入板块时启动 harness 引擎(幂等)+ 加载 webview
//  - harness 前端跑在 <webview> 里(它才能挂 harness 专属 preload),src 是主进程渲染的
//    index.electron.html
//  - 状态行(harness-status)显示 boot 进度;webview dom-ready 后淡出

import { $ } from './state.js';

let bootStarted = false;
let frameReady = false;

export async function enterSection() {
  const status = $('harness-status');
  const frame = $('harness-frame');
  if (!status || !frame) return;

  // 首次进入:启动 harness 引擎 + 渲染 index
  if (!bootStarted) {
    bootStarted = true;
    status.querySelector('.harness-status-text').textContent = '正在启动 Harness 引擎…';
    try {
      const indexPath = await window.api.harnessBoot();
      status.querySelector('.harness-status-text').textContent = '正在加载 Harness 界面…';
      // webview 的 preload 指向 harness 专属 preload(注入 __DRAFTER_IPC_RAW__)
      const preloadPath = await window.api.harnessPreloadPath();
      frame.setAttribute('preload', 'file:///' + preloadPath.replace(/\\/g, '/'));
      frame.src = 'file:///' + indexPath.replace(/\\/g, '/');
    } catch (err) {
      status.querySelector('.harness-status-text').textContent = 'Harness 启动失败:' + (err && err.message || err);
      console.error('[harness] boot failed:', err);
      bootStarted = false; // 允许重试
      return;
    }
  }

  // webview dom-ready 后淡出状态行
  if (!frameReady) {
    frame.addEventListener('dom-ready', () => {
      frameReady = true;
      status.classList.add('hidden');
    }, { once: true });
  } else {
    status.classList.add('hidden');
  }
}
