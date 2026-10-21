/**
 * chat-archive-sync —— 聊天记录发布 / 读取（确定性型 / plugins/）
 * ═══════════════════════════════════════════════════════════════════════════
 * 主人说「发布」→ 把指定存档传出去；说「读取」→ 把远端那份拉回来**覆盖**本地存档。
 *
 * 目标端（两种，按设置自动选）：
 *   · 填了 token + repo → GitHub（Contents API，PUT/GET）
 *   · 没填 → **本机目录**（默认 <DATA_DIR>/archive-sync/），完全离线
 *
 * 为什么不混淆存档：
 *   文件名 = chatKey 的转义形式（private_123.json / group_456.json / local_console.json），
 *   私聊 123 与群 123 天然是两个文件。取档时若"123"同时匹配到私聊和群 → **拒绝执行**并让
 *   主人补明确前缀，绝不猜。
 *
 * 为什么读写都走宿主自己的 HTTP 接口，而不是直接改 data/messages/*.json：
 *   存档在内存里有缓存（ChatStore.chats）。偷偷改文件 → 内存还是旧的，下一次保存就把
 *   刚读回来的覆盖回去。所以导入必须经 /api/archives/import 走到 store，磁盘与内存同改。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from '../../src/config.js';

const ID = 'chat-archive-sync';

let log = () => {};
let readConfig = () => ({});

/* ── 配置 & 目标解析 ─────────────────────────────────────────────── */

function cfg() {
  let c = {};
  try { c = readConfig() || {}; } catch { c = {}; }
  const d = { token: '', repo: '', branch: 'main', pathPrefix: 'archives', localDir: '', includeSelf: true, ...c };
  d.token = String(d.token || '').trim();
  d.repo = String(d.repo || '').trim();
  d.branch = String(d.branch || 'main').trim() || 'main';
  d.pathPrefix = String(d.pathPrefix || '').trim().replace(/^\/+|\/+$/g, '');
  return d;
}

function useGitHub(c) {
  return Boolean(c.token && /^[\w.-]+\/[\w.-]+$/.test(c.repo));
}

function hostBase() {
  let port = 3210;
  let token = '';
  try {
    const c = getConfig();
    port = Number(c?.server?.port) || port;
    token = String(c?.server?.token || '');
  } catch { /* 走默认端口 */ }
  return { base: `http://127.0.0.1:${port}`, token };
}

async function hostApi(p, options = {}) {
  const { base, token } = hostBase();
  const res = await fetch(base + p, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}), ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/* ── 存档选择：把主人说的"那个存档"解析成唯一 chatKey ────────────── */

function safeName(chatKey) {
  return String(chatKey).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '.json';
}

async function listArchives() {
  const { archives } = await hostApi('/api/archives');
  return archives || [];
}

async function resolveArchive(query) {
  const q = String(query || '').trim();
  const all = await listArchives();
  if (!q) {
    return { error: '没说发布哪一段。请先告诉我存档（群号 / QQ 号 / 群名），可选：\n' + all.slice(0, 20).map((a) => `· ${a.chatKey}${a.chatName ? '（' + a.chatName + '）' : ''} ${a.total} 条`).join('\n') };
  }
  // ① 完整 chatKey
  if (/^(private|group|local):/.test(q)) {
    const hit = all.find((a) => a.chatKey === q);
    return hit ? { archive: hit } : { error: `找不到存档 ${q}` };
  }
  // ② 纯数字：私聊和群可能同时存在 → 有歧义就拒绝，绝不猜
  if (/^\d+$/.test(q)) {
    const p = all.find((a) => a.chatKey === `private:${q}`);
    const g = all.find((a) => a.chatKey === `group:${q}`);
    if (p && g) return { error: `${q} 同时是私聊和群：请写成 private:${q} 或 group:${q}` };
    const hit = p || g;
    return hit ? { archive: hit } : { error: `找不到 ${q} 的存档（既没有 private:${q} 也没有 group:${q}）` };
  }
  // ③ 按名字模糊匹配
  const hits = all.filter((a) => a.chatName && a.chatName.includes(q));
  if (hits.length === 1) return { archive: hits[0] };
  if (hits.length > 1) return { error: `「${q}」匹配到多个存档，请指定 chatKey：\n` + hits.map((a) => `· ${a.chatKey}（${a.chatName}）`).join('\n') };
  return { error: `没有名字里带「${q}」的存档。可用：\n` + all.slice(0, 20).map((a) => `· ${a.chatKey}${a.chatName ? '（' + a.chatName + '）' : ''}`).join('\n') };
}

