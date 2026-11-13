// lib/store.mjs —— 多 agent 共享数据库（追加式，永不加锁）
//
// 2026-11-14 用户令：分成「项目库」和「记忆库」两套，同时读写互不占用。
//
// 设计取舍：SQLite / Redis 都有写锁（SQLITE_BUSY / 单写者），并发一高就报「被占用」。
// 这里改用事件日志 + 每 agent 独立文件，并且两套库的目录完全分开：
//
//   memory/db/project/journal/<agent>.jsonl    项目库：进度 / 状态 / 待办 / 交付物
//   memory/db/memory/journal/<agent>.jsonl     记忆库：决策 / 教训 / 事实 / 偏好
//   memory/db/<库>/snapshot.json               compact 折叠出的快照
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

function normDb(db) {
  const d = String(db || 'project').trim();
  if (!DBS.includes(d)) throw new Error(`未知的库「${d}」；可用：${DBS.join(' / ')}`);
  return d;
}
const paths = (db) => {
  const base = path.join(DB_ROOT, db);
  return { base, journal: path.join(base, 'journal'), snapshot: path.join(base, 'snapshot.json') };
};

function agentId(by) {
  return by || process.env.AGENT_ID || process.env.COLLAB_ME || process.env.ORCH_ME || 'dsh-lead';
}

// 每个文件一份 mtime 缓存；键是绝对路径，所以两套库天然隔离
const cache = new Map();

function readJournal(file) {
  const st = fs.statSync(file);
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

export function open(dbName = 'project') {
  const db = normDb(dbName);
  const P = paths(db);

  function append(rec) {
    fs.mkdirSync(P.journal, { recursive: true });
    const full = { v: 1, db, seq: nextSeq(), ts: nowIso(), ...rec };
    const line = JSON.stringify(full);
    const bytes = Buffer.byteLength(line);
    if (bytes > 4096) throw new Error(`单条记录 ${bytes} 字节，超过 4096 的原子写上限；请拆成多条`);
    const file = path.join(P.journal, `${String(full.by).replace(/[^\w.-]/g, '_')}.jsonl`);
    fs.appendFileSync(file, line + '\n', 'utf8');
    cache.delete(file);
    invalidate();   // 本地写入立即生效，不用等签名探测
    return full;
  }

  const put = (table, key, val, { by, note = '' } = {}) => append({ op: 'put', table, key, val, note, by: agentId(by) });
  const del = (table, key, { by, note = '' } = {}) => append({ op: 'del', table, key, note, by: agentId(by) });

  // 记录全序：先按时间，同一毫秒再按 seq（snapshot 行用 'snap'，排在同毫秒最前）
  const cmpRec = (a, b) => (a.ts === b.ts ? String(a.seq).localeCompare(String(b.seq)) : (a.ts < b.ts ? -1 : 1));

  function allRecords() {
    // 2026-11-14 修（数据丢失级）：先读 snapshot 作为基线，再叠 journal。
    // 原实现只读 journal，而 compact() 会裁 journal —— 于是「快照写好了但没人读」，
    // 任何一次 compact 都会让旧历史永久消失（实测把项目库 5 行裁没了）。
    const out = [];
    try {
      if (fs.existsSync(P.snapshot)) {
        const snap = JSON.parse(fs.readFileSync(P.snapshot, 'utf8'));
        for (const r of snap.rows || []) {
          out.push({ op: 'put', table: r.table, key: r.key, val: r.val, by: r.by, ts: r.ts, seq: 'snap' });
        }
      }
    } catch { }
    if (!fs.existsSync(P.journal)) { out.sort(cmpRec); return out; }
    for (const name of fs.readdirSync(P.journal)) {
      if (!name.endsWith('.jsonl')) continue;
      try { out.push(...readJournal(path.join(P.journal, name))); } catch { }
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
    try {
      for (const name of fs.readdirSync(P.journal).sort()) {
        if (!name.endsWith('.jsonl')) continue;
        try {
          const st = fs.statSync(path.join(P.journal, name));
          parts.push(name + st.mtimeMs + ':' + st.size);
        } catch { }
      }
    } catch { }
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
    for (const r of allRecords()) {
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
    return allRecords()
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
    return { db, records: recs.length, liveRows: view().size, agents: [...per.values()], tables: tables() };
  }

  function compact({ keepRecent = 200 } = {}) {
    fs.mkdirSync(P.journal, { recursive: true });
    const recs = allRecords();
    const live = [...view().entries()].map(([key, r]) => ({ key, table: r.table, val: r.val, by: r.by, ts: r.ts }));
    fs.writeFileSync(P.snapshot, JSON.stringify({ db, at: nowIso(), rows: live }, null, 2), 'utf8');
    const tail = recs.slice(-keepRecent);
    const byFile = new Map();
    for (const r of tail) {
      const f = path.join(P.journal, `${String(r.by).replace(/[^\w.-]/g, '_')}.jsonl`);
      byFile.set(f, (byFile.get(f) || []).concat([JSON.stringify(r)]));
    }
    for (const name of fs.readdirSync(P.journal)) {
      if (!name.endsWith('.jsonl')) continue;
      const f = path.join(P.journal, name);
      const lines = byFile.get(f);
      fs.writeFileSync(f, lines ? lines.join('\n') + '\n' : '', 'utf8');
      cache.delete(f);
    }
    return { db, snapshotRows: live.length, keptTail: tail.length };
  }

  return { db, put, get, list, del, log, tables, stats, compact, allRecords, view, paths: P };
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
export const allRecords = defaultDb.allRecords;
export const view = defaultDb.view;

export function allDbStats() {
  return DBS.map((d) => open(d).stats());
}
