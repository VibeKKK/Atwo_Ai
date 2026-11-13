/**
 * ephemeral.mjs —— 临时共享层（会话级、到期自清）
 *
 * 为什么需要它：
 *   DSH 的插件/skill 一旦装进 profile 就是「永久常驻」——每次会话都要为它的
 *   description 付上下文成本。但绝大多数能力是「这次任务需要，下次不需要」。
 *
 * 本模块不碰全局安装，只维护一份「本次会话临时可用」的清单：
 *   · 不写 package.json / bundles / ~/.dsh/skills，永久占用为 0
 *   · 内容不进常驻上下文，只在派活那一刻按需读、按需注入（默认上限 1200 字符）
 *   · 到期（默认 8 小时）或被 gc / clear 时自动消失
 *
 * 会话边界：ORCH_SESSION_ID（没给就 'default'）。每次 orchestra 启动会跑一次 gc。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须用 fileURLToPath —— import.meta.url 的 pathname 会把空格变成 %20，
// 也不处理 Windows 盘符（曾经拼出 D:\D:\ai%20project\... 这种路）。
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STORE = path.join(ROOT, 'memory', '.ephemeral.json');
export const SKILLS_DIR = process.env.ORCH_SKILLS_DIR || 'C:/Users/kkk/.dsh/skills';
export const DEFAULT_TTL_MS = Number(process.env.ORCH_EPH_TTL_MS || 8 * 3600 * 1000);
export const KINDS = ['plugin', 'tool', 'skill', 'file'];

const sessionId = () => process.env.ORCH_SESSION_ID || 'default';

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (j && typeof j === 'object' && j.items) return j;
  } catch { /* 不存在或坏了都当空 */ }
  return { version: 1, items: [] };
}

function save(db) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, STORE);
}

const now = () => Date.now();

/** 加一条临时能力。kind: plugin|tool|skill|file */
export function add({ kind, name, file, note = '', ttlMs = DEFAULT_TTL_MS, session = sessionId() } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`kind 只能是 ${KINDS.join(' / ')}，收到 ${kind}`);
  if (!name) throw new Error('name 必填');
  const db = load();
  const id = `${session}:${kind}:${name}`;
  const i = db.items.findIndex(x => x.id === id);
  const rec = {
    id, session, kind, name,
    file: file || (kind === 'skill' ? path.join(SKILLS_DIR, name, 'SKILL.md').replace(/\\/g, '/') : ''),
    note,
    addedAt: now(),
    expiresAt: now() + Math.max(60 * 1000, ttlMs),
  };
  if (i >= 0) db.items[i] = rec; else db.items.push(rec);
  save(db);
  return rec;
}

export const isExpired = (x, t = now()) => !!x.expiresAt && x.expiresAt <= t;

/** 清掉过期项，返回清理条数 */
export function gc() {
  const db = load();
  const before = db.items.length;
  db.items = db.items.filter(x => !isExpired(x));
  if (db.items.length !== before) save(db);
  return before - db.items.length;
}

export function list({ session = null, all = false } = {}) {
  gc();
  const db = load();
  return db.items
    .filter(x => all || !session || x.session === session)
    .map(x => ({ ...x, expired: isExpired(x), leftMin: Math.max(0, Math.round((x.expiresAt - now()) / 60000)) }));
}

export function remove(name, { session = sessionId() } = {}) {
  const db = load();
  const before = db.items.length;
  db.items = db.items.filter(x => !(x.name === name && (x.session === session || x.session === 'default')));
  if (db.items.length === before) return 0;
  save(db);
  return before - db.items.length;
}

export function clear({ session = sessionId(), all = false } = {}) {
  const db = load();
  const before = db.items.length;
  db.items = all ? [] : db.items.filter(x => x.session !== session);
  save(db);
  return before - db.items.length;
}

/** 读 skill 正文（按需，不进常驻上下文）。maxChars 截断，避免把整本手册塞进 prompt */
export function readSkill(name, { maxChars = 3000, file = null } = {}) {
  const p = file || path.join(SKILLS_DIR, name, 'SKILL.md');
  if (!fs.existsSync(p)) return { ok: false, reason: `找不到 ${p}` };
  const txt = fs.readFileSync(p, 'utf8');
  return { ok: true, file: p, chars: txt.length, text: txt.slice(0, maxChars), truncated: txt.length > maxChars };
}

/**
 * 生成注入块：告诉 agent「本次会话临时多了这些能力」。
 * 刻意压到 1200 字符以内 —— 这层是「提示存在」，不是「把手册抄给它」。
 */
export function briefBlock({ session = sessionId(), maxChars = 1200 } = {}) {
  const items = list({ session });
  if (!items.length) return '';
  const lines = items.map(x => {
    const where = x.file ? `（${x.file}）` : '';
    return `- [${x.kind}] ${x.name}${where}${x.note ? ' · ' + x.note : ''}`;
  });
  const head = `\n\n[临时能力] 本次会话额外可用（会话结束即失效，不要当成永久配置）：\n`;
  let out = head + lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars - 20) + '\n…（其余已省略）';
  return out;
}

export function stats() {
  gc();
  const db = load();
  const by = {};
  for (const x of db.items) by[x.kind] = (by[x.kind] || 0) + 1;
  return { total: db.items.length, byKind: by, store: STORE, session: sessionId() };
}