/* ── 两端实现：本地目录 / GitHub ─────────────────────────────────── */

function localDirOf(c) {
  // 没填就用数据目录下默认位置 —— 也就是「不填内容默认发布到本机目录」这条要求
  return c.localDir ? path.resolve(String(c.localDir)) : path.join(DATA_DIR, 'archive-sync');
}

function localPath(c, chatKey) {
  return path.join(localDirOf(c), safeName(chatKey));
}

function ghPath(c, chatKey) {
  return [c.pathPrefix, safeName(chatKey)].filter(Boolean).join('/');
}

async function ghGet(c, chatKey) {
  const p = ghPath(c, chatKey);
  const res = await fetch(`https://api.github.com/repos/${c.repo}/contents/${encodeURI(p)}?ref=${encodeURIComponent(c.branch)}`, {
    headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'qq-agent-chat-archive-sync' }
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `GitHub 读取失败 HTTP ${res.status}`);
  const text = Buffer.from(String(data.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
  return { sha: data.sha, data: JSON.parse(text) };
}

async function ghPut(c, chatKey, payload, note) {
  const p = ghPath(c, chatKey);
  const url = `https://api.github.com/repos/${c.repo}/contents/${encodeURI(p)}`;
  const existing = await ghGet(c, chatKey).catch(() => null);
  const body = {
    message: note || `archive: ${chatKey} @ ${new Date().toISOString()}`,
    content: Buffer.from(JSON.stringify(payload, null, 1), 'utf8').toString('base64'),
    branch: c.branch,
    ...(existing?.sha ? { sha: existing.sha } : {})
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'content-type': 'application/json', 'User-Agent': 'qq-agent-chat-archive-sync' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `GitHub 写入失败 HTTP ${res.status}`);
  return { url: data?.content?.html_url || '', replaced: Boolean(existing?.sha) };
}

/* ── 工具 ────────────────────────────────────────────────────────── */

export function setup(api) {
  log = api?.log || (() => {});
  readConfig = () => (typeof api?.config === 'function' ? api.config() : {});

  api.registerTool({
    id: 'archive_list',
    name: '列出可发布的存档',
    description: '列出本机所有「存档」（会话）的 chatKey、名称、消息条数。主人说"发布聊天记录"但没说哪一段时，先用它列出来让他选。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'utility',
    async execute() {
      const all = await listArchives();
      if (!all.length) return { content: '现在还没有任何存档。' };
      const c = cfg();
      const target = useGitHub(c) ? `GitHub: ${c.repo}@${c.branch}/${c.pathPrefix || '.'}` : `本地目录: ${c.localDir || '<数据目录>/archive-sync'}`;
      const lines = all.slice(0, 40).map((a) => `· ${a.chatKey}${a.chatName ? '（' + a.chatName + '）' : ''} — ${a.total} 条`);
      return { content: `目标端：${target}\n可用存档（${all.length} 个）：\n${lines.join('\n')}` };
    }
  });

  api.registerTool({
    id: 'archive_publish',
    name: '发布聊天记录',
    description:
      '把**指定那一个**存档的聊天记录发布出去（主人说"发布"时调用）。archive 传 chatKey（private:123 / group:456）'
      + '或群号/QQ 号/群名关键字；有歧义会被拒绝并要求写明确前缀。配置了 token+repo 就传 GitHub，没配就写到本机目录（默认数据目录下的 archive-sync）。'
      + '每段存档一个文件，不同存档互不覆盖。',
    parameters: {
      type: 'object',
      properties: {
        archive: { type: 'string', description: '要发布的存档：chatKey 或群号/QQ号/群名关键字。' },
        note: { type: 'string', description: '可选：本次提交说明（GitHub commit message）。' }
      },
      required: ['archive']
    },
    category: 'utility',
    async execute(ctx, args) {
      const c = cfg();
      const r = await resolveArchive(args?.archive);
      if (r.error) return { content: r.error, isError: true };
      const { archive } = r;
      const exported = await hostApi(`/api/archives/export?chatKey=${encodeURIComponent(archive.chatKey)}`);
      let messages = exported.messages || [];
      if (c.includeSelf === false) messages = messages.filter((m) => !m.self);
      const payload = {
        chatKey: archive.chatKey,
        chatName: archive.chatName || '',
        count: messages.length,
        exportedAt: new Date().toISOString(),
        source: 'qq-agent',
        messages
      };
      try {
        if (useGitHub(c)) {
          const w = await ghPut(c, archive.chatKey, payload, args?.note);
          log(`[${ID}] 已发布 ${archive.chatKey} → ${c.repo}/${ghPath(c, archive.chatKey)}`);
          return { content: `已发布「${archive.chatKey}」（${messages.length} 条）到 GitHub${w.replaced ? '（覆盖旧文件）' : '（新建文件）'}。\n${w.url}` };
        }
        const target = localPath(c, archive.chatKey);
        if (!target) throw new Error('没配置本地目录');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(payload, null, 1), 'utf8');
        log(`[${ID}] 已发布 ${archive.chatKey} → ${target}`);
        return { content: `已发布「${archive.chatKey}」（${messages.length} 条）到本机目录：\n${target}` };
      } catch (e) {
        return { content: `发布失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'archive_fetch',
    name: '读取（覆盖本地）聊天记录',
    description:
      '把远端/本地目录里**指定那一个**存档的聊天记录读回来，**覆盖**本地同 chatKey 的存档（主人说"读取"时调用）。'
      + '操作不可逆：调用前先确认 chatKey 是不是主人要的那一个；读完会告诉回填了多少条。',
    parameters: {
      type: 'object',
      properties: {
        archive: { type: 'string', description: '要读取的存档：chatKey 或群号/QQ号/群名关键字。' }
      },
      required: ['archive']
    },
    category: 'utility',
    async execute(ctx, args) {
      const c = cfg();
      const r = await resolveArchive(args?.archive);
      if (r.error) return { content: r.error, isError: true };
      const { archive } = r;
      try {
        let payload = null;
        if (useGitHub(c)) {
          const got = await ghGet(c, archive.chatKey);
          if (!got) return { content: `GitHub 上没有这个存档：${ghPath(c, archive.chatKey)}`, isError: true };
          payload = got.data;
        } else {
          const target = localPath(c, archive.chatKey);
          if (!target || !fs.existsSync(target)) return { content: `本地目录里没有这个存档：${target || '(未配置)'}`, isError: true };
          payload = JSON.parse(fs.readFileSync(target, 'utf8'));
        }
        if (!Array.isArray(payload?.messages)) return { content: '远端文件格式不对：缺少 messages 数组', isError: true };
        const res = await hostApi('/api/archives/import', {
          method: 'POST',
          body: JSON.stringify({ chatKey: archive.chatKey, messages: payload.messages })
        });
        log(`[${ID}] 已读取 ${archive.chatKey} 覆盖本地（${res.count} 条）`);
        return {
          content: `已读取并覆盖本地存档「${archive.chatKey}」：${res.count} 条（远端导出时间 ${payload.exportedAt || '未知'}）。`
        };
      } catch (e) {
        return { content: `读取失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  log('聊天记录发布 已加载：说「发布」/「读取」即可（未配置 GitHub 时走本机目录）');
}

export function dispose() { /* 无定时器/监听器 */ }
