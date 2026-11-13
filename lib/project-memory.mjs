// 项目记忆接续核心 —— 让下一次开工不用从零解释背景。
//
// 设计取舍：
//   1. 记忆存在项目自己的根目录（<root>/STATE.md），不集中放 —— 项目搬走/删掉，记忆跟着走。
//   2. 格式是人可读的 markdown，不是数据库 —— 你自己随时能打开改，我也能解析。
//   3. 注册表只记「哪些项目有记忆」，不存内容 —— 避免两处真相打架。
//   4. 进度用复选框：- [x] 完成 / - [ ] 进行中 / - [!] 卡住。解析简单、渲染好看。
//
// 用法见同目录 ../resume.mjs
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync,
} from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MEM = join(ROOT, 'memory');
const REGISTRY = join(MEM, 'projects.json');
const STATE_FILE = 'STATE.md';

mkdirSync(MEM, { recursive: true });

export const now = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const today = () => now().slice(0, 10);

// ---------------- 注册表 ----------------
function loadRegistry() {
  if (!existsSync(REGISTRY)) return { projects: [] };
  try { return JSON.parse(readFileSync(REGISTRY, 'utf8')); } catch { return { projects: [] }; }
}
function saveRegistry(r) {
  writeFileSync(REGISTRY, JSON.stringify(r, null, 2), 'utf8');
}
export function listProjects() {
  return loadRegistry().projects
    .map(p => ({ ...p, exists: existsSync(join(p.root, STATE_FILE)) }))
    .sort((a, b) => String(b.touched || '').localeCompare(String(a.touched || '')));
}
function findByName(nameOrPath) {
  const reg = loadRegistry();
  if (!nameOrPath) return null;
  // 支持：注册名 / 绝对路径 / 路径尾段
  const byName = reg.projects.find(p => p.name === nameOrPath);
  if (byName) return byName;
  const abs = resolve(nameOrPath);
  const byPath = reg.projects.find(p => resolve(p.root) === abs);
  if (byPath) return byPath;
  const byTail = reg.projects.find(p => basename(p.root) === nameOrPath);
  return byTail || null;
}

export function register(root, opts = {}) {
  const abs = resolve(root);
  const reg = loadRegistry();
  const i = reg.projects.findIndex(p => resolve(p.root) === abs);
  const entry = {
    name: opts.name || basename(abs),
    root: abs,
    goal: opts.goal || '',
    touched: now(),
  };
  if (i >= 0) reg.projects[i] = { ...reg.projects[i], ...entry };
  else reg.projects.push(entry);
  saveRegistry(reg);
  ensureState(abs, entry);
  return entry;
}

export function touch(nameOrPath) {
  const p = findByName(nameOrPath);
  if (!p) return null;
  const reg = loadRegistry();
  const i = reg.projects.findIndex(x => resolve(x.root) === resolve(p.root));
  if (i >= 0) { reg.projects[i].touched = now(); saveRegistry(reg); }
  return p;
}

// ---------------- STATE.md ----------------
const TEMPLATE = (name, goal) => `# ${name}

> 项目记忆。AI 开工先读这一份，不用人复述背景。
> 改法：\`node resume.mjs done|next|block|add|note <项目> "<内容>"\`

## 目标
${goal || '（一句话说清这个项目要解决什么）'}

## 进度
- [ ] 把「目标」和「下一步」两段填掉

## 下一步
- （待填）

## 已确认的事实
- 建立于 ${now()}

## 流水
- ${now()}  建立项目记忆
`;

export function statePath(root) { return join(resolve(root), STATE_FILE); }

function ensureState(root, entry) {
  const f = statePath(root);
  if (!existsSync(f)) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, TEMPLATE(entry.name, entry.goal), 'utf8');
  }
}

export function readProject(nameOrPath) {
  const p = findByName(nameOrPath);
  if (!p) return null;
  const f = statePath(p.root);
  if (!existsSync(f)) return { ...p, raw: '', missing: true };
  return { ...p, raw: readFileSync(f, 'utf8'), missing: false };
}

