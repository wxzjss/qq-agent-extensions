/**
 * local-chat —— 本地聊天（确定性的"开关型"插件 / plugins/）
 *
 * ── 它是什么 ────────────────────────────────────────────────────────────────
 *   不打开 QQ，直接在控制台里跟同一个她聊天。实现全部在核心：
 *     · src/app.js       sendLocalMessage()：把界面输入塞进会话 local:console，
 *                        之后走的是和 QQ 完全相同的链路（入库 → 编排器判定 →
 *                        模型 → send_message 工具）
 *     · src/sender.js    sendTextBatch() 看到 `local:` 前缀就不调 OneBot，
 *                        只把回复写回本地库（表情/图片降级成文字标记）
 *     · src/routes.js    /api/local-chat/{available,messages,send}
 *     · ui/app/13-livechat.js + index.html 里的「聊天」页签
 *
 * ── 为什么这一层是"插件" ────────────────────────────────────────────────────
 *   按本项目的约定（见 src/plugin-loader.js 顶部注释）：
 *     核心写逻辑，插件决定它是否生效、以及生效时的少量参数。
 *   所以这里只提供一个能力 `console.chat.meta`：核心的接口先问它"要不要开"，
 *   拿不到（插件没装 / 被关）就统一 404，界面上的页签也不会出现。
 *   好处是关闭插件 = 功能彻底消失，不需要改代码，也不会留下半开的入口。
 */
import { getSkillConfig } from '../../src/skills/config.js';

export const providers = {
  /**
   * 返回 { enabled, title }。
   * 核心只看 enabled !== false；title 用于页签文案（可在插件设置里改）。
   */
  'console.chat.meta': (() => {
    return function consoleChatMeta() {
      let title = '聊天';
      try {
        const cfg = getSkillConfig('local-chat') || {};
        const custom = String(cfg.title || '').trim();
        if (custom) title = custom;
      } catch { /* 读不到配置就用默认值，绝不能因为改个名字把功能弄挂 */ }
      return { enabled: true, title };
    };
  })()
};
