// lib/store.mjs —— 多 agent 共享数据库（追加式，永不加锁）
//
// 2026-11-14 用户令：分成「项目库」和「记忆库」两套，同时读写互不占用。
//
// 设计取舍：SQLite / Redis 都有写锁（SQLITE_BUSY / 单写者），并发一高就报「被占用」。
// 这里改用事件日志 + 每 agent 独立文件，并且两套库的目录完全分开：
//
//   memory/db/<库>/journal/<agent>/<表>.jsonl   按 agent + 按表分片（2026-11-14 起）
//   memory/db/<库>/journal/<agent>.jsonl        旧版扁平布局（仍可读，compact 时清空）
//   memory/db/<库>/snapshot.json                compact 折叠出的快照
//   memory/db/<库>/schema.json                  可选：表字段白名单（有则强校验）
//
// 两套库的写路径、读缓存、快照文件全部独立 → 写记忆库永远不会碰项目库的文件，
// 反过来也一样。单行 < 4096 字节时 append 是原子的，所以连文件锁都不需要。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DB_ROOT = path.join(ROOT, 'memory', 'db');
export const DBS = ['project', 'memory'];

const nowIso = () => new Date().toISOString();
let seqCounter = 0;
const nextSeq = () => `${Date.now().toString(36)}-${((seqCounter = (seqCounter + 1) % 1e6)).toString(36)}`;

const safeName = (s) => String(s == null ? '' : s).trim().replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 64) || '_';

function normDb(db) {
  const d = String(db || 'project').trim();
  if (!DBS.includes(d)) throw new Error(`未知的库「${d}」；可用：${DBS.join(' / ')}`);
  return d;
}
const paths = (db) => {
  const base = path.join(DB_ROOT, db);
  return {
    base,
    journal: path.join(base, 'journal'),
    snapshot: path.join(base, 'snapshot.json'),
    schema: path.join(base, 'schema.json'),
  };
};

function agentId(by) {
  return by || process.env.AGENT_ID || process.env.COLLAB_ME || process.env.ORCH_ME || 'dsh-lead';
}

// 每个文件一份 mtime 缓存；键是绝对路径，所以两套库天然隔离
const cache = new Map();

function readJournal(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.sig === sig) return hit.rows;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 半行（正在写）丢掉，下次再读 */ }
  }
  cache.set(file, { sig, rows });
  return rows;
}

