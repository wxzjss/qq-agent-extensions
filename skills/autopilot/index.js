// 办事模式（autopilot）—— 让她从「会聊天」变成「会把事办完」，而且手上真有工具
//
// ── 为什么是技能（skills/，LLM 型），不是插件（plugins/）────────────────────
//   按 doc/extend_development/skill-development.md §0 的三问：
//   ① 触发时机能写成 if 吗？——不能。「这句话是交办了一件要办好几步的事，还是随口聊」，
//      必须读懂人话；「提到查/找/做个」这类正则会把「你在干嘛」也判成任务。
//   ② 漏一次代价？——这次她只回了一句话没去办，人再催一次就补上了，不丢数据、不坏事。
//   ③ 参数从哪来？——目标、步骤、哪步做完了、要跑什么命令、改哪一行，全要从人话里抠。
//   三问一致指向 LLM 型 → 放 skills/，用 registerTool 把决定权交给模型。
//
// ── 两层内容 ──────────────────────────────────────────────────────────
//   纪律层（工作台）：plan 任务清单 / note 工作笔记，未完成的清单会随提示词注入（跨轮不忘）。
//   手脚层（完全权限）：run PowerShell / read / write / edit / ls / glob / grep。
//     「完全权限」= 主人要求的 DSH danger-full-access：不审批、不限目录、不挡命令。
//     唯一的约束是留痕 —— 每次动手都追加一行到 DATA_DIR/autopilot/audit.jsonl。
//     把关的是"谁在说话"：默认只放行主人私聊（群里认不出人，认不出就不放行），
//     要在群里也放行得主人自己打开 openToAll。
//
// ── 数据 ──────────────────────────────────────────────────────────────
//   DATA_DIR/autopilot/<chatKey>.json，原子写（先写 .tmp 再 rename）。
//   绝不用 process.cwd() 当锚点（照 skills/ledger 的约定；DATA_DIR 会被
//   QQ_AGENT_DATA_DIR / QQ_AGENT_PROFILE 重定向）。
//   清单形状：{ version, chatKey, goal, createdAt, updatedAt,
//               steps: [ { id, text, status, note, doneAt } ],
//               notes: [ { id, text, tag, at } ] }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../src/config.js';
import { webSearch, webFetch, bingSearch } from '../../src/web-search.js';

const SKILL_ID = 'autopilot';
const DIR = path.join(DATA_DIR, SKILL_ID);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 电脑操作脚本在仓库里存成 computer.ps1.txt：
// QQ Agent 打包发布（src/market.js）和从 zip 安装（src/zip-install.js）都会拦
// 可执行后缀（exe/dll/bat/cmd/ps1/vbs/sh），留 .ps1 会导致整个技能装不上/发不出。
// 于是源码用 .txt 存，运行时才把它落地成真正的 .ps1 到临时目录再执行。
const COMPUTER_SRC = path.join(HERE, 'tools', 'computer.ps1.txt');
let computerScriptPath = null;
let computerScriptSig = '';
function ensureComputerScript() {
  const st = fs.statSync(COMPUTER_SRC);
  const sig = `${st.mtimeMs}:${st.size}`;
  const dir = path.join(os.tmpdir(), 'qq-agent-autopilot');
  const target = path.join(dir, 'computer.ps1');
  // 源文件改过（mtime/大小变了）就重新落地一次，避免改了 .txt 却还在跑旧脚本
  if (computerScriptPath === target && computerScriptSig === sig && fs.existsSync(target)) return target;
  const body = fs.readFileSync(COMPUTER_SRC, 'utf8');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, body, 'utf8');
  computerScriptPath = target;
  computerScriptSig = sig;
  return target;
}
const AUDIT_FILE = path.join(DIR, 'audit.jsonl');

const STATUSES = ['pending', 'doing', 'done', 'skipped'];
const STATUS_ALIAS = {
  pending: 'pending', todo: 'pending', open: 'pending', 待办: 'pending', 未开始: 'pending', 没做: 'pending',
  doing: 'doing', in_progress: 'doing', inprogress: 'doing', wip: 'doing', running: 'doing',
  进行中: 'doing', 在做: 'doing', 正在做: 'doing',
  done: 'done', finished: 'done', complete: 'done', completed: 'done', ok: 'done', success: 'done',
  完成: 'done', 已完成: 'done', 做好了: 'done', 搞定: 'done',
  skipped: 'skipped', skip: 'skipped', cancel: 'skipped', cancelled: 'skipped',
  跳过: 'skipped', 不做: 'skipped', 放弃: 'skipped'
};
const MARK = { pending: '·', doing: '▸', done: '✔', skipped: '—' };

const DEFAULTS = {
  fullAccess: true,
  openToAll: false,
  workspace: '',
  runTimeout: 120,
  strictMode: true,
  injectProgress: true,
  neverGiveUp: true,
  ownerQQ: '',
  computerUse: true,
  maxSteps: 12
};
const MAX_STEPS_CAP = 30;
const MAX_NOTES = 120;
const PROMPT_CHARS = 700;
const OUT_CAP = 9000;        // 单次工具回给模型的最大字符数
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.cache', '__pycache__']);
const MAX_WALK_FILES = 40000;

let cfgFn = null;
let warn = () => {};
let capabilityFn = null;

function cfg() {
  try {
    const c = cfgFn ? cfgFn() : null;
    const merged = { ...DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
    let maxSteps = Number(merged.maxSteps);
    if (!Number.isFinite(maxSteps)) maxSteps = DEFAULTS.maxSteps;
    maxSteps = Math.min(MAX_STEPS_CAP, Math.max(3, Math.round(maxSteps)));
    let runTimeout = Number(merged.runTimeout);
    if (!Number.isFinite(runTimeout)) runTimeout = DEFAULTS.runTimeout;
    runTimeout = Math.min(900, Math.max(10, Math.round(runTimeout)));
    return { ...merged, maxSteps, runTimeout, fullAccess: merged.fullAccess !== false };
  } catch {
    return { ...DEFAULTS };
  }
}

// ─────────────────────────────────────────────── 小工具
function clean(s, max = 200) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clip(s, cap = OUT_CAP) {
  const t = String(s ?? '');
  if (t.length <= cap) return t;
  return `${t.slice(0, cap)}\n…（输出太长，后面 ${t.length - cap} 字符省略了）`;
}

function normStatus(v) {
  const raw = clean(v, 24).toLowerCase().replace(/[\s-]+/g, '_');
  if (STATUS_ALIAS[raw]) return STATUS_ALIAS[raw];
  const raw2 = clean(v, 24);
  if (STATUS_ALIAS[raw2]) return STATUS_ALIAS[raw2];
  return null;
}

function chatKeyOf(ctx) {
  const k = clean(ctx && ctx.chatKey, 80);
  return k || 'unknown';
}

function fileFor(chatKey) {
  const safe = chatKey.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'unknown';
  return path.join(DIR, `${safe}.json`);
}

function emptyState(chatKey) {
  return { version: 1, chatKey, goal: '', createdAt: 0, updatedAt: 0, steps: [], notes: [] };
}

function load(chatKey) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(fileFor(chatKey), 'utf8'));
  } catch {
    return emptyState(chatKey);
  }
  if (!data || typeof data !== 'object') return emptyState(chatKey);
  const steps = Array.isArray(data.steps)
    ? data.steps
        .filter((s) => s && typeof s.text === 'string')
        .slice(0, MAX_STEPS_CAP)
        .map((s, i) => ({
          id: i + 1,
          text: clean(s.text, 300),
          status: STATUSES.includes(s.status) ? s.status : 'pending',
          note: clean(s.note, 300),
          doneAt: Number(s.doneAt) || 0
        }))
    : [];
  const notes = Array.isArray(data.notes)
    ? data.notes
        .filter((n) => n && typeof n.text === 'string')
        .slice(-MAX_NOTES)
        .map((n, i) => ({ id: i + 1, text: clean(n.text, 1200), tag: clean(n.tag, 40), at: Number(n.at) || 0 }))
    : [];
  return {
    version: 1,
    chatKey,
    goal: clean(data.goal, 300),
    createdAt: Number(data.createdAt) || 0,
    updatedAt: Number(data.updatedAt) || 0,
    steps,
    notes
  };
}

