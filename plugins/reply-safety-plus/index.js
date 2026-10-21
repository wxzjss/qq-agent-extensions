/**
 * reply-safety —— 回复安全网（确定性型 / plugins/）
 *
 * ── 它在治什么 ─────────────────────────────────────────────────────────────
 *   按程序设定，模型输出的**正文只是思考，不会发到 QQ**；要发言必须调用
 *   send_message。但模型（尤其是小模型）偶尔会把要说的话直接写在正文里，却
 *   忘了调用工具 —— 于是群友什么都收不到，用户看到的就是「她明明想了，却没发」。
 *
 *   本机实测：143 次运行里，43 次（约三成）是这种「正文写了成品话、一条都没发」。
 *   核心其实早就把抢救逻辑写好了（src/reply-rescue.js + orchestrator 里那几处
 *   `reply.*` 能力口），只是**从来没有任何插件提供实现** —— 每一级都取不到东西，
 *   整条兜底一直在空转。本插件就是把缺的这块补上。
 *
 * ── 它怎么接进核心 ─────────────────────────────────────────────────────────
 *   提供 4 个能力，由 src/reply-rescue.js 在「这一轮没有任何工具调用」时按序取用：
 *     ① reply.is-planning-text   正则否决：整段是计划腔/候选稿 → 整段放弃
 *     ② reply.loose-send         正则级抽取：整段都干净 → 原样搬走，不花模型调用
 *     ③ reply.salvage-lines      裁判级：拿不准时用一个小模型判「成品话 vs 内心戏」
 *     ④ reply.grounded-select    草稿溯源：只保留确实出自她自己草稿、且没发过的原句
 *
 * ── 硬约束（照 skill-reference 的口径）────────────────────────────────────
 *   · 只搬**原句**：不生成、不改写、不润色、不"帮她把话说完"
 *   · 拿不准一律沉默：任何一级判定失败都往"不发"走
 *     （把内心戏发进群，比这一轮不说话严重得多）
 *   · 提供者里**不发消息**、不碰发送队列，只返回候选句子；真正发送由核心走
 *     统一的发送队列（限频/去重/分条/留档/before-tool 守卫一个都不绕）
 *   · available() 同步返回；配置每次执行时现读（cfg()），不在 setup 时快照
 */

import { chatCompletion } from '../../src/llm.js';
import { getConfig } from '../../src/config.js';

let cfg = () => ({});
let log = () => {};
let warn = () => {};

const DEFAULTS = {
  sendAll: true,
  dryRun: false,
  useLooseSend: true,
  groundCheck: true,
  maxMessages: 3,
  judgeModel: '',
  judgeProvider: ''
};

// 全发模式的硬上限：一次最多发 12 行、单行最多 500 字。
// 不设上限的话，一段几千字的思考会被原样刷成几十条消息 —— 那不是"想到什么发什么"，
// 那是炸群。上限只截断长度，不改写内容。
const SEND_ALL_MAX_LINES = 12;
const SEND_ALL_MAX_LINE_CHARS = 500;

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v, d = '') => { const s = String(v ?? '').trim(); return s || d; };
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

function settings() {
  const s = (typeof cfg === 'function' ? cfg() : null) || {};
  const pick = (k) => (s[k] === undefined || s[k] === null || s[k] === '' ? DEFAULTS[k] : s[k]);
  return {
    sendAll: s.sendAll === undefined ? DEFAULTS.sendAll : s.sendAll !== false,
    dryRun: s.dryRun === true,
    useLooseSend: s.useLooseSend === undefined ? DEFAULTS.useLooseSend : s.useLooseSend !== false,
    groundCheck: s.groundCheck === undefined ? DEFAULTS.groundCheck : s.groundCheck !== false,
    maxMessages: Math.max(1, Math.min(6, Math.round(num(pick('maxMessages'), DEFAULTS.maxMessages)))),
    judgeModel: str(s.judgeModel),
    judgeProvider: str(s.judgeProvider)
  };
}

/* ═══════════════════════ 文本工具 ═══════════════════════ */