// 列出某库的全部 journal 文件（兼容旧的扁平布局 + 新的 <agent>/<表>.jsonl 布局）
function journalFiles(journalDir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(journalDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(journalDir, e.name);
    if (e.isDirectory()) {
      let subs = [];
      try { subs = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const s of subs) {
        if (s.isFile() && s.name.endsWith('.jsonl')) out.push({ file: path.join(full, s.name), table: s.name.replace(/\.jsonl$/, ''), legacy: false });
      }
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push({ file: full, table: null, legacy: true });
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

export function open(dbName = 'project') {
  const db = normDb(dbName);
  const P = paths(db);

  // ---- 可选 schema：有 schema.json 就强校验，没有就完全放开（向后兼容）----
  function loadSchema() {
    try { return JSON.parse(fs.readFileSync(P.schema, 'utf8')); } catch { return null; }
  }
  function checkSchema(table, val) {
    const s = loadSchema();
    if (!s || !s.tables) return;
    const t = s.tables[table];
    if (!t) {
      if (s.strictTables === true) throw new Error(`表「${table}」未在 schema.json 登记（strictTables=true，拒绝写入）`);
      return;
    }
    if (val == null || typeof val !== 'object' || Array.isArray(val)) {
      throw new Error(`表「${table}」的值必须是对象（收到 ${Array.isArray(val) ? 'array' : typeof val}）`);
    }
    const allowed = t.fields || null;
    if (allowed && allowed.length) {
      const extra = Object.keys(val).filter((k) => !allowed.includes(k));
      if (extra.length) {
        // allowExtra 默认放行但要吱声：防止「字段名写错却悄悄写进去」这种静默错误
        if (t.allowExtra === false) throw new Error(`表「${table}」不允许字段：${extra.join(', ')}；已登记：${allowed.join(', ')}`);
        if (process.env.ORCH_STORE_QUIET !== '1') {
          console.error(`[store] 警告：表「${table}」出现未登记字段 ${extra.join(', ')}（已写入；要拒绝就把 schema 里 allowExtra 设成 false）`);
        }
      }
    }
    for (const k of t.required || []) {
      if (val[k] === undefined || val[k] === '') throw new Error(`表「${table}」缺必填字段「${k}」`);
    }
  }

  function append(rec) {
    // 按 agent + 表分片：读单表只碰单表文件，且同表同 agent 的写入天然串行
    const dir = path.join(P.journal, safeName(rec.by));
    fs.mkdirSync(dir, { recursive: true });
    const full = { v: 1, db, seq: nextSeq(), ts: nowIso(), ...rec };
    const line = JSON.stringify(full);
    const bytes = Buffer.byteLength(line);
    if (bytes > 4096) throw new Error(`单条记录 ${bytes} 字节，超过 4096 的原子写上限；请拆成多条`);
    const file = path.join(dir, `${safeName(full.table)}.jsonl`);
    fs.appendFileSync(file, line + '\n', 'utf8');
    cache.delete(file);
    invalidate();   // 本地写入立即生效，不用等签名探测
    return full;
  }

  function put(table, key, val, { by, note = '' } = {}) {
    checkSchema(table, val);
    return append({ op: 'put', table, key, val, note, by: agentId(by) });
  }
  const del = (table, key, { by, note = '' } = {}) => append({ op: 'del', table, key, note, by: agentId(by) });

  // 记录全序：先按时间，同一毫秒再按 seq（snapshot 行用 'snap'，排在同毫秒最前）
  const cmpRec = (a, b) => (a.ts === b.ts ? String(a.seq).localeCompare(String(b.seq)) : (a.ts < b.ts ? -1 : 1));

  function allRecords({ table = null } = {}) {
    // 2026-11-14 修（数据丢失级）：先读 snapshot 作为基线，再叠 journal。
    // 原实现只读 journal，而 compact() 会裁 journal —— 于是「快照写好了但没人读」，
    // 任何一次 compact 都会让旧历史永久消失（实测把项目库 5 行裁没了）。
    const out = [];
    try {
      if (fs.existsSync(P.snapshot)) {
        const snap = JSON.parse(fs.readFileSync(P.snapshot, 'utf8'));
        for (const r of snap.rows || []) {
          if (table && r.table !== table) continue;
          out.push({ op: 'put', table: r.table, key: r.key, val: r.val, by: r.by, ts: r.ts, seq: 'snap' });
        }
      }
    } catch { }
    // 按表分片后：只读需要的文件（旧扁平文件仍要读，里面可能还有历史）
    for (const f of journalFiles(P.journal)) {
      if (table && f.table && f.table !== safeName(table)) continue;
      try { out.push(...readJournal(f.file)); } catch { }
    }
    out.sort(cmpRec);
    return out;
  }

  // 2026-11-14 优化（P0）：view() 原实现每次调用都「全量合并 + 全量排序 + 建 Map」，
  // 于是读一条记录要扫一遍全表 —— 1 万行时单次 get 5.4ms，1000 次 5.4 秒。
  // 这里给每个 table 的视图加一层缓存：本地写入立即失效；跨进程改动靠「文件签名」
  // 探测（默认 50ms 内复用同一签名，避免热循环里每次都 stat 一堆文件）。
  const SIG_TTL = Number(process.env.ORCH_STORE_SIG_TTL_MS || 50);
  let sigCache = { sig: null, at: 0 };

  function sigAll() {
    const now = Date.now();
    if (sigCache.sig !== null && now - sigCache.at < SIG_TTL) return sigCache.sig;
    const parts = [];
    try {
      const st = fs.statSync(P.snapshot);
      parts.push('s' + st.mtimeMs + ':' + st.size);
    } catch { parts.push('s-'); }
    for (const f of journalFiles(P.journal)) {
      try {
        const st = fs.statSync(f.file);
        parts.push(f.file.replace(P.journal, '') + st.mtimeMs + ':' + st.size);
      } catch { }
    }
    sigCache = { sig: parts.join('|'), at: now };
    return sigCache.sig;
  }

  const viewCache = new Map();   // table(或 '*') -> { sig, map }
  function invalidate() { viewCache.clear(); sigCache = { sig: null, at: 0 }; }

  function view(table) {
    const ck = table || '*';
    const sig = sigAll();
    const hit = viewCache.get(ck);
    if (hit && hit.sig === sig) return hit.map;
    const m = new Map();
    for (const r of allRecords({ table })) {
      if (table && r.table !== table) continue;
      m.set(r.key, r);
    }
    for (const [k, r] of [...m]) if (r.op === 'del') m.delete(k);
    viewCache.set(ck, { sig, map: m });
    return m;
  }

  const get = (table, key) => view(table).get(key) || null;
  // table 省略 = 列出本库所有表的存活行（看板用）
  const list = (table) => [...view(table).values()].map((r) => ({ table: r.table, key: r.key, val: r.val, by: r.by, ts: r.ts }));

  // 2026-11-14 新增：某个键的完整历史（谁在什么时候把它改成了什么）——
  // 这是事件日志白送的能力，SQLite 得额外建审计表才能做到。
  function history(table, key, { limit = 50 } = {}) {
    return allRecords({ table })
      .filter((r) => r.table === table && r.key === key)
      .map((r) => ({ op: r.op, val: r.val, by: r.by, ts: r.ts, seq: r.seq }))
      .slice(-limit);
  }

  function tables() {
    const s = new Map();
    for (const r of allRecords()) {
      if (r.op === 'del') continue;
      const t = r.table || 'default';
      s.set(t, (s.get(t) || 0) + 1);
    }
    return [...s.entries()].map(([t, n]) => ({ table: t, rows: n })).sort((a, b) => (a.table < b.table ? -1 : 1));
  }

  function log({ sinceMs = 0, by = null, table = null, limit = 40 } = {}) {
    const cut = Date.now() - sinceMs;
    return allRecords({ table })
      .filter((r) => (!by || r.by === by) && (!table || r.table === table) && new Date(r.ts).getTime() >= cut)
      .slice(-limit);
  }

  function stats() {
    const recs = allRecords();
    const per = new Map();
    for (const r of recs) {
      const s = per.get(r.by) || { by: r.by, puts: 0, dels: 0, lastTs: '' };
      if (r.op === 'del') s.dels++; else s.puts++;
      if (r.ts > s.lastTs) s.lastTs = r.ts;
      per.set(r.by, s);
    }
    return { db, records: recs.length, liveRows: view().size, agents: [...per.values()], tables: tables(), files: journalFiles(P.journal).length };
  }

  function compact({ keepRecent = 200 } = {}) {
    fs.mkdirSync(P.journal, { recursive: true });
    const recs = allRecords();
    const live = [...view().entries()].map(([key, r]) => ({ key, table: r.table, val: r.val, by: r.by, ts: r.ts }));
    fs.writeFileSync(P.snapshot, JSON.stringify({ db, at: nowIso(), rows: live }, null, 2), 'utf8');

    // 保留最近 N 条，按「agent + 表」重新分片写回；其余一概清空（含旧扁平文件）
    const tail = recs.slice(-keepRecent);
    const byFile = new Map();
    for (const r of tail) {
      const f = path.join(P.journal, safeName(r.by), `${safeName(r.table)}.jsonl`);
      byFile.set(f, (byFile.get(f) || []).concat([JSON.stringify(r)]));
    }
    const existing = journalFiles(P.journal).map((f) => f.file);
    for (const f of new Set([...existing, ...byFile.keys()])) {
      const lines = byFile.get(f);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, lines ? lines.join('\n') + '\n' : '', 'utf8');
      cache.delete(f);
    }
    invalidate();
    return { db, snapshotRows: live.length, keptTail: tail.length };
  }

  return { db, put, get, list, del, log, tables, stats, compact, history, allRecords, view, paths: P, schema: loadSchema };
}

// 默认库 = 项目库（保持旧调用方式可用）
const defaultDb = open('project');
export const put = defaultDb.put;
export const get = defaultDb.get;
export const list = defaultDb.list;
export const del = defaultDb.del;
export const log = defaultDb.log;
export const tables = defaultDb.tables;
export const stats = defaultDb.stats;
export const compact = defaultDb.compact;
export const history = defaultDb.history;
export const allRecords = defaultDb.allRecords;
export const view = defaultDb.view;

export function allDbStats() {
  return DBS.map((d) => open(d).stats());
}