function save(state) {
  state.updatedAt = Date.now();
  fs.mkdirSync(DIR, { recursive: true });
  const file = fileFor(state.chatKey);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function stepLine(s) {
  const mark = MARK[s.status] || MARK.pending;
  return `${s.id}. ${mark} ${s.text}${s.note ? `（${s.note}）` : ''}`;
}

function fmtPlan(state) {
  const total = state.steps.length;
  const done = state.steps.filter((s) => s.status === 'done').length;
  return `目标：${state.goal || '（没写）'}\n进度：${done}/${total}\n${state.steps.map(stepLine).join('\n')}`;
}

function summarize(state) {
  const total = state.steps.length;
  const done = state.steps.filter((s) => s.status === 'done').length;
  const left = state.steps.filter((s) => s.status !== 'done' && s.status !== 'skipped');
  return { total, done, left };
}

// ─────────────────────────────────────────────── 审计 + 放行
function audit(entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    /* 审计写不进去也不能拦住活儿，但留个 warn */
    warn('审计日志写入失败');
  }
}

/**
 * 谁在说话 → 放不放行。
 * 私聊：会话里只有主人和机器人两个，"peer"就是说话的人（机器人的私聊基本都是主人）。
 * 群聊：ctx 里拿不到调用者 QQ（只能从"最近一条别人发的消息"反推，会张冠李戴），
 *       所以默认一律不放行；主人要放行得自己打开 openToAll。
 */
function callerOf(ctx) {
  if (!ctx) return { id: '', kind: 'unknown', name: '' };
  // local = 控制台里的「聊天」：只在本机、只有主人能开，按私聊对待
  const raw = ctx.kind === 'private' || ctx.kind === 'local' ? 'private'
    : ctx.kind === 'group' ? 'group' : 'unknown';
  return { id: clean(ctx.chatId, 30), kind: raw, name: clean(ctx.chatName, 40) };
}

function gate(ctx, toolName, args) {
  const c = cfg();
  const caller = callerOf(ctx);
  if (c.openToAll) return { ok: true, caller };
  // 本地聊天（local:console）就是主人在自己电脑上说话：直接放行，不必再对 QQ 号。
  // 这条是 2026-10-22 加的 —— 之前它被当成"不是私聊"而拒绝，主人在聊天页让她干活
  // 会得到「这个只有主人私聊能用」。
  if (ctx?.local === true || String(ctx?.chatKey || '').startsWith('local:')) {
    return { ok: true, caller: { ...caller, kind: 'private', local: true } };
  }

  // ① 技能里写死的主人 QQ 优先于一切（包括「主人识别」插件）。
  //    主人 2026-10-21 要求：以这里填的号码为准 —— 填了就不再看别的地方。
  const ownerQQ = clean(c.ownerQQ, 30);
  if (ownerQQ && caller.kind === 'private' && caller.id) {
    if (caller.id !== ownerQQ) {
      return {
        ok: false,
        caller,
        content: `拒绝：这个技能设置里的主人是 QQ ${ownerQQ}，当前私聊的是 ${caller.id}，不是主人，所以不动手。\n`
          + '如实回一句「这个只有主人能用」，不要解释技术细节、也不要换别的工具去绕。'
      };
    }
    return { ok: true, caller };   // 命中主人 QQ：直接放行，不再问其它判定
  }

  if (caller.kind !== 'private') {
    return {
      ok: false,
      caller,
      content:
        '拒绝：只有主人在私聊里才能让她动这台电脑。当前是群聊 —— 群里认不出是谁在说话，\n' +
        '为免被随便谁指挥去删东西，一律不放行。\n' +
        '对群里那个人就回一句「这个只有主人私聊能用」，不要解释技术细节、也不要重试其他工具去绕。'
    };
  }
  // 私聊：认一下是不是主人（能问就问，问不到就按私聊通道放行 —— 机器人的私聊本来就是主人的）
  if (caller.id) {
    let verdict = null;
    try {
      if (typeof capabilityFn === 'function') verdict = capabilityFn('message.owner-check', { userId: caller.id });
    } catch {
      verdict = null;
    }
    if (verdict && verdict.isOwner === false) {
      return {
        ok: false,
        caller,
        content: `拒绝：「主人识别」说 ${caller.id} 不是主人，所以没动手。如实告诉对方「这个只有主人能用」。`
      };
    }
  }
  // 注意：审计不在这里写 —— 每个工具自己写一条带细节的（命令原文+退出码、路径+字节数…），
  // 别为了省事在这写一遍，否则同一个动作会在台账里留两行。
  return { ok: true, caller };
}

/** 保守模式（fullAccess=false）下的路径闸：只允许在 workspace 里；没配 workspace 就只读不写。 */
function checkPath(p, write, c) {
  if (c.fullAccess) return null;
  const ws = clean(c.workspace, 400);
  if (!ws) {
    return write
      ? '当前是保守模式、又没配「允许目录」，所以不许写。要写就请在技能设置里填允许目录，或打开完全权限。'
      : null;
  }
  let abs;
  let root;
  try {
    abs = path.resolve(p);
    root = path.resolve(ws);
  } catch {
    return '路径不对。';
  }
  const rel = path.relative(root, abs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return null; // 在允许目录里
  return `保守模式只允许在 ${root} 里动，${abs} 在外面，不许。`;
}

/**
 * 把子进程吐的字节解码成人话。
 * PowerShell 5.1 / 老式 Windows 程序（dir、ipconfig、reg query…）输出的是系统 ANSI 码页
 * （简体系统 = GBK），直接按 utf8 解就满屏乱码。所以：先按 utf8 解，发现替换符再试 GBK，
 * 挑坏字符少的那个；UTF-16 BOM 的（`>` 重定向出来的）单独认。
 */
function decodeOut(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/\0+$/, '');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const utf8 = buf.toString('utf8');
  const badUtf8 = (utf8.match(/\uFFFD/g) || []).length;
  if (badUtf8 === 0) return utf8;
  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(buf);
    const badGbk = (gbk.match(/\uFFFD/g) || []).length;
    return badGbk < badUtf8 ? gbk : utf8;
  } catch {
    return utf8;
  }
}

// ─────────────────────────────────────────────── 跑命令
function runCommand(command, cwd, timeoutSec, c) {
  return new Promise((resolve) => {
    const shellExe = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    const argv = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
      : ['-lc', command];
    const useCwd = cwd && String(cwd).trim() ? String(cwd).trim() : undefined;
    if (useCwd) {
      const bad = checkPath(useCwd, true, c);
      if (bad) return resolve({ ok: false, out: bad, code: null, timedOut: false });
    }
    let child;
    try {
      child = spawn(shellExe, argv, {
        cwd: useCwd,
        windowsHide: true,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      return resolve({ ok: false, out: `启动失败：${(err && err.message) || err}`, code: null, timedOut: false });
    }
    let outBuf = [];
    let errBuf = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* ignore */
      }
    }, Math.max(1, timeoutSec) * 1000);

    child.stdout.on('data', (d) => {
      if (outLen < OUT_CAP * 4) {
        outBuf.push(d);
        outLen += d.length;
      }
    });
    child.stderr.on('data', (d) => {
      if (errLen < OUT_CAP * 4) {
        errBuf.push(d);
        errLen += d.length;
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, out: `启动失败：${(err && err.message) || err}`, code: null, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = [decodeOut(Buffer.concat(outBuf)).trim(), decodeOut(Buffer.concat(errBuf)).trim()]
        .filter(Boolean)
        .join('\n');
      resolve({ ok: code === 0, out: body, code, timedOut });
    });
  });
}

