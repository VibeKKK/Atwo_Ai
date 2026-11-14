#!/usr/bin/env node
// store.mjs —— 多 agent 共享数据库 CLI（项目库 / 记忆库两套，互不占用）
//
//   node store.mjs put  <表> <键> <值> [--db project|memory] [--note 说明] [--by agent]
//   node store.mjs get  <表> <键>            [--db ...]
//   node store.mjs list <表>                 [--db ...]
//   node store.mjs del  <表> <键>            [--db ...] [--note 原因]
//   node store.mjs history <表> <键>         [--db ...] [--limit 50]
//   node store.mjs log  [--since 30m] [--by agent] [--table 表] [--db ...]
//   node store.mjs tables | stat | compact   [--db ...]
//   node store.mjs dbs                        两套库一起看
//
// 两套库的目录、缓存、快照完全独立：
//   memory/db/project/journal/<agent>.jsonl   项目：进度 / 状态 / 待办 / 交付物
//   memory/db/memory/journal/<agent>.jsonl    记忆：决策 / 教训 / 事实 / 偏好

import { open, DBS, allDbStats } from './lib/store.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'dbs';

function flag(name, dflt = null) {
  const i = argv.indexOf('--' + name);
  return i > 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}
function pos(offset, n = 1) {
  const out = [];
  for (const a of argv.slice(offset)) {
    if (a.startsWith('--')) break;
    out.push(a);
    if (out.length >= n) break;
  }
  return out;
}
function sinceToMs(s) {
  if (!s) return 0;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  return n * (unit === 's' ? 1e3 : unit === 'm' ? 60e3 : unit === 'h' ? 3600e3 : 86400e3);
}
const short = (v, n = 90) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const DB = flag('db', 'project');
// 2026-11-14：机器可读输出。加 --json 后所有查询类命令只吐 JSON（人看的版本仍保留），
// 便于别的 agent 或脚本直接消费，不用正则解析中文。
const JSON_OUT = argv.includes('--json');
const out = (obj) => { if (JSON_OUT) { console.log(JSON.stringify(obj, null, 2)); return true; } return false; };

