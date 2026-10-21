/**
 * localchat-kit —— 本地聊天安装包（把补丁写进宿主代码的"自安装"技能）
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么会有这个技能：
 *   「本地聊天」那套改动落在核心代码里（src/app.js、sender.js、routes.js、prompt.js、
 *   orchestrator.js、store.js + ui/ 三个文件），插件系统碰不到它们，所以**没法打包发布**。
 *   解法是把改动做成数据（patches.json 里一条条 {find, replace}），让技能带着数据跑，
 *   由她自己（用 write/run 的能力）把补丁应用进安装目录 —— 这样整包就能一起发了。
 *
 * 三条安全线：
 *   ① 改之前先把原文件整份备份到 <DATA_DIR>/localchat-kit-backup/<时间戳>/；
 *   ② 每条补丁必须"在目标文件里唯一命中"，否则整次安装中止（绝不猜位置瞎改）；
 *   ③ 已有 replace 原文 = 视为已安装（幂等，重复装不会叠加）；两者都不匹配 = 版本不对，报错不动手。
 *
 * 装完必须重启 QQ Agent（核心模块是启动时加载的）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCH_FILE = path.join(HERE, 'patches.json');

let log = () => {};
let settingsOf = () => ({});

function loadPatches() {
  return JSON.parse(fs.readFileSync(PATCH_FILE, 'utf8'));
}

/** 安装目录：设置优先，其次按本技能位置往上推两层（<app>/skills/localchat-kit）。 */
function appRootOf() {
  const s = settingsOf() || {};
  const custom = String(s.appDir || '').trim();
  if (custom) return path.resolve(custom);
  return path.resolve(HERE, '..', '..');
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function backupRoot() {
  // 与宿主同源的数据目录：从 config.js 取，取不到就退回安装目录旁的 data
  let dataDir = '';
  try {
    const url = new URL('../../src/config.js', import.meta.url);
    // 同步拿不到 ESM 导出，这里用常见路径兜底
    dataDir = path.resolve(appRootOf(), 'data');
  } catch { /* ignore */ }
  return path.join(dataDir || path.resolve(appRootOf(), 'data'), 'localchat-kit-backup');
}

/** 判断某个文件当前的补丁状态：done / pending / mismatch */
function statusOf(file, content) {
  if (file.create) return content === null ? 'pending' : 'done';
  if (content === null) return 'missing';
  const norm = content.split('\r\n').join('\n');
  let applied = 0;
  for (const h of file.hunks) {
    const hasNew = norm.includes(h.replace);
    const hasOld = norm.includes(h.find);
    if (hasNew) applied++;
    else if (!hasOld) return 'mismatch';
  }
  return applied === file.hunks.length ? 'done' : 'pending';
}

function collectStatus(root) {
  const data = loadPatches();
  const rows = [];
  for (const f of data.files) {
    const abs = path.join(root, f.file);
    const exists = fs.existsSync(abs);
    const content = exists ? fs.readFileSync(abs, 'utf8') : null;
    rows.push({ file: f.file, exists, status: statusOf(f, content), hunks: f.hunks ? f.hunks.length : 1 });
  }
  return rows;
}

export function setup(api) {
  log = api?.log || (() => {});
  settingsOf = () => (typeof api?.config === 'function' ? api.config() : {});
  if (!fs.existsSync(PATCH_FILE)) {
    log('补丁数据缺失：patches.json 不在技能目录里，本技能不可用');
    return;
  }
  const data = loadPatches();
  log(`本地聊天安装包 已加载：${data.files.length} 个文件、` +
    `${data.files.reduce((n, f) => n + (f.hunks ? f.hunks.length : 1), 0)} 条补丁（${data.generatedAt || '?'}）`);

  api.registerTool({
    id: 'localchat_status',
    name: '本地聊天：查看安装状态',
    description: '检查「本地聊天」补丁在安装目录里装没装、装到一半还是版本不匹配。装之前/装之后都用它确认，别凭感觉。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    async execute() {
      const root = appRootOf();
      if (!fs.existsSync(path.join(root, 'src', 'app.js'))) {
        return { content: `这里不像 QQ Agent 安装目录：${root}\n（找不到 src/app.js。请在技能设置里填 appDir。）`, isError: true };
      }
      const rows = collectStatus(root);
      const done = rows.filter((r) => r.status === 'done').length;
      const lines = rows.map((r) => `· ${r.file} — ${r.status}${r.status === 'done' ? '' : `（${r.hunks} 段）`}`);
      return {
        content: `安装目录：${root}\n进度：${done}/${rows.length} 个文件已就绪\n${lines.join('\n')}\n`
          + (done === rows.length ? '✅ 已全部安装（重启过就是生效状态）' : '➡️ 还没装齐，可以用 localchat_install')
      };
    }
  });

  api.registerTool({
    id: 'localchat_install',
    name: '本地聊天：安装（写进宿主代码）',
    description:
      '把「本地聊天」补丁应用进 QQ Agent 安装目录：逐条按"唯一命中"匹配，改之前先整份备份原文件。'
      + '幂等：已经装过的会跳过；版本对不上（找不到锚点）会整次中止，绝不乱改。装完必须重启 QQ Agent。',
    parameters: {
      type: 'object',
      properties: {
        appDir: { type: 'string', description: '可选：手动指定安装目录（不填就用技能设置 / 自动推断）。' }
      },
      required: []
    },
    category: 'system',
    async execute(ctx, args) {
      const root = (args && args.appDir && String(args.appDir).trim())
        ? path.resolve(String(args.appDir).trim())
        : appRootOf();
      if (!fs.existsSync(path.join(root, 'src', 'app.js'))) {
        return { content: `这里不像 QQ Agent 安装目录：${root}（找不到 src/app.js）`, isError: true };
      }

      const data = loadPatches();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bdir = path.join(backupRoot(), stamp);
      const changed = [];
      const skipped = [];

      // 先全量体检：任何一处 mismatch 就整体不动手（半装状态最难排查）
      const plan = [];
      for (const f of data.files) {
        const abs = path.join(root, f.file);
        const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
        const st = statusOf(f, cur);
        if (st === 'done') { skipped.push(f.file); continue; }
        if (st === 'mismatch') {
          return {
            content: `中止：${f.file} 的现状和补丁对不上（可能是别的版本，或已被改过）。\n`
              + '没有动任何文件。请先把这一项核对清楚，或换对应版本的补丁包。',
            isError: true
          };
        }
        plan.push({ f, abs, cur });
      }
      if (!plan.length) {
        return { content: `已经是安装状态，无需重复安装。\n（${skipped.length} 个文件都就绪；重启过即生效。）` };
      }

      // 备份 → 应用
      for (const item of plan) {
        const { f, abs, cur } = item;
        const bak = path.join(bdir, f.file);
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        if (cur !== null) fs.writeFileSync(bak, cur, 'utf8');
        else fs.writeFileSync(path.join(bdir, '.new-files.txt'), `${f.file}\n`, { flag: 'a' });

        if (f.create) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, f.content, 'utf8');
          changed.push(`${f.file}（新建）`);
          continue;
        }

        const eol = detectEol(cur);
        let text = cur.split('\r\n').join('\n');
        for (const h of f.hunks) {
          if (text.includes(h.replace)) continue;      // 幂等：这段已经是新内容
          if (!text.includes(h.find)) throw new Error(`${f.file} 补丁锚点消失，已中止`);
          text = text.replace(h.find, h.replace);
        }
        fs.writeFileSync(abs, eol === '\r\n' ? text.split('\n').join('\r\n') : text, 'utf8');
        changed.push(f.file);
      }

      log(`本地聊天已安装：${changed.length} 个文件（备份 ${bdir}）`);
      return {
        content: `已安装（${changed.length} 个文件）：\n${changed.map((x) => '· ' + x).join('\n')}\n`
          + (skipped.length ? `\n跳过（本来就就绪）：${skipped.join('、')}\n` : '')
          + `\n备份目录：${bdir}\n⚠️ 必须重启 QQ Agent 才生效（核心模块在启动时加载）。`
      };
    }
  });

  api.registerTool({
    id: 'localchat_uninstall',
    name: '本地聊天：还原（用备份覆盖回去）',
    description: '把最近一次安装前的备份覆盖回原文件，等于撤销。只认本技能自己建的备份目录，不碰别的东西。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    async execute() {
      const root = appRootOf();
      const base = backupRoot();
      if (!fs.existsSync(base)) return { content: '没有找到任何备份，可能从未安装过。', isError: true };
      const stamps = fs.readdirSync(base).filter((n) => fs.statSync(path.join(base, n)).isDirectory()).sort();
      if (!stamps.length) return { content: '备份目录是空的，没东西可还原。', isError: true };
      const latest = stamps[stamps.length - 1];
      const dir = path.join(base, latest);
      let restored = [];
      // 删除"当初是新建"的文件
      const newListFile = path.join(dir, '.new-files.txt');
      if (fs.existsSync(newListFile)) {
        for (const rel of fs.readFileSync(newListFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)) {
          const abs = path.join(root, rel);
          try { if (fs.existsSync(abs)) { fs.unlinkSync(abs); restored.push(`${rel}（已删除，原本不存在）`); } } catch { /* ignore */ }
        }
      }
      const walk = (d, rel = '') => {
        for (const n of fs.readdirSync(d)) {
          if (n === '.new-files.txt') continue;
          const fp = path.join(d, n);
          const r2 = rel ? rel + '/' + n : n;
          if (fs.statSync(fp).isDirectory()) walk(fp, r2);
          else {
            const dest = path.join(root, r2);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(fp, dest);
            restored.push(r2);
          }
        }
      };
      walk(dir);
      log(`本地聊天已还原：${restored.length} 项（来自备份 ${latest}）`);
      return { content: `已还原（备份 ${latest}）：\n${restored.map((x) => '· ' + x).join('\n')}\n⚠️ 重启 QQ Agent 后恢复成安装前的样子。` };
    }
  });
}

export function dispose() { /* 无定时器/监听器 */ }