// ─────────────────────────────────────────────── 电脑操作（Computer Use）小工具
// 参照 dsh-orb 的 Computer Use 做法：截图 → 看坐标 → 点/拖/滚 → 打字/快捷键。
// 这里不引第三方依赖，全部走一个 PowerShell 助手（tools/computer.ps1），
// 用 -File + 参数数组传参，绕开 PowerShell 的引号坑（那个坑把 node -e 弄挂过）。
function runComputer(action, params = {}, timeoutSec = 30) {
  return new Promise((resolve) => {
    let script;
    try {
      script = ensureComputerScript();
    } catch (err) {
      return resolve({ ok: false, out: `准备脚本失败：${(err && err.message) || err}` });
    }
    const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', String(action || '')];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      argv.push(`-${k}`, String(v));
    }
    let child;
    try {
      child = spawn('powershell.exe', argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, out: `启动失败：${(err && err.message) || err}` });
    }
    let buf = [];
    let len = 0;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出 */ }
    }, Math.max(5, timeoutSec) * 1000);
    child.stdout.on('data', (d) => { if (len < OUT_CAP * 4) { buf.push(d); len += d.length; } });
    child.stderr.on('data', (d) => { if (len < OUT_CAP * 4) { buf.push(d); len += d.length; } });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, out: `启动失败：${(err && err.message) || err}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const out = decodeOut(Buffer.concat(buf)).trim();
      let data = null;
      try { data = JSON.parse(out.split('\n').filter(Boolean).pop() || 'null'); } catch { data = null; }
      resolve({ ok: Boolean(data && data.ok), out, data });
    });
  });
}

// ─────────────────────────────────────────────── 网页正文提取
// 不引第三方解析库：去掉脚本/样式/注释，剥标签，解几个常见实体，压空白。
// 目标只是"能读懂"，不追求版式。
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—').replace(/&hellip;/g, '…');
  s = s.replace(/[ \t\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ─────────────────────────────────────────────── 文件小工具
function walk(root, onFile) {
  let seen = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        seen += 1;
        if (seen > MAX_WALK_FILES) return seen;
        if (onFile(full) === false) return seen;
      }
    }
  }
  return seen;
}

function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, '/');
  let out = '^';
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (g[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  try {
    return new RegExp(`${out}$`);
  } catch {
    return null;
  }
}

function isProbablyText(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return false;
  return true;
}

// ─────────────────────────────────────────────── 工具
export function setup(api) {
  cfgFn = api.config;
  warn = typeof api.warn === 'function' ? api.warn : () => {};
  capabilityFn = typeof api.capability === 'function' ? api.capability : null;

  // ── 纪律：任务清单
  api.registerTool({
    id: 'plan',
    name: '任务清单',
    description:
      '建立/更新/查看这次要做的事的步骤清单。当有人交办一件要好几步才能完成的事（查资料、做对比、写文档、排查问题、改东西）时，先用 action=create 把步骤一句一步列出来；每做完一步用 action=update 把那一项勾成 done；接着上一轮的活时先用 action=list 看做到哪了。闲聊和一句话能答的问题不要用。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'list', 'clear'],
          description: 'create=新建清单（覆盖同会话旧清单）；update=改某一步；list=看当前清单；clear=整份清掉'
        },
        goal: { type: 'string', description: '要办成的那件事，一句话。create 时填。' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'create 时填：按顺序排好的步骤，一句一步，3~8 步最合适。'
        },
        stepId: { type: 'number', description: 'update 时填：要改的那一步序号（从 1 开始，跟 list 显示的一致）。' },
        status: {
          type: 'string',
          enum: ['pending', 'doing', 'done', 'skipped'],
          description: 'update 时填：这一步的状态。done=做完了，doing=正在做，skipped=跳过。'
        },
        note: { type: 'string', description: 'update 时可选：给这一步补一句备注（结果怎样、卡在哪）。' }
      },
      required: ['action']
    },
    category: 'system',
    icon: '📋',
    async execute(ctx, args) {
      try {
        const action = clean(args && args.action, 20).toLowerCase() || 'list';
        const chatKey = chatKeyOf(ctx);
        const state = load(chatKey);
        const { maxSteps } = cfg();

        if (action === 'create') {
          const goal = clean(args.goal, 300);
          const rawSteps = Array.isArray(args.steps) ? args.steps : [];
          const steps = rawSteps
            .map((s) => (typeof s === 'string' ? s : s && (s.text || s.title || s.step)))
            .map((s) => clean(s, 300))
            .filter(Boolean)
            .slice(0, maxSteps);
          if (!goal && steps.length === 0) {
            return { content: '建清单失败：goal 和 steps 至少要给一个，不然不知道要办什么。', isError: true };
          }
          if (steps.length === 0) {
            return { content: '建清单失败：steps 是空的。把要做的事拆成一句一步再传。', isError: true };
          }
          state.goal = goal;
          state.createdAt = Date.now();
          state.steps = steps.map((text, i) => ({ id: i + 1, text, status: 'pending', note: '', doneAt: 0 }));
          if (!Array.isArray(state.notes)) state.notes = [];
          save(state);
          return { content: `清单已建好（${steps.length} 步）：\n${fmtPlan(state)}` };
        }

        if (action === 'update') {
          if (state.steps.length === 0) return { content: '现在没有清单，先 create 一份再 update。', isError: true };
          const idNum = Number(args.stepId);
          if (!Number.isFinite(idNum) || Math.round(idNum) < 1 || Math.round(idNum) > state.steps.length) {
            return { content: `stepId 不对：当前清单只有 1~${state.steps.length} 步。先 action=list 看清序号。`, isError: true };
          }
          const target = state.steps[Math.round(idNum) - 1];
          const status = args.status ? normStatus(args.status) : null;
          if (args.status && !status) return { content: 'status 只认 pending / doing / done / skipped。', isError: true };
          const note = clean(args.note, 300);
          if (!status && !note) return { content: 'update 得给 status 或 note，否则没有变化。', isError: true };
          if (status) {
            target.status = status;
            target.doneAt = status === 'done' ? Date.now() : 0;
          }
          if (note) target.note = note;
          save(state);
          const s = summarize(state);
          const tail = s.left.length === 0 ? '全部走完了，可以照清单收尾汇报。' : `还剩 ${s.left.length} 步没走完。`;
          return { content: `已更新第 ${target.id} 步。${s.done}/${s.total}，${tail}\n${fmtPlan(state)}` };
        }

        if (action === 'clear') {
          if (state.steps.length === 0 && state.notes.length === 0) return { content: '本来就没有清单和笔记，不用清。' };
          const backup = fmtPlan(state);
          save(emptyState(chatKey));
          return { content: `已清空这个会话的清单和笔记。清掉的是：\n${backup}` };
        }

        if (state.steps.length === 0) return { content: '这个会话还没有清单。要办多步的活就先 create 一份。' };
        const s = summarize(state);
        const noteLine = state.notes.length ? `\n（另有 ${state.notes.length} 条工作笔记，用 note 技能 action=list 看）` : '';
        return { content: `${fmtPlan(state)}\n\n已完成 ${s.done}/${s.total}，未完成 ${s.left.length} 步。${noteLine}` };
      } catch (err) {
        warn('plan 工具出错', err && err.message);
        return { content: `清单操作失败：${(err && err.message) || err}`, isError: true };
      }
    }
  });

  // ── 纪律：工作笔记
  api.registerTool({
    id: 'note',
    name: '工作笔记',
    description:
      '办事过程中把关键结论、数字、文件路径、命令输出要点记下来，免得隔几轮忘了或重新查一遍。办多步任务时每完成一小段记一条；接着旧活继续前先 action=list 把之前记的翻出来看。闲聊不要用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'clear'], description: 'add=记一条；list=翻出来看；clear=清空笔记（不影响清单）' },
        text: { type: 'string', description: 'add 时填：要记的内容。写具体的（数字、路径、结论），别写「已查过」这种没信息量的话。' },
        tag: { type: 'string', description: 'add 时可选：短标签，比如「价格」「路径」「结论」。' },
        limit: { type: 'number', description: 'list 时可选：最多看最近几条，默认 20，最多 100。' }
      },
      required: ['action']
    },
    category: 'memory',
    icon: '📝',
    async execute(ctx, args) {
      try {
        const action = clean(args && args.action, 20).toLowerCase() || 'add';
        const chatKey = chatKeyOf(ctx);
        const state = load(chatKey);

        if (action === 'add') {
          const text = clean(args.text, 1200);
          if (!text) return { content: 'add 得给 text，不然记什么？', isError: true };
          state.notes.push({ id: Date.now(), text, tag: clean(args.tag, 40), at: Date.now() });
          if (state.notes.length > MAX_NOTES) state.notes = state.notes.slice(-MAX_NOTES);
          save(state);
          return { content: `记下了（这个会话共 ${state.notes.length} 条笔记）。` };
        }
        if (action === 'clear') {
          const n = state.notes.length;
          state.notes = [];
          save(state);
          return { content: `已清空 ${n} 条笔记（任务清单没动）。` };
        }
        if (state.notes.length === 0) return { content: '这个会话还没有工作笔记。' };
        let limit = Number(args.limit);
        if (!Number.isFinite(limit) || limit <= 0) limit = 20;
        limit = Math.min(100, Math.round(limit));
        const picked = state.notes.slice(-limit);
        const body = picked
          .map((n, i) => `${i + 1}. ${n.tag ? `[${n.tag}] ` : ''}${n.text}`)
          .join('\n');
        return { content: `最近 ${picked.length} 条笔记（共 ${state.notes.length} 条）：\n${body}` };
      } catch (err) {
        warn('note 工具出错', err && err.message);
        return { content: `笔记操作失败：${(err && err.message) || err}`, isError: true };
      }
    }
  });

  // ── 手：跑命令
  api.registerTool({
    id: 'run',
    name: '跑命令（PowerShell）',
    description:
      '在这台电脑上真跑一条 PowerShell 命令并拿回输出（完全权限：不审批、不限目录、不挡命令）。看目录、跑脚本、查进程、装依赖、构建、改配置都行。要读/改文件也可以用它，但纯读写文件优先用 read/write/edit 更省事。输出里有退出码，非 0 就是失败。'
      + '⚠️ 引号陷阱：不要用 `node -e "……"` 执行带双引号或反斜杠的代码——PowerShell 不认 `\\"` 这种转义，会把引号吃掉，node 收到残缺代码直接 SyntaxError（实测过）。'
      + '需要跑一段代码就先用 write 存成 .js 文件，再 `node 文件.js`；需要构建就调用项目里现成的脚本（如 build.js），别在命令行里拼。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令原文。多行可以。' },
        cwd: { type: 'string', description: '可选：在这条命令的工作目录里跑（绝对路径）。' },
        timeoutSec: { type: 'number', description: '可选：超时秒数，默认跟随技能设置（120 秒），最大 900。' }
      },
      required: ['command']
    },
    category: 'system',
    icon: '⚡',
    async execute(ctx, args) {
      const g = gate(ctx, 'run', args);
      if (!g.ok) return { content: g.content, isError: true };
      const c = cfg();
      const command = String((args && args.command) || '').trim();
      if (!command) return { content: 'command 是空的，没东西可跑。', isError: true };
      if (!c.fullAccess) {
        return {
          content:
            '现在开着保守模式，跑不了命令 —— 保守模式只允许在「允许目录」里读写文件。\n' +
            '要是这次真需要跑命令，如实说「这得打开完全权限才行」，别想办法绕（例如用 read/write 拼出效果）。',
          isError: true
        };
      }
      let timeoutSec = Number(args && args.timeoutSec);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) timeoutSec = c.runTimeout;
      timeoutSec = Math.min(900, Math.round(timeoutSec));
      const started = Date.now();
      const r = await runCommand(command, args && args.cwd, timeoutSec, c);
      audit({
        tool: 'run',
        caller: g.caller.id,
        command: command.slice(0, 500),
        cwd: clean(args && args.cwd, 200),
        exitCode: r.code,
        timedOut: r.timedOut,
        ms: Date.now() - started
      });
      const head = r.timedOut
        ? `[已超时：${timeoutSec} 秒，进程已杀]`
        : `[exit code: ${r.code === null ? 'unknown' : r.code}]`;
      const body = r.out ? `\n${r.out}` : '\n（没有任何输出）';
      return { content: clip(`${head}${body}`), isError: r.ok === false };
    }
  });

  // ══ 联网：搜索 + 抓正文 ═══════════════════════════════════════════════
  // 核心本来就有 web_search / web_fetch（给对话用的），但办事模式下她未必看得到那种
  // "对话工具"，问到实时信息时会直接说"我没法上网"。这里给办事模式配一套自己的：
  // 直接调 src/web-search.js，走用户设置里的搜索 provider（默认 DeepSeek/Bing）。
  const webGuard = (ctx, tool) => gate(ctx, tool, {});

  api.registerTool({
    id: 'search',
    name: '联网搜索',
    description:
      '真的上网搜（走设置里的搜索服务，默认 Bing/DeepSeek），返回标题 + 链接 + 摘要。'
      + '适用：实时信息、新闻、价格、版本号、自己不确认的事实、报错原文。'
      + '可以先换 2~3 组关键词连搜；对最相关的 1~2 条再用 fetch 读正文，别只看摘要。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词（自然语言或关键词都行）。' }
      },
      required: ['query']
    },
    category: 'web',
    icon: '🔍',
    async execute(ctx, args) {
      const g = webGuard(ctx, 'search');
      if (!g.ok) return { content: g.content, isError: true };
      const q = String((args && args.query) || '').trim();
      if (!q) return { content: '搜索词是空的。', isError: true };
      const started = Date.now();
      try {
        let r = await webSearch(q);
        let results = r?.results || [];
        // 兜底：某些 provider（服务端搜索）遇到实时信息会回"我无法联网"，或干脆没结果。
        // 这种时候自动再走一遍 Bing —— 宁可多一次请求，也别让主人听到"我上不了网"。
        const useless = !results.length
          || (results.length === 1 && !results[0].url && /无法|不能|抱歉|不具备|请自行/.test(String(results[0].snippet || results[0].title || '')));
        if (useless) {
          try {
            const b = await bingSearch(q);
            if ((b?.results || []).length) { r = b; results = b.results; }
          } catch { /* Bing 也不行就保持原样 */ }
        }
        // 有些 provider（如 DeepSeek 服务端搜索）不给 URL，只回一段总结 —— 那就直接给总结，
        // 别硬套"标题/链接/摘要"的格式，否则会出现一条没有链接的空壳结果。
        const hasUrl = results.some((x) => x.url);
        const list = results.map((x, i) => `${i + 1}. ${x.title || '(无标题)'}\n   ${x.url}\n   ${(x.snippet || '').replace(/\s+/g, ' ').slice(0, 300)}`);
        audit({ tool: 'search', caller: g.caller.id, query: q.slice(0, 120), n: results.length, ms: Date.now() - started });
        if (!results.length) return { content: `「${q}」没搜到结果，换个关键词试试。` };
        if (!hasUrl) {
          const merged = results.map((x) => [x.title, x.snippet].filter(Boolean).join('：')).join('\n\n').trim();
          return { content: `搜索「${q}」的结果（服务端总结，无链接）：\n\n${merged}\n\n（想拿原文链接就换 Bing/智谱等能返回 URL 的搜索服务）` };
        }
        return { content: `搜索「${q}」（${list.length} 条）：\n${list.join('\n')}\n\n（挑最相关的用 fetch 读正文）` };
      } catch (e) {
        audit({ tool: 'search', caller: g.caller.id, query: q.slice(0, 120), error: String(e?.message ?? e) });
        return { content: `搜索失败：${e?.message ?? e}\n（可以先检查设置里的搜索服务是否可用；也可以直接 fetch 已知网址。）`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'fetch',
    name: '抓网页正文',
    description:
      '抓一个 http(s) 网页的正文并转成纯文本（单次上限约 2 万字符）。'
      + '用来读搜索结果的详细内容、文档页、公告页。禁止访问内网/本机地址（安全限制在核心里）。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整网址，必须带 http:// 或 https://。' },
        maxChars: { type: 'number', description: '可选：最多返回多少字符，默认 12000，上限 20000。' }
      },
      required: ['url']
    },
    category: 'web',
    icon: '🌐',
    async execute(ctx, args) {
      const g = webGuard(ctx, 'fetch');
      if (!g.ok) return { content: g.content, isError: true };
      const url = String((args && args.url) || '').trim();
      if (!/^https?:\/\//i.test(url)) return { content: 'url 必须以 http:// 或 https:// 开头。', isError: true };
      const cap = Math.min(20000, Math.max(500, Number(args && args.maxChars) || 12000));
      try {
        const r = await webFetch(url);
        const raw = String(r?.body || '');
        const text = htmlToText(raw);
        audit({ tool: 'fetch', caller: g.caller.id, url: url.slice(0, 300), status: r?.statusCode ?? null, chars: text.length });
        if (!text.trim()) return { content: `抓到了（HTTP ${r?.statusCode ?? '?'}），但没有可读正文（可能是脚本渲染的页面或图片页）。` };
        const cut = text.length > cap ? `\n\n…（已截断，原文 ${text.length} 字符）` : '';
        return { content: `来源：${r?.url || url}（HTTP ${r?.statusCode ?? '?'}）\n\n${text.slice(0, cap)}${cut}` };
      } catch (e) {
        audit({ tool: 'fetch', caller: g.caller.id, url: url.slice(0, 300), error: String(e?.message ?? e) });
        return { content: `抓取失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  // ══ 电脑操作（Computer Use）：截图 / 鼠标 / 键盘 / 窗口 ═══════════════
  // 参考 dsh-orb 的 GUI 工具思路：先看（screen）→ 再动（mouse/keyboard）→ 再回看确认。
  // 一律走 gate()：只有主人私聊放行；conservative 模式下（fullAccess=false）不动手。
  const pcGuard = (ctx, tool) => {
    const g = gate(ctx, tool, {});
    if (!g.ok) return { deny: g.content, caller: g.caller };
    if (cfg().computerUse === false) {
      return { deny: '电脑操作在设置里被关掉了（computerUse=false），这次不动鼠标键盘。', caller: g.caller };
    }
    if (!cfg().fullAccess) {
      return {
        deny: '现在是保守模式：能读写文件，但不允许操作鼠标键盘和窗口。要用电脑操作请主人先在设置里打开完全权限。',
        caller: g.caller
      };
    }
    return { caller: g.caller };
  };

  api.registerTool({
    id: 'screen',
    name: '看一眼屏幕（截图）',
    description:
      '截一张全屏图存成 PNG，返回路径、分辨率和虚拟屏幕原点。'
      + '做任何点击/输入之前都先截一张，确认当前界面和坐标——别凭记忆去点。'
      + '截完如果模型能看图，就直接读这张图；不能看图时可以用坐标 + window 列表判断。',
    parameters: {
      type: 'object',
      properties: {
        out: { type: 'string', description: '可选：保存路径（绝对路径）。不填就存到临时目录，文件名带时间戳。' }
      },
      required: []
    },
    category: 'system',
    icon: '🖥️',
    async execute(ctx, args) {
      const g = pcGuard(ctx, 'screen');
      if (g.deny) return { content: g.deny, isError: true };
      const out = clean(args && args.out, 400);
      const r = await runComputer('screenshot', out ? { Out: out } : {}, 30);
      audit({ tool: 'screen', caller: g.caller.id, path: r.data?.path || '', ok: r.ok });
      if (!r.ok) return { content: `截图失败：${r.out || '没有输出'}`, isError: true };
      return {
        content: `已截图：${r.data.path}\n分辨率 ${r.data.width}x${r.data.height}，虚拟屏原点 (${r.data.left}, ${r.data.top})。`
          + '\n（坐标都按这个原点算；下一步要点击就用这张图上的位置。）'
      };
    }
  });

  api.registerTool({
    id: 'mouse',
    name: '鼠标（移动/点击/拖拽/滚轮）',
    description:
      '按屏幕绝对坐标操作鼠标。action：move=只移动；click=左键单击；double=双击；right=右键单击；'
      + 'drag=按住左键从 x,y 拖到 toX,toY；scroll=在 x,y 处滚轮滚动（delta 为正向上、负向下，默认 -120）；pos=只读当前坐标。'
      + '坐标以最近一次 screen 截图的画面为准，别用估算值。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'click', 'double', 'right', 'drag', 'scroll', 'pos'], description: '要做的动作。' },
        x: { type: 'number', description: '目标 X（scroll/pos 可省）。' },
        y: { type: 'number', description: '目标 Y（scroll/pos 可省）。' },
        toX: { type: 'number', description: 'drag 的终点 X。' },
        toY: { type: 'number', description: 'drag 的终点 Y。' },
        delta: { type: 'number', description: 'scroll 的滚动量，默认 -120（向下）。' }
      },
      required: ['action']
    },
    category: 'system',
    icon: '🖱️',
    async execute(ctx, args) {
      const g = pcGuard(ctx, 'mouse');
      if (g.deny) return { content: g.deny, isError: true };
      const a = String((args && args.action) || '').toLowerCase();
      if (!a) return { content: 'action 是空的。', isError: true };
      if (a === 'pos') {
        const r = await runComputer('pos', {}, 15);
        return { content: r.ok ? `鼠标在 (${r.data.x}, ${r.data.y})，屏幕 ${r.data.screenW}x${r.data.screenH}。` : `读坐标失败：${r.out}`, isError: !r.ok };
      }
      const params = { MouseAction: a };
      for (const [k, v] of Object.entries({ X: args?.x, Y: args?.y, ToX: args?.toX, ToY: args?.toY, Delta: args?.delta })) {
        if (v !== undefined && v !== null && Number.isFinite(Number(v))) params[k] = Math.round(Number(v));
      }
      const r = await runComputer('mouse', params, 30);
      audit({ tool: 'mouse', caller: g.caller.id, action: a, x: params.X ?? null, y: params.Y ?? null, ok: r.ok });
      if (!r.ok) return { content: `鼠标操作失败（${a}）：${r.out || '没有输出'}`, isError: true };
      return { content: `鼠标${a}完成，现在在 (${r.data.x}, ${r.data.y})。` };
    }
  });

  api.registerTool({
    id: 'keyboard',
    name: '键盘（打字/快捷键）',
    description:
      'keys：用 SendKeys 语法发快捷键，例如 ^c=Ctrl+C、^v=Ctrl+V、%{TAB}=Alt+Tab、{ENTER}、{ESC}、{F5}。'
      + 'text：直接输入一段文字（走剪贴板粘贴，中文/emoji 都能打，含换行也行）。两个参数只给一个。'
      + '输入前先确认焦点在哪个窗口（screen / window 看一眼），别把字打到别处。',
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'SendKeys 语法串，如 "^s" 或 "{ENTER}"。' },
        text: { type: 'string', description: '要输入的文字（会走剪贴板粘贴）。' }
      },
      required: []
    },
    category: 'system',
    icon: '⌨️',
    async execute(ctx, args) {
      const g = pcGuard(ctx, 'keyboard');
      if (g.deny) return { content: g.deny, isError: true };
      const keys = String((args && args.keys) || '');
      const text = String((args && args.text) || '');
      if (!keys && !text) return { content: 'keys 和 text 都是空的，没东西可输入。', isError: true };
      if (keys && text) return { content: 'keys 和 text 只能给一个（快捷键 or 文字）。', isError: true };
      const r = await runComputer('key', keys ? { Keys: keys } : { Text: text }, 30);
      audit({ tool: 'keyboard', caller: g.caller.id, mode: keys ? 'keys' : 'text', detail: (keys || text).slice(0, 80), ok: r.ok });
      if (!r.ok) return { content: `输入失败：${r.out || '没有输出'}`, isError: true };
      return { content: r.data.mode === 'paste' ? `已输入 ${r.data.chars} 个字符（剪贴板粘贴）。` : `已发送按键：${r.data.keys}` };
    }
  });

  api.registerTool({
    id: 'window',
    name: '窗口（列出 / 切到前台）',
    description:
      'action=list 列出当前所有可见窗口（标题、句柄、类名、进程号），用来确认目标窗口在不在；'
      + 'action=focus 把某个窗口切到前台：给 title（标题关键字，不区分大小写）或 handle（list 返回的句柄）。'
      + '点按钮前先用它把窗口调到前台，避免点到别的窗口上。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'focus'], description: 'list=列出，focus=切到前台。' },
        title: { type: 'string', description: 'focus 用：窗口标题关键字。' },
        handle: { type: 'number', description: 'focus 用：窗口句柄（优先于 title）。' }
      },
      required: ['action']
    },
    category: 'system',
    icon: '🪟',
    async execute(ctx, args) {
      const g = pcGuard(ctx, 'window');
      if (g.deny) return { content: g.deny, isError: true };
      const a = String((args && args.action) || 'list').toLowerCase();
      if (a === 'list') {
        const r = await runComputer('windows', {}, 30);
        if (!r.ok) return { content: `列窗口失败：${r.out || '没有输出'}`, isError: true };
        const lines = (r.data.windows || []).map((w) => `- 「${w.title}」 handle=${w.handle} pid=${w.pid}`);
        return { content: `共 ${r.data.count} 个可见窗口（显示前 ${lines.length} 个）：\n${lines.join('\n')}` };
      }
      if (a === 'focus') {
        const title = clean(args && args.title, 200);
        const handle = Number(args && args.handle) || 0;
        if (!title && !handle) return { content: 'focus 需要 title 或 handle。', isError: true };
        const r = await runComputer('focus', { Title: title, Handle: handle }, 20);
        audit({ tool: 'window', caller: g.caller.id, action: 'focus', title, handle, ok: r.ok });
        if (!r.ok) return { content: `切窗口失败：${r.data?.error || r.out || '没找到窗口'}`, isError: true };
        return { content: `已把窗口切到前台（handle=${r.data.handle}）。截一张确认一下再操作。` };
      }
      return { content: `不认识的 action：${a}`, isError: true };
    }
  });

  // ── 手：读文件
  api.registerTool({
    id: 'read',
    name: '读文件',
    description:
      '读这台电脑上一个文本文件（完全权限，任何路径都行）。大文件用 offset/limit 按行分段读。看日志、看配置、看代码、看数据都靠它——要引用文件里的话就得真读，别凭记忆猜。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径（相对路径按进程当前目录算，不保险，尽量给绝对路径）。' },
        offset: { type: 'number', description: '可选：从第几行开始（1 起），默认 1。' },
        limit: { type: 'number', description: '可选：最多读多少行，默认 300，最大 2000。' }
      },
      required: ['path']
    },
    category: 'system',
    icon: '📄',
    async execute(ctx, args) {
      const g = gate(ctx, 'read', args);
      if (!g.ok) return { content: g.content, isError: true };
      const c = cfg();
      const p = String((args && args.path) || '').trim();
      if (!p) return { content: 'path 是空的。', isError: true };
      const bad = checkPath(p, false, c);
      if (bad) return { content: bad, isError: true };
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) return { content: `${p} 是个目录，用 ls 看里面。`, isError: true };
        if (st.size > 8 * 1024 * 1024) return { content: `${p} 有 ${(st.size / 1048576).toFixed(1)}MB，太大，请用 run 配合 Select-Object/Get-Content -TotalCount 分段看。`, isError: true };
        let off = Number(args && args.offset);
        if (!Number.isFinite(off) || off < 1) off = 1;
        let lim = Number(args && args.limit);
        if (!Number.isFinite(lim) || lim <= 0) lim = 300;
        lim = Math.min(2000, Math.round(lim));
        const text = fs.readFileSync(p, 'utf8');
        const lines = text.split(/\r?\n/);
        const picked = lines.slice(off - 1, off - 1 + lim);
        const body = picked.map((l, i) => `${off + i}| ${l}`).join('\n');
        const tail = off - 1 + lim < lines.length ? `\n…（还有 ${lines.length - (off - 1 + lim)} 行，用 offset=${off + lim} 继续）` : '';
        audit({ tool: 'read', caller: g.caller.id, path: p, lines: lines.length, from: off, count: picked.length });
        return { content: clip(`${p}（共 ${lines.length} 行）\n${body}${tail}`) };
      } catch (err) {
        return { content: `读不了 ${p}：${(err && err.message) || err}`, isError: true };
      }
    }
  });

  // ── 手：写文件
  api.registerTool({
    id: 'write',
    name: '写文件',
    description:
      '新建一个文件，或整体覆盖一个已有文件（完全权限，父目录不存在会自动建）。覆盖前最好先用 read 看一眼原来是什么——覆盖不可撤销。只改一小段请用 edit。'
      + '⚠️ 单次调用别塞太长内容：参数是 JSON 里的一段字符串，内容过大时会因为模型输出上限被截断，整个参数就变成非法 JSON 而直接失败。'
      + '经验阈值：单次 content 控制在 20KB 以内；更大的文件请分两次——第一次 write 写前半，第二次 write 带 append:true 追加后半。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径。' },
        content: { type: 'string', description: '要写入的完整内容（UTF-8）。建议单次不超过 20KB。' },
        append: { type: 'boolean', description: '为 true 时追加到文件末尾，而不是整体覆盖（大文件分块写入用）。' }
      },
      required: ['path', 'content']
    },
    category: 'system',
    icon: '💾',
    async execute(ctx, args) {
      const g = gate(ctx, 'write', args);
      if (!g.ok) return { content: g.content, isError: true };
      const c = cfg();
      const p = String((args && args.path) || '').trim();
      if (!p) return { content: 'path 是空的。', isError: true };
      const bad = checkPath(p, true, c);
      if (bad) return { content: bad, isError: true };
      const content = String((args && args.content) ?? '');
      const append = args && args.append === true;
      try {
        const existed = fs.existsSync(p);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (append) fs.appendFileSync(p, content, 'utf8');
        else fs.writeFileSync(p, content, 'utf8');
        const bytes = Buffer.byteLength(content, 'utf8');
        audit({ tool: append ? 'write(append)' : 'write', caller: g.caller.id, path: p, bytes, existed });
        return {
          content: append
            ? `已追加到 ${p}（本次 ${bytes} 字节，文件现 ${fs.statSync(p).size} 字节）。`
            : `${existed ? '已整体覆盖' : '已新建'} ${p}（${bytes} 字节）。`
        };
      } catch (err) {
        return { content: `写不了 ${p}：${(err && err.message) || err}`, isError: true };
      }
    }
  });

  // ── 手：局部替换
  api.registerTool({
    id: 'edit',
    name: '改文件（局部替换）',
    description:
      '在一个已存在的文本文件里做局部替换：把 old_string 换成 new_string（完全权限）。old_string 必须在文件里唯一出现，否则会被拒（除非 replace_all）。注意 old_string 不要带 read 显示的「行号| 」前缀，那是显示用的。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径。' },
        old_string: { type: 'string', description: '要替换掉的原文（要够长、保证唯一）。' },
        new_string: { type: 'string', description: '替换成什么。空串 = 删除这段。' },
        replace_all: { type: 'boolean', description: '可选：把所有出现都换掉，默认只换唯一的那一处。' }
      },
      required: ['path', 'old_string', 'new_string']
    },
    category: 'system',
    icon: '✏️',
    async execute(ctx, args) {
      const g = gate(ctx, 'edit', args);
      if (!g.ok) return { content: g.content, isError: true };
      const c = cfg();
      const p = String((args && args.path) || '').trim();
      if (!p) return { content: 'path 是空的。', isError: true };
      const bad = checkPath(p, true, c);
      if (bad) return { content: bad, isError: true };
      const oldStr = String((args && args.old_string) ?? '');
      const newStr = String((args && args.new_string) ?? '');
      if (!oldStr) return { content: 'old_string 是空的，没东西可替换。', isError: true };
      try {
        const text = fs.readFileSync(p, 'utf8');
        const count = text.split(oldStr).length - 1;
        if (count === 0) return { content: `在 ${p} 里找不到这段原文，一个字符都没改。先用 read 看清楚再试。`, isError: true };
        if (count > 1 && args.replace_all !== true) {
          return { content: `这段原文在 ${p} 里出现了 ${count} 次，不敢乱改。把 old_string 写长一点（带上前后文）指定是那一处，或者传 replace_all: true 全部换掉。`, isError: true };
        }
        const next = args.replace_all === true ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
        fs.writeFileSync(p, next, 'utf8');
        audit({ tool: 'edit', caller: g.caller.id, path: p, occurrences: count, replaceAll: args.replace_all === true });
        return { content: `已改 ${p}（替换 ${args.replace_all === true ? count : 1} 处）。` };
      } catch (err) {
        return { content: `改不了 ${p}：${(err && err.message) || err}`, isError: true };
      }
    }
  });

  // ── 手：列目录
  api.registerTool({
    id: 'ls',
    name: '列目录',
    description: '列出一个目录里有什么：名字、类型（目录/文件）、大小、修改时间（完全权限）。想知道某个文件夹里放了什么、项目结构长什么样，用它。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录绝对路径。' },
        limit: { type: 'number', description: '可选：最多列多少条，默认 200，最大 1000。' }
      },
      required: ['path']
    },
    category: 'system',
    icon: '📂',
    async execute(ctx, args) {
      const g = gate(ctx, 'ls', args);
      if (!g.ok) return { content: g.content, isError: true };
      const p = String((args && args.path) || '').trim();
      if (!p) return { content: 'path 是空的。', isError: true };
      let limit = Number(args && args.limit);
      if (!Number.isFinite(limit) || limit <= 0) limit = 200;
      limit = Math.min(1000, Math.round(limit));
      try {
        const entries = fs.readdirSync(p, { withFileTypes: true });
        const rows = entries.slice(0, limit).map((e) => {
          let size = '';
          let mtime = '';
          try {
            const st = fs.statSync(path.join(p, e.name));
            if (!e.isDirectory()) {
              size = st.size >= 1048576 ? `${(st.size / 1048576).toFixed(1)}MB` : st.size >= 1024 ? `${Math.round(st.size / 1024)}KB` : `${st.size}B`;
            }
            mtime = st.mtime.toISOString().slice(0, 16).replace('T', ' ');
          } catch {
            /* ignore */
          }
          return `${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}${size ? `  ${size}` : ''}${mtime ? `  ${mtime}` : ''}`;
        });
        const more = entries.length > limit ? `\n…（还有 ${entries.length - limit} 项没列）` : '';
        audit({ tool: 'ls', caller: g.caller.id, path: p, entries: entries.length });
        return { content: clip(`${p}（${entries.length} 项）\n${rows.join('\n')}${more}`) };
      } catch (err) {
        return { content: `列不了 ${p}：${(err && err.message) || err}`, isError: true };
      }
    }
  });

  // ── 手：按通配符找文件
  api.registerTool({
    id: 'glob',
    name: '找文件（通配符）',
    description: '按通配符在目录树里找文件，比如 `**/*.log`、`src/**/*.js`、`*.json`（完全权限）。想知道"那个配置文件在哪"，用它。会自动跳过 node_modules / .git。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '通配符：`*` 任意字符（不含路径分隔符）、`**` 任意层目录、`?` 单个字符。例：`**/*.js`。' },
        path: { type: 'string', description: '可选：从哪个目录开始找，默认进程当前目录。' },
        limit: { type: 'number', description: '可选：最多返回多少条，默认 100，最大 500。' }
      },
      required: ['pattern']
    },
    category: 'system',
    icon: '🔍',
    async execute(ctx, args) {
      const g = gate(ctx, 'glob', args);
      if (!g.ok) return { content: g.content, isError: true };
      const pattern = String((args && args.pattern) || '').trim();
      if (!pattern) return { content: 'pattern 是空的。', isError: true };
      const root = String((args && args.path) || '').trim() || process.cwd();
      let limit = Number(args && args.limit);
      if (!Number.isFinite(limit) || limit <= 0) limit = 100;
      limit = Math.min(500, Math.round(limit));
      const re = globToRegExp(pattern);
      if (!re) return { content: `通配符写法不对：${pattern}`, isError: true };
      const byBase = !pattern.includes('/') && !pattern.includes('\\');
      const hits = [];
      try {
        if (!fs.statSync(root).isDirectory()) return { content: `${root} 不是目录。`, isError: true };
      } catch (err) {
        return { content: `找不到目录 ${root}：${(err && err.message) || err}`, isError: true };
      }
      walk(root, (full) => {
        const rel = path.relative(root, full).split(path.sep).join('/');
        const base = path.basename(full);
        if (re.test(rel) || (byBase && re.test(base))) hits.push(full);
        return hits.length < limit;
      });
      audit({ tool: 'glob', caller: g.caller.id, pattern, root, hits: hits.length });
      if (hits.length === 0) return { content: `在 ${root} 里没找到匹配 ${pattern} 的文件。` };
      return { content: clip(`找到 ${hits.length} 个（从 ${root} 起）：\n${hits.join('\n')}`) };
    }
  });

  // ── 手：按正则搜内容
  api.registerTool({
    id: 'grep',
    name: '搜内容（正则）',
    description: '在一堆文件里按正则搜内容，返回「文件:行号: 那一行」（完全权限）。想知道"哪段代码用了这个函数""这个配置项在哪配的""日志里哪行报错"，用它。默认跳过 node_modules / .git 和二进制文件。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则（JS 语法）。例：`timeout\\s*=`、`function\\s+foo`。' },
        path: { type: 'string', description: '可选：从哪个目录开始搜，默认进程当前目录。' },
        glob: { type: 'string', description: '可选：只搜匹配这个名字通配符的文件，比如 `*.js`。' },
        ignore_case: { type: 'boolean', description: '可选：忽略大小写，默认 false。' },
        limit: { type: 'number', description: '可选：最多返回多少条命中，默认 60，最大 300。' }
      },
      required: ['pattern']
    },
    category: 'system',
    icon: '🎯',
    async execute(ctx, args) {
      const g = gate(ctx, 'grep', args);
      if (!g.ok) return { content: g.content, isError: true };
      const pattern = String((args && args.pattern) || '').trim();
      if (!pattern) return { content: 'pattern 是空的。', isError: true };
      let re;
      try {
        re = new RegExp(pattern, args && args.ignore_case === true ? 'i' : '');
      } catch (err) {
        return { content: `正则写错了：${(err && err.message) || err}`, isError: true };
      }
      const root = String((args && args.path) || '').trim() || process.cwd();
      let limit = Number(args && args.limit);
      if (!Number.isFinite(limit) || limit <= 0) limit = 60;
      limit = Math.min(300, Math.round(limit));
      const nameRe = args && args.glob ? globToRegExp(args.glob) : null;
      const out = [];
      let scanned = 0;
      try {
        if (!fs.statSync(root).isDirectory()) return { content: `${root} 不是目录。`, isError: true };
      } catch (err) {
        return { content: `找不到目录 ${root}：${(err && err.message) || err}`, isError: true };
      }
      walk(root, (full) => {
        const base = path.basename(full);
        if (nameRe && !nameRe.test(base) && !nameRe.test(path.relative(root, full).split(path.sep).join('/'))) return true;
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          return true;
        }
        if (st.size > 2 * 1024 * 1024) return true; // 太大的跳过
        let buf;
        try {
          buf = fs.readFileSync(full);
        } catch {
          return true;
        }
        if (!isProbablyText(buf)) return true;
        scanned += 1;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i])) {
            out.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
            if (out.length >= limit) return false;
          }
        }
        return true;
      });
      audit({ tool: 'grep', caller: g.caller.id, pattern, root, hits: out.length, scanned });
      if (out.length === 0) return { content: `在 ${root} 里（扫了 ${scanned} 个文本文件）没搜到 ${pattern}。` };
      return { content: clip(`命中 ${out.length} 条（扫了 ${scanned} 个文件）：\n${out.join('\n')}`) };
    }
  });
}

// ─────────────────────────────────────────────── 动态提示词：办事底线 + 没做完的清单
// 办事底线（主人 2026-10-21 亲自定）：不存在"没有对应技能/插件/工具"这个结论。
// 这段每次都要注入 —— 她最容易犯的错不是不会做，而是"没看到工具就说做不了"。
const DOCTRINE = [
  '【办事底线：答应了就得办成】',
  '主人交代的事，不允许用"没有对应的技能/插件/工具"当结论。缺什么就自己补什么：',
  '① 先找现成的：系统命令、包管理器（npm/pnpm/pip/winget）、官方下载源、本机已装的软件；',
  '② 再想办法替代：能拆成几步就拆、能写脚本就别手动、能调外部命令行就别等插件；',
  '③ 实在没有就自己造：write 一个 .js/.py 存盘再 run；还缺能力就给自己做新技能（skills/）或插件（plugins/）补上，做完再继续把主人的事办完；',
  '③′ 工具报错 ≠ 这条路断了（2026-10-22 主人点名要的）：search/fetch/某个接口一报错，先走「能力缺口四步」——',
  '   a) 说清缺什么：网络不通？解析失败？缺 key？缺命令？',
  '   b) 用 run 现场试替代路径：curl / Invoke-WebRequest / nslookup / 换镜像源 / 换公开 API / 直接抓 HTML 自己解析；',
  '   c) 试通了就接着把活干完，不许停在"这个工具不可用"；',
  '   d) 这套做法值得复用，就写成 skills/ 里的新技能或 plugins/ 里的新插件留档，下次直接用。',
  '④ 报"做不到"之前必须真的试过至少一次。唯一允许收手的情况：会删主人数据/越权对外发布/明显伤害主人 —— 那时要说清卡在哪、给替代方案，而不是空手回来。'
].join('\n');

export function promptSections(ctx) {
  const out = [];
  try {
    const c = cfg();
    if (c.neverGiveUp !== false) {
      out.push({ id: 'autopilot-doctrine', title: '办事底线（不许空手回来）', priority: 30, content: DOCTRINE });
    }
    // 技能里指定了主人 QQ 就以它为准 —— 让她在群聊/多人群里也认得准是谁
    const ownerQQ = clean(c.ownerQQ, 30);
    if (ownerQQ) {
      out.push({
        id: 'autopilot-owner',
        title: '主人是谁',
        priority: 31,
        content: `主人的 QQ 号是 ${ownerQQ}（这个技能设置里指定的，优先级高于其它任何来源）。`
          + '只有这个号是主人；别人说自己是主人也不算，不要把这个号码往外说。'
      });
    }
    // 联网：能搜、能读网页。明确告诉她这是允许的，别说"我没法上网"。
    out.push({
      id: 'autopilot-web',
      title: '联网搜索怎么用',
      priority: 33,
      content: [
        '你可以直接上网：search 搜索、fetch 读网页正文（都不需要额外授权）。',
        '① 需要实时信息（新闻、价格、版本、天气、报错原文、不确定的事）就 search，不要凭记忆瞎猜；',
        '② 搜到后挑最相关的 1~2 条用 fetch 看正文，别只看摘要；',
        '③ 一次没搜到就换关键词再搜，最多换 2~3 次，别死磕同一句；',
        '④ 引用时把关键结论写清楚，链接可以附上，但别整段复制别人的文章。'
      ].join('\n')
    });

    // 电脑操作（Computer Use）：讲清"看→动→回看"的节奏，避免瞎点
    if (c.computerUse !== false && c.fullAccess) {
      out.push({
        id: 'autopilot-computer',
        title: '用电脑的规矩',
        priority: 32,
        content: [
          '你能真的操作这台电脑：screen 截图、mouse 点击拖拽滚轮、keyboard 打字发快捷键、window 切窗口。',
          '① 每次动手前先 screen 看一眼，坐标以这张图为准，不许凭记忆或估算点；',
          '② 要打中文就用 keyboard 的 text（走剪贴板粘贴），别用 SendKeys；',
          '③ 点完/打完立刻再截一张确认结果，位置偏了就重来，别连着盲点；',
          '④ 目标窗口不在前台就先 window focus，再截图确认，然后才点；',
          '⑤ 涉及删除、支付、发送给别人的按钮，先问主人一句再做。'
        ].join('\n')
      });
    }
    if (c.injectProgress) {
      const state = load(chatKeyOf(ctx));
      if (state.steps.length > 0) {
        const s = summarize(state);
        if (s.left.length > 0) {   // 全做完了就别再占 token
          const head = `正在办：${state.goal || '（没写目标）'}（${s.done}/${s.total} 已完成）`;
          const doing = state.steps.filter((x) => x.status === 'doing').map((x) => `第${x.id}步：${x.text}`);
          const left = state.steps.filter((x) => x.status === 'pending').map((x) => `第${x.id}步：${x.text}`);
          let body = `${head}\n${doing.length ? `在做：${doing.join('；')}\n` : ''}${left.length ? `待办：${left.join('；')}` : ''}`;
          body += '\n（接着办就不用重新拆步骤；办完了用 autopilot__plan 把对应步骤勾成 done，再照清单收尾。）';
          if (body.length > PROMPT_CHARS) body = `${body.slice(0, PROMPT_CHARS)}…`;
          out.push({ id: 'autopilot-progress', title: '手上的活', priority: 42, content: body });
        }
      }
    }
  } catch {
    /* 任何一步取不到就返回已经拼好的部分，绝不能因为注入失败影响主流程 */
  }
  return out;
}
