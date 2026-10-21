/**
 * 隐藏清空存档 · 控制台注入脚本（由 plugins/hide-clear-archive 安装到 ui/）
 * ═══════════════════════════════════════════════════════════════════════════
 * 干的活：把存档页详情头部的「清空存档」按钮藏起来（display:none）。
 *
 * 三条硬约束（踩过才知道）：
 *   ① **只隐藏、不删元素**：04-archive-usage.js 渲染完直接
 *      `$('#chat-clear-btn').addEventListener(...)`，元素不在就是 null.addEventListener，
 *      整页渲染会断在半截 —— 比按钮露在外面严重得多。
 *   ② 页面会被反复整块重绘（innerHTML 换掉），所以用 MutationObserver 每次重绘后补一次。
 *   ③ 本脚本由 <script defer> 挂在 </head>，执行时机早于 /app/04-*.js，
 *      顶层不能碰宿主的全局函数，只能等 DOM 出现后再动。
 * ═══════════════════════════════════════════════════════════════════════════
 */
(function () {
  const BTN_ID = 'chat-clear-btn';   // 存档页的「清空存档」
  const FLAG = 'hcaHidden';

  function hideOnce() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    if (btn.dataset[FLAG] === '1') return;
    btn.dataset[FLAG] = '1';
    btn.style.display = 'none';
    // 多保险：万一别处把 style 又改回 block，这句兜一下
    btn.setAttribute('aria-hidden', 'true');
  }

  function start() {
    hideOnce();
    try {
      const ob = new MutationObserver(hideOnce);
      ob.observe(document.body, { childList: true, subtree: true });
    } catch {
      // 老浏览器没有 MutationObserver 就退回轮询：页面重绘后最多 1.5 秒补上
      setInterval(hideOnce, 1500);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