/** 工具调用伪代码：这些不是要说的话，任何一级都不能把它当成品话。 */
const TOOL_RE = /<tool_call|<function\s*=|\{\s*"(messages|name|function|tool_calls|arguments|parameters)"|```|^\s*send_message\s*\(/i;

/** 元叙述（"我调用了 xx 获取数据"这类内心戏伪代码）。 */
const META_RE = /调\s*用\s*.{0,12}(工具|函数|tool|get_|memory_|web_|send_)|我(刚|已经)?(发了|发送了)|tool_calls|function\s*call/i;

/**
 * 强计划腔标记：模型在正文里**比较几种备选说法**时，任何一句单独看都像成品，
 * 整段都不能发。这里故意收得极窄 —— 否决的代价是"这一段一个字都不救"，
 * 误判一次就丢掉一条本来该发的正常发言，比误发更伤。所以只认明确的
 * "列方案 / 换说法 / 比长短"动作，像"太长不看"这种正常吐槽绝不能命中。
 */
const PLANNING_RE = /备选|候选|方案[一二三四1-4]|(?:或者|还是)(?:改成|换成)|不如(?:回|说|发)|第[一二三1-3]个(?:方案|说法|版本)/;

/** 草稿味（仅用于"正则级放弃、转交裁判逐行判"，不构成硬否决）。 */
const DRAFT_SMELL_RE = /备选|候选|方案[一二三四1-4]|(?:或者|还是)(?:改成|换成)|不如(?:回|说|发)|(?:太长|太短|有点长|有点短)/;

/** 整行被括号包住 = 内心戏/舞台提示（群友不该看到）。 */
function isInnerLine(line) {
  const t = String(line ?? '').trim();
  if (!t) return false;
  if (/^[（(【\[「『]/.test(t)) return true;
  if (/^[（(【\[「『][\s\S]*[）)】\]」』]$/.test(t)) return true;
  return false;
}

/** 纯标点/单符号（"？""……"）不算一条要发的话。 */
const isPunctuationOnly = (line) => /^[\s，。！？、；：…~～!?,.－—\-—]+$/.test(String(line ?? ''));

/**
 * 把正文切成候选句。
 * 只按换行切 —— 不按空格切：角色设定里明确"不要用空格分句"，按空格切会把
 * "哼 现在才发现？" 拆成两句，反而违反了她自己的说话习惯。
 */
function splitLines(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ═══════════════════════ ① 计划腔否决 ═══════════════════════ */

/**
 * 判断整段是不是"计划腔/候选稿"。
 * 只做明显命中的否决：命中就整段放弃；拿不准一律返回规划 false，交给下游裁判。
 *
 * 全发模式下**永不否决**：用户明确要求"想到什么全发出来"，这时拿"她在比较几种
 * 说法"当理由整段丢掉，正好丢掉他最想看的东西。
 */
function isPlanningText({ text } = {}) {
  if (settings().sendAll) return { planning: false };
  const body = String(text ?? '').trim();
  if (!body) return { planning: false };
  // 有明确"在比较说法"的痕迹 → 整段不发
  if (PLANNING_RE.test(body)) return { planning: true };
  return { planning: false };
}

/* ═══════════════════════ ② 正则级抢救 ═══════════════════════ */

/**
 * 全发模式：正文里写了什么就搬什么。
 *
 * 与保守模式的唯一区别是**不再做"这句话像不像成品话"的判断** —— 括号内心戏、
 * 自我嘀咕、备选说法全部照发。只丢两类**不是话**的东西：
 *   · 工具调用语法（<tool_call>…、{"messages":…}、``` 围栏）——那是坏掉的
 *     工具调用，发出去是一串看不懂的符号
 *   · "我调用了 xx 工具"这类汇报腔 —— 同上，是机器口吻不是她要说的话
 * 另外设硬上限（12 行 / 单行 500 字），防止一段长思考被刷成几十条消息。
 */
function sendAllLines(body) {
  const out = [];
  for (const raw of splitLines(body)) {
    const line = raw.trim();
    if (!line) continue;
    if (TOOL_RE.test(line) || META_RE.test(line)) continue;
    out.push(line.length > SEND_ALL_MAX_LINE_CHARS ? `${line.slice(0, SEND_ALL_MAX_LINE_CHARS)}…` : line);
    if (out.length >= SEND_ALL_MAX_LINES) break;
  }
  return out;
}

/**
 * 整段**都干净**时，直接把它当成要说的话原样搬走（不花模型调用）。
 *
 * 刻意保守：只要出现任意一行像内心戏/伪代码/计划腔，就整段返回空，
 * 转交给裁判级去逐行判 —— 因为"混着内心戏的段落"正是最容易被误发的形态，
 * 正则级没有能力区分，硬搬就会把括号里的心理活动发进群。
 */
function looseSend({ text } = {}) {
  const s = settings();
  const body = String(text ?? '').trim();
  if (!body) return { messages: [] };

  // ── 全发模式：不做"像不像成品话"的判断，正文里写的都搬 ──
  if (s.sendAll) {
    const lines = sendAllLines(body);
    if (!lines.length) return { messages: [] };
    if (s.dryRun) {
      log(`【演练·全发】本来会发 ${lines.length} 条：${lines.map((x) => clip(x, 24)).join(' ｜ ')}`);
      return { messages: [] };
    }
    return { messages: lines };
  }

  // ── 保守模式 ──
  // 太长不像一条群聊发言，交给裁判
  if (body.length > 300) return { messages: [] };
  // 伪代码/元叙述/草稿味 → 正则级判不了，转交裁判逐行判（这里宽一点没关系：
  // 只是"不白搬"，句子仍有被裁判救回来的机会，不会丢）
  if (TOOL_RE.test(body) || META_RE.test(body) || DRAFT_SMELL_RE.test(body)) return { messages: [] };

  const lines = splitLines(body);
  if (!lines.length) return { messages: [] };
  if (lines.length > s.maxMessages) return { messages: [] };

  for (const line of lines) {
    if (line.length > 120) return { messages: [] };        // 小作文，交给裁判
    if (isInnerLine(line)) return { messages: [] };         // 有内心戏 → 交给裁判
    if (TOOL_RE.test(line) || META_RE.test(line)) return { messages: [] };
    if (isPunctuationOnly(line)) return { messages: [] };
  }
  if (s.dryRun) {
    log(`【演练】本来会发 ${lines.length} 条：${lines.map((x) => clip(x, 24)).join(' ｜ ')}`);
    return { messages: [] };
  }
  return { messages: lines };
}

/* ═══════════════════════ ③ 裁判级抢救 ═══════════════════════ */

/** 裁判用模型参数：默认沿用聊天主模型；配了 judgeModel 就换（可选换渠道）。 */
function resolveJudgeApi(s) {
  let base = null;
  try {
    const c = getConfig();
    const a = c.api || {};
    let apiKey = a.apiKey;
    if (!apiKey && a.provider) {
      const p = (c.providers || []).find((x) => String(x?.id) === String(a.provider));
      apiKey = p?.apiKey || c.dshProviderKeys?.[a.provider] || '';
    }
    base = { baseUrl: a.baseUrl, apiKey, model: a.model, provider: a.provider };
  } catch (error) {
    warn(`读取模型配置失败：${error?.message ?? error}`);
  }
  if (!s.judgeModel) return base;
  if (!s.judgeProvider) return { ...(base || {}), model: s.judgeModel };
  try {
    const c = getConfig();
    const p = (c.providers || []).find((x) => String(x?.id) === s.judgeProvider);
    const key = c.dshProviderKeys?.[s.judgeProvider] || p?.apiKey || base?.apiKey || '';
    return { baseUrl: p?.baseURL || base?.baseUrl, apiKey: key, provider: s.judgeProvider, model: s.judgeModel };
  } catch {
    return { ...(base || {}), model: s.judgeModel };
  }
}

function buildJudgeMessages({ lines, trigger, alreadySent, botName }) {
  const system = [
    '你在帮一个 QQ 群机器人做一件很小的事：她这一轮把「要说的话」写在了正文里，但忘了调用发送工具。',
    '正文按设计不会发到 QQ。你的任务：判断这段正文里，**哪些行是"成品话"（本来就是打给群友看的），哪些只是内心戏/思考**。',
    '',
    '【规则】',
    '1. 只能**原样复制**正文里已有的整行，一个字都不能改、不能合并、不能补全。',
    '2. 以下都不算成品话，必须排除：括号包起来的心理活动/舞台提示、计划与自我批注、工具调用伪代码、纯符号行。',
    '3. 如果这段正文整段都是内心戏、或你拿不准，就返回 say=0、lines 为空数组。',
    '4. 宁可少发，不可乱发：把内心戏发进群，比这一轮她什么都不说严重得多。',
    '5. 最多挑 ' + lines.max + ' 行。',
    '',
    '只输出一个 JSON 对象，不要任何其它文字、不要 Markdown：',
    '{"say":0或1,"lines":["原样复制的一行","另一行"]}'
  ].join('\n');

  const user = [
    `【机器人叫】${botName || '机器人'}`,
    trigger ? `【这一轮收到的消息】${clip(trigger, 300)}` : '',
    alreadySent?.length ? `【她已经发出去的内容（不要重复挑）】\n${alreadySent.map((x) => `- ${clip(x, 80)}`).join('\n')}` : '',
    '【她这一轮写在正文里的草稿（要判的是这个）】',
    lines.text,
    '按规则判断：哪些行是打给群友看的成品话？只回 JSON。'
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/** 宽容解析裁判输出：模型偶尔会包 ```json 或前后多说两句。 */
function parseJudge(raw) {
  const s = String(raw ?? '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj = null;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const rawSay = obj.say ?? obj.should_say ?? obj.speak;
  const say = typeof rawSay === 'boolean' ? rawSay
    : typeof rawSay === 'number' ? rawSay >= 1
      : typeof rawSay === 'string' ? /^(1|true|yes|y|是|发)$/i.test(rawSay.trim()) : null;
  const rawLines = obj.lines ?? obj.messages ?? obj.texts;
  const lines = Array.isArray(rawLines)
    ? rawLines.map((x) => String(x ?? '').trim()).filter(Boolean)
    : (typeof rawLines === 'string' && rawLines.trim() ? [rawLines.trim()] : []);
  if (say === null) return null;
  return { say: say && lines.length > 0, lines };
}

/**
 * 裁判级抢救：让一个小模型判「成品话 vs 内心戏」，只搬原句。
 * 任何异常/解析失败都返回 { say:false }（保守侧）。
 */
async function salvageLines({ text, trigger = '', alreadySent = [], api = null } = {}) {
  const s = settings();
  const body = String(text ?? '').trim();
  if (!body) return { say: false, messages: [] };

  // 全发模式：该发的已经在正则级原样搬完了，走到这里说明整段都是机器噪音
  // （工具语法/汇报腔），没有"该不该发"要判 —— 不花这次模型调用。
  if (s.sendAll) return { say: false, messages: [] };

  if (s.dryRun) {
    log(`【演练】本来会交给裁判判这段：${clip(body, 120)}`);
    return { say: false, messages: [] };
  }

  const judgeApi = resolveJudgeApi(s) || api;
  if (!judgeApi?.baseUrl || !judgeApi?.model) {
    warn('没有可用的裁判模型配置，本次按"不发"处理');
    return { say: false, messages: [] };
  }

  const messages = buildJudgeMessages({
    lines: { text: body, max: s.maxMessages },
    trigger,
    alreadySent,
    botName: (() => { try { return getConfig().persona?.botName || ''; } catch { return ''; } })()
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('裁判超时')), 15000);
  timer.unref?.();

  try {
    const result = await chatCompletion({
      messages,
      temperature: 0,
      maxTokens: 256,
      signal: controller.signal,
      overrides: judgeApi,
      // 判分类请求不需要思考：开着只会把预算烧在 reasoning 上，正文为空、JSON 被截断
      skillContext: { api: judgeApi, model: judgeApi.model, messages, thinkingMode: 'off', replySafety: true }
    });
    const content = result?.message?.content ?? '';
    const parsed = parseJudge(content);
    if (!parsed) {
      const finish = String(result?.finishReason || '');
      const reasoning = num(result?.usage?.completion_tokens_details?.reasoning_tokens, 0);
      const starved = !String(content).trim() && (finish === 'length' || reasoning > 0);
      warn(starved
        ? `裁判模型把预算烧在思考上（reasoning ${reasoning} token，finish=${finish || '?'}）——建议在插件设置里换一个能关思考的小模型`
        : `裁判输出无法解析：${clip(content, 80) || '(空)'}`);
      return { say: false, messages: [] };
    }
    if (!parsed.say) return { say: false, messages: [] };
    const picked = parsed.lines.slice(0, s.maxMessages);
    log(`裁判判定可发 ${picked.length} 行：${picked.map((x) => clip(x, 30)).join(' ｜ ')}`);
    return { say: true, messages: picked };
  } catch (error) {
    warn(`裁判失败（按"不发"处理）：${error?.cause?.message ?? error?.message ?? error}`);
    return { say: false, messages: [] };
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════ ④ 草稿溯源 ═══════════════════════ */

// 本轮运行的草稿池：只在一次运行内有意义（跨运行留着会把上一轮的句子当成本轮可发的原句）。
// 核心在每次运行开始时调 { reset:true } 清空，每轮正文调 { remember } 追加。
let drafts = [];

const normLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 这句话是否能在她自己的草稿里原样找到。 */
function groundedInDraft(line) {
  const target = normLine(line);
  if (!target) return false;
  for (const d of drafts) {
    const text = String(d ?? '').replace(/\r/g, '');
    // ① 作为整行出现
    if (text.split(/\n+/).some((x) => normLine(x) === target)) return true;
    // ② 或作为某一行的连续片段出现（裁判原样复制时可能没带上前后标点）
    if (text.split(/\n+/).some((x) => normLine(x).includes(target))) return true;
  }
  return false;
}

/**
 * 草稿溯源：只保留确实出自她自己草稿、且没发过的原句。
 * enabled=false 时核心不做过滤（等同关闭此闸）。
 */
function groundedSelect({ remember, reset, proposed, sent } = {}) {
  if (reset) { drafts = []; return { enabled: false, picked: [] }; }
  if (typeof remember === 'string') {
    drafts.push(remember);
    if (drafts.length > 20) drafts.splice(0, drafts.length - 20);
    return { enabled: false, picked: [] };
  }

  // 全发模式：句子本就是正文原样搬的，不存在"编造"风险，
  // 再拿草稿去比对只会把已该发的句子筛掉（正文记草稿的时机与搬句子的时机不一定对齐）。
  const enabled = settings().groundCheck !== false && !settings().sendAll;
  if (!enabled) return { enabled: false, picked: [] };

  const alreadySent = new Set((Array.isArray(sent) ? sent : [])
    .filter((x) => x?.type === 'text')
    .map((x) => normLine(x.text))
    .filter(Boolean));

  const picked = (Array.isArray(proposed) ? proposed : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .filter((line) => !alreadySent.has(normLine(line)) && groundedInDraft(line));

  return { enabled: true, picked };
}

/* ═══════════════════════ 生命周期 / 能力 ═══════════════════════ */

export function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  if (typeof api?.log === 'function') log = api.log;
  if (typeof api?.warn === 'function') warn = api.warn;
  drafts = [];
  const s = settings();
  log(`回复安全网已加载（${s.dryRun ? '演练中：只记日志不真发' : '启用'}`
    + `｜${s.sendAll ? '全发模式：正文写了什么就发什么' : '保守模式：只发成品话'}`
    + `｜正则级${s.useLooseSend ? '开' : '关'}｜草稿溯源${s.sendAll ? '停用(全发)' : (s.groundCheck ? '开' : '关')}）`);
}

export function available() {
  return true;
}

export function dispose() {
  drafts = [];
}

export const providers = {
  'reply.is-planning-text': isPlanningText,
  'reply.loose-send': looseSend,
  'reply.salvage-lines': salvageLines,
  'reply.grounded-select': groundedSelect
};

/** 测试/排障用导出。 */
export const __internals = {
  isPlanningText, looseSend, salvageLines, groundedSelect,
  resolveJudgeApi, parseJudge, splitLines, settings
};