try {
  if (cmd === 'dbs') {
    if (out({ ok: true, dbs: allDbStats() })) process.exit(0);
    for (const s of allDbStats()) {
      console.log(`\n[${s.db === 'project' ? '项目库' : '记忆库'}] ${s.db}   记录 ${s.records}  活跃行 ${s.liveRows}`);
      if (!s.agents.length) { console.log('  (空)'); continue; }
      for (const a of s.agents) console.log(`  ${a.by.padEnd(20)} put ${String(a.puts).padEnd(5)} del ${String(a.dels).padEnd(4)} 最后 ${a.lastTs.replace('T', ' ').slice(0, 19)}`);
      for (const t of s.tables) console.log(`  [表] ${t.table}  ${t.rows} 行`);
    }
    console.log('\n可用：--db ' + DBS.join(' | ') + '（默认 project）');
  } else if (cmd === 'put') {
    const [table, key, ...rest] = pos(1, 3);
    if (table === undefined || key === undefined) throw new Error('用法：put <表> <键> <值> [--db memory]');
    const raw = rest[0] === undefined ? (flag('val') ?? '') : rest[0];
    let parsed = raw;
    try { if (/^[{[]/.test(raw)) parsed = JSON.parse(raw); } catch { }
    const r = open(DB).put(table, key, parsed, { by: flag('by'), note: flag('note', '') });
    if (!out({ ok: true, op: 'put', db: r.db, table, key, seq: r.seq, by: r.by })) console.log(`✓ [${r.db}] put ${table}/${key}  seq=${r.seq}  by=${r.by}`);
  } else if (cmd === 'get') {
    const [table, key] = pos(1, 2);
    const r = open(DB).get(table, key);
    if (!r) { if (!out({ ok: false, code: 'ENOTFOUND', message: `${DB} 库中不存在 ${table}/${key}` })) console.log(`(${DB} 库中不存在)`); process.exit(1); }
    out({ ok: true, db: DB, table, key: r.key, val: r.val, by: r.by, ts: r.ts });
    if (!JSON_OUT) console.log(JSON.stringify({ db: DB, key: r.key, val: r.val, by: r.by, ts: r.ts }, null, 2));
  } else if (cmd === 'list') {
    const [table] = pos(1, 1);
    const rows = open(DB).list(table);
    if (out({ ok: true, db: DB, table: table || null, count: rows.length, rows })) process.exit(0);
    if (!rows.length) { console.log(`(${DB} 库为空)`); process.exit(0); }
    for (const r of rows) console.log(`${r.key}\t${short(r.val)}\t[${r.by} ${r.ts.slice(11, 19)}]`);
    console.log(`共 ${rows.length} 行 · ${DB} 库`);
  } else if (cmd === 'del') {
    const [table, key] = pos(1, 2);
    if (table === undefined || key === undefined) throw new Error('用法：del <表> <键> [--db memory]');
    const r = open(DB).del(table, key, { by: flag('by'), note: flag('note', '') });
    if (!out({ ok: true, op: 'del', db: r.db, table, key, seq: r.seq, by: r.by, note: '逻辑删除，历史保留' })) console.log(`✓ [${r.db}] del ${table}/${key}  seq=${r.seq}  by=${r.by}（逻辑删除，历史保留）`);
  } else if (cmd === 'history') {
    const [table, key] = pos(1, 2);
    if (table === undefined || key === undefined) throw new Error('用法：history <表> <键> [--db memory] [--limit 50]');
    const rows = open(DB).history(table, key, { limit: Number(flag('limit', 50)) });
    if (out({ ok: true, db: DB, table, key, count: rows.length, history: rows })) process.exit(0);
    if (!rows.length) { console.log(`(${DB} 库里 ${table}/${key} 没有历史)`); process.exit(0); }
    console.log(`[${DB}] ${table}/${key} 共 ${rows.length} 次变化（旧 → 新）`);
    rows.forEach((r, i) => {
      const t = r.ts.replace('T', ' ').slice(0, 19);
      console.log(`  ${String(i + 1).padStart(2)}. ${t}  ${String(r.by).padEnd(18)} ${r.op === 'del' ? 'DEL' : 'PUT'}  ${r.op === 'del' ? '(删除)' : short(r.val, 70)}`);
    });
  } else if (cmd === 'log') {
    const rows = open(DB).log({
      sinceMs: sinceToMs(flag('since', '30m')),
      by: flag('by'),
      table: flag('table'),
      limit: Number(flag('limit', 40)),
    });
    if (out({ ok: true, db: DB, count: rows.length, rows })) process.exit(0);
    if (!rows.length) { console.log(`(${DB} 库这段时间没有记录)`); process.exit(0); }
    for (const r of rows) {
      console.log(`${r.ts.slice(11, 19)}  ${r.by.padEnd(18)} ${r.op === 'del' ? 'DEL' : 'PUT'}  ${r.table}/${r.key}  ${r.op === 'del' ? '' : short(r.val, 56)}${r.note ? '  · ' + r.note : ''}`);
    }
  } else if (cmd === 'tables') {
    const t = open(DB).tables();
    if (out({ ok: true, db: DB, count: t.length, tables: t })) process.exit(0);
    if (!t.length) { console.log(`(${DB} 库还没有表)`); process.exit(0); }
    for (const x of t) console.log(`${x.table}\t${x.rows} 行`);
  } else if (cmd === 'stat') {
    const s = open(DB).stats();
    if (out({ ok: true, ...s })) process.exit(0);
    console.log(`[${s.db}] 记录总数 ${s.records}   活跃行 ${s.liveRows}`);
    for (const a of s.agents) console.log(`  ${a.by.padEnd(20)} put ${String(a.puts).padEnd(5)} del ${String(a.dels).padEnd(5)} 最后 ${a.lastTs.replace('T', ' ').slice(0, 19)}`);
    for (const t of s.tables) console.log(`  [表] ${t.table}  ${t.rows} 行`);
  } else if (cmd === 'compact') {
    const r = open(DB).compact({ keepRecent: Number(flag('keep', 200)) });
    if (!out({ ok: true, op: 'compact', ...r })) console.log(`✓ [${r.db}] 已压缩：快照 ${r.snapshotRows} 行，各 journal 保留最近 ${r.keptTail} 条`);
  } else {
    console.error('未知命令：' + cmd + '\n可用：put / get / list / del / history / log / tables / stat / compact / dbs');
    process.exit(2);
  }
} catch (e) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, code: e.code || 'EUNKNOWN', message: e.message }, null, 2));
  else console.error('错误：' + e.message);
  process.exit(1);
}