/** 按 ## 切段，返回 { 段名: 正文 } */
export function sections(raw) {
  const out = {};
  const parts = raw.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    if (nl < 0) { out[part.trim()] = ''; continue; }
    out[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  return out;
}

const LINE_RE = /^\s*-\s*\[( |x|!)\]\s*(.*)$/;
// 模板占位（以（开头）不算真条目，避免简报里出现「进行中：（待填）」
const isPlaceholder = (t) => /^[（(]/.test(t) || /^（待填）/.test(t);

/** 解析进度段：done / doing / blocked */
export function parseProgress(raw) {
  const sec = sections(raw)['进度'] || '';
  const done = [], doing = [], blocked = [];
  for (const line of sec.split('\n')) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const text = m[2].trim();
    if (!text || isPlaceholder(text)) continue;
    if (m[1] === 'x') done.push(text);
    else if (m[1] === '!') blocked.push(text);
    else doing.push(text);
  }
  return { done, doing, blocked };
}

function replaceSection(raw, title, body) {
  const re = new RegExp('(## ' + title + '\\n)([\\s\\S]*?)(?=\\n## |$)');
  if (re.test(raw)) return raw.replace(re, `$1${body}\n`);
  return raw.replace(/\s*$/, '') + `\n\n## ${title}\n${body}\n`;
}

// ---------------- 写操作 ----------------
export function addItem(nameOrPath, text, mark = ' ') {
  const p = readProject(nameOrPath);
  if (!p) throw new Error('未注册的项目: ' + nameOrPath);
  let raw = p.raw;
  const sec = sections(raw)['进度'] || '';
  const line = `- [${mark}] ${text}`;
  if (sec) raw = replaceSection(raw, '进度', (sec + '\n' + line).trim());
  else raw = replaceSection(raw, '进度', line);
  writeFileSync(statePath(p.root), raw, 'utf8');
  touch(p.name);
  return raw;
}

export function markDone(nameOrPath, keyword) {
  const p = readProject(nameOrPath);
  if (!p) throw new Error('未注册的项目: ' + nameOrPath);
  const lines = (sections(p.raw)['进度'] || '').split('\n');
  let hit = 0;
  const out = lines.map(line => {
    const m = line.match(LINE_RE);
    if (!m) return line;
    const text = m[2].trim();
    if (m[1] !== 'x' && text.includes(keyword)) { hit++; return `- [x] ${text}（${today()} 完成）`; }
    return line;
  });
  if (!hit) return { changed: false, raw: p.raw };
  const raw = replaceSection(p.raw, '进度', out.join('\n').trim());
  writeFileSync(statePath(p.root), raw, 'utf8');
  touch(p.name);
  return { changed: true, hit, raw };
}

export function markBlocked(nameOrPath, keyword, reason) {
  const p = readProject(nameOrPath);
  if (!p) throw new Error('未注册的项目: ' + nameOrPath);
  const lines = (sections(p.raw)['进度'] || '').split('\n');
  let hit = 0;
  const out = lines.map(line => {
    const m = line.match(LINE_RE);
    if (!m) return line;
    const text = m[2].trim();
    if (m[1] !== 'x' && text.includes(keyword)) {
      hit++;
      return `- [!] ${text}${reason ? ' — 卡在：' + reason : ''}`;
    }
    return line;
  });
  if (!hit) return { changed: false, raw: p.raw };
  const raw = replaceSection(p.raw, '进度', out.join('\n').trim());
  writeFileSync(statePath(p.root), raw, 'utf8');
  touch(p.name);
  return { changed: true, hit, raw };
}

export function setNext(nameOrPath, text) {
  const p = readProject(nameOrPath);
  if (!p) throw new Error('未注册的项目: ' + nameOrPath);
  const raw = replaceSection(p.raw, '下一步', text.startsWith('-') ? text : '- ' + text);
  writeFileSync(statePath(p.root), raw, 'utf8');
  touch(p.name);
  return raw;
}

export function note(nameOrPath, text) {
  const p = readProject(nameOrPath);
  if (!p) throw new Error('未注册的项目: ' + nameOrPath);
  const sec = sections(p.raw)['流水'] || '';
  const line = `- ${now()}  ${text}`;
  const body = (sec ? sec + '\n' : '') + line;
  // 流水只留最近 60 行，避免无限长
  const kept = body.split('\n').slice(-60).join('\n');
  const raw = replaceSection(p.raw, '流水', kept);
  writeFileSync(statePath(p.root), raw, 'utf8');
  touch(p.name);
  appendFileSync(join(MEM, 'project-log.jsonl'), JSON.stringify({ time: now(), project: p.name, text }) + '\n', 'utf8');
  return raw;
}

// ---------------- 接续简报 ----------------
/**
 * 给「下一个人（或下一次的我）」看的简报。
 * slim=true 时压到 ~600 字符，够塞进任何 prompt。
 */
export function brief(nameOrPath, opts = {}) {
  const { slim = false } = opts;
  const p = readProject(nameOrPath);
  if (!p) return null;
  if (p.missing) return { name: p.name, root: p.root, missing: true };
  const s = sections(p.raw);
  const { done, doing, blocked } = parseProgress(p.raw);
  const one = (arr, n) => arr.slice(slim ? 0 : -n, undefined);

  if (slim) {
    const parts = [];
    if (s['下一步']) parts.push('下一步：' + s['下一步'].split('\n')[0].replace(/^-\s*/, ''));
    if (blocked.length) parts.push('卡住：' + blocked[0]);
    else if (doing.length) parts.push('进行中：' + doing[0]);
    if (done.length) parts.push(`已完成 ${done.length} 项`);
    return { name: p.name, root: p.root, slim: parts.join(' ｜ ') };
  }

  return {
    name: p.name,
    root: p.root,
    goal: s['目标'] || '',
    next: s['下一步'] || '',
    done, doing, blocked,
    facts: (s['已确认的事实'] || '').split('\n').filter(Boolean).map(l => l.replace(/^-\s*/, '')),
    recent: (s['流水'] || '').split('\n').filter(Boolean).slice(-5),
    lastLine: one(doing, 1)[0] || '',
  };
}

/** 渲染成终端里能直接读的一段 */
export function renderBrief(b) {
  if (!b) return '（没有这个项目）';
  if (b.missing) return `[${b.name}] STATE.md 不存在，先跑 init`;

  const L = [];
  L.push(`══ ${b.name} ══`);
  L.push(`位置  ${b.root}`);
  if (b.goal) L.push(`目标  ${b.goal.split('\n')[0]}`);
  L.push('');
  if (b.next) {
    L.push('下一步');
    for (const line of b.next.split('\n').filter(Boolean)) L.push('  ' + line.replace(/^-\s*/, '· '));
  }
  if (b.blocked.length) {
    L.push('');
    L.push(`卡住 ${b.blocked.length} 项`);
    for (const x of b.blocked) L.push('  ✕ ' + x);
  }
  if (b.doing.length) {
    L.push('');
    L.push(`进行中 ${b.doing.length} 项`);
    for (const x of b.doing) L.push('  · ' + x);
  }
  if (b.done.length) {
    L.push('');
    L.push(`已完成 ${b.done.length} 项（最近 3 条）`);
    for (const x of b.done.slice(-3)) L.push('  ✓ ' + x);
  }
  if (b.recent && b.recent.length) {
    L.push('');
    L.push('最近流水');
    for (const x of b.recent) L.push('  ' + x.replace(/^-\s*/, ''));
  }
  return L.join('\n');
}

/** 所有项目一张表 */
export function renderList() {
  const ps = listProjects();
  if (!ps.length) return '（还没有注册任何项目。用 node resume.mjs init <路径> 建一个）';
  const rows = ps.map(p => {
    const b = p.exists ? brief(p.name, { slim: true }) : null;
    return {
      name: p.name,
      touched: p.touched || '—',
      next: b ? (b.slim || '') : 'STATE.md 缺失',
    };
  });
  const w = Math.max(...rows.map(r => r.name.length), 4) + 2;
  const out = ['项目'.padEnd(w) + '最后活动'.padEnd(18) + '下一步'];
  out.push('─'.repeat(76));
  for (const r of rows) out.push(r.name.padEnd(w) + r.touched.padEnd(18) + r.next);
  return out.join('\n');
}

export { STATE_FILE, MEM as MEMORY_DIR };
