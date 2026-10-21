/**
 * hide-clear-archive —— 隐藏「清空存档」按钮（确定性型 / plugins/）
 * ═══════════════════════════════════════════════════════════════════════════
 * 治什么：存档页右上角那颗「清空存档」一点就把整段对话删了、还不可恢复。
 *         手滑一次就没了，所以干脆把它藏起来。
 *
 * 为什么必须"自带界面"：
 *   宿主的插件 API 只有 registerTool / providers / hooks / runAction，
 *   **没有前端钩子**（官方 theme-installer 文件头原话："插件碰不到页面 DOM"）。
 *   所以走和 ext-remover、theme-installer 完全同一条路：
 *     ① 把 host/hide-clear-archive.js 复制进 ui/
 *     ② 在 ui/index.html 的 </head> 前插一个带标记的 <script defer> 块
 *     ③ 关掉插件时按标记精确摘除（不猜行、不动别人的代码）
 *
 * 为什么是 display:none 而不是删元素：
 *   ui/app/04-archive-usage.js 渲染完详情后会 `$('#chat-clear-btn').addEventListener(...)`。
 *   把元素删掉 → 那行直接 null.addEventListener 抛错，整页渲染中断（比按钮还在更糟）。
 *   所以只隐藏，保留 DOM 与事件绑定。
 *
 * 恢复：关掉插件即可（deactivate 会摘掉 index.html 里的块并删掉 ui/ 里的脚本）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(PLUGIN_DIR, '..', '..');
const UI_DIR = path.resolve(APP_ROOT, 'ui');
const UI_INDEX = path.join(UI_DIR, 'index.html');

const HOST_SRC = path.join(PLUGIN_DIR, 'host', 'hide-clear-archive.js');
const HOST_NAME = 'hide-clear-archive.js';
const HOST_DEST = path.join(UI_DIR, HOST_NAME);
const HOST_URL = `/${HOST_NAME}`;

const MARK_BEGIN = '<!-- hide-clear-archive:begin（由「隐藏清空存档」插件安装；关掉插件会精确删掉这一段） -->';
const MARK_END = '<!-- hide-clear-archive:end -->';

let log = () => {};

/** 摘掉标记块（含其中所有行）。返回 { html, removed }。 */
function stripBlock(html) {
  const lines = String(html).split(/\r?\n/);
  const out = [];
  let inBlock = false;
  let removed = false;
  for (const line of lines) {
    const t = line.trim();
    if (!inBlock && t.startsWith('<!-- hide-clear-archive:begin')) { inBlock = true; removed = true; continue; }
    if (inBlock) {
      if (t.startsWith('<!-- hide-clear-archive:end')) inBlock = false;
      continue;
    }
    out.push(line);
  }
  return { html: out.join('\n'), removed };
}

function installUi() {
  if (!fs.existsSync(UI_INDEX)) throw new Error(`找不到控制台页面：${UI_INDEX}`);
  if (!fs.existsSync(HOST_SRC)) throw new Error('插件包不完整：host/hide-clear-archive.js 缺失');

  fs.writeFileSync(HOST_DEST, fs.readFileSync(HOST_SRC, 'utf8'), 'utf8');

  const original = fs.readFileSync(UI_INDEX, 'utf8');
  const stripped = stripBlock(original);
  if (!stripped.html.includes('</head>')) {
    throw new Error('ui/index.html 里找不到 </head>，不敢动它（怕把控制台页面弄坏）');
  }
  const block = `${MARK_BEGIN}\n<script defer src="${HOST_URL}"></script>\n${MARK_END}`;
  const next = stripped.html.replace('</head>', `${block}\n</head>`);
  if (next !== original) fs.writeFileSync(UI_INDEX, next, 'utf8');
  log('已挂进控制台（刷新页面后生效）');
}

function uninstallUi() {
  let changed = false;
  try {
    if (fs.existsSync(UI_INDEX)) {
      const r = stripBlock(fs.readFileSync(UI_INDEX, 'utf8'));
      if (r.removed) { fs.writeFileSync(UI_INDEX, r.html, 'utf8'); changed = true; }
    }
  } catch (e) { log(`摘除 index.html 标记失败：${e?.message ?? e}`); }
  try { if (fs.existsSync(HOST_DEST)) { fs.unlinkSync(HOST_DEST); changed = true; } } catch (e) { log(`删除注入脚本失败：${e?.message ?? e}`); }
  if (changed) log('已从控制台摘除「清空存档」按钮的隐藏逻辑');
  return changed;
}

export function setup(api) {
  log = api?.log || (() => {});
  log('隐藏清空存档：已加载（存档页的「清空存档」按钮会被藏起来）');
}

/** 自检必须是同步的：宿主用它的返回值判断插件可用不可用。 */
export function available() {
  try {
    if (!fs.existsSync(UI_INDEX)) return { ok: false, reason: '找不到 ui/index.html，没法改控制台页面' };
    if (!fs.existsSync(HOST_SRC)) return { ok: false, reason: '插件包不完整：host/hide-clear-archive.js 缺失' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `自检失败：${e?.message ?? e}` };
  }
}

export async function activate() {
  try { installUi(); } catch (e) { log(`安装失败：${e?.message ?? e}`); }
}

export async function deactivate() {
  try { uninstallUi(); } catch (e) { log(`卸载失败：${e?.message ?? e}`); }
}

export function dispose() { /* 没有定时器/监听器要清，界面由 deactivate 负责摘除 */ }
