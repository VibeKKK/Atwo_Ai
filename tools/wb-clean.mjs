#!/usr/bin/env node
/**
 * WorkBuddy 会话清理器（纯文件层面，不碰 UI、不点鼠标）
 *
 * 用法：
 *   node tools/wb-clean.mjs --list                  列出会话与磁盘占用，只读
 *   node tools/wb-clean.mjs --purge-empty           删空的 editor-sdk-* 目录
 *   node tools/wb-clean.mjs --purge-orphans         删 sqlite 里已不存在的会话目录
 *   node tools/wb-clean.mjs --purge-backups         删所有会话的 modify_backup（体积大户）
 *   node tools/wb-clean.mjs --soft <id|序号>        软删会话（写 deleted_at，UI 里会消失）
 *   node tools/wb-clean.mjs --hard <id|序号>        硬删会话行 + 目录，不可恢复
 *   node tools/wb-clean.mjs --vacuum                回收 sqlite 空间
 *
 * 默认全都不带 = 只读 --list 的等价效果。加 --yes 才真正执行破坏性操作。
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'C:\\Users\\kkk\\.workbuddy';
const DB = join(ROOT, 'workbuddy.db');
const SESS_DIR = join(ROOT, 'workspace', 'sessions');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const YES = has('--yes');

const db = new DatabaseSync(DB);
const rows = db.prepare(`
  SELECT id, title, custom_title, status, cwd, created_at, updated_at, deleted_at
  FROM sessions ORDER BY COALESCE(updated_at, created_at) DESC
`).all();

function dirSize(p) {
  let n = 0, files = 0;
  const walk = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { try { n += statSync(f).size; files++; } catch {} }
    }
  };
  walk(p);
  return { bytes: n, files };
}
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const fmt = (ms) => ms ? new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') : '-';

const liveIds = new Set(rows.filter(r => !r.deleted_at).map(r => r.id));

if (has('--list') || argv.length === 0) {
  console.log('=== 会话（sqlite）===');
  rows.forEach((r, i) => {
    const d = join(SESS_DIR, r.id);
    let sz = '';
    try { const s = dirSize(d); sz = sz2(s); } catch {}
    console.log(String(i + 1).padStart(2), fmt(r.created_at), String(r.deleted_at ? 'DELETED' : r.status).padEnd(10),
      String(r.custom_title || r.title || '(无标题)').replace(/\s+/g, ' ').slice(0, 40), sz);
  });
  console.log('\n=== workspace/sessions 目录 ===');
  const dirs = readdirSync(SESS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  let total = 0;
  for (const name of dirs) {
    const s = dirSize(join(SESS_DIR, name));
    total += s.bytes;
    const orphan = !liveIds.has(name) && !name.startsWith('editor-sdk-');
    const empty = s.files === 0;
    const tag = empty ? ' [空]' : orphan ? ' [孤儿]' : '';
    if (!empty || has('--all')) console.log((name.slice(0, 40)).padEnd(42), String(s.files).padStart(6), ' files ', mb(s.bytes).padStart(10), tag);
  }
  console.log('合计', mb(total));
}
function sz2(s) { return ' ' + s.files + ' files ' + mb(s.bytes); }

if (has('--purge-empty') && YES) {
  let n = 0;
  for (const e of readdirSync(SESS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(SESS_DIR, e.name);
    if (dirSize(p).files === 0) { rmSync(p, { recursive: true, force: true }); n++; }
  }
  console.log('删除空目录', n, '个');
}

if (has('--purge-orphans') && YES) {
  let n = 0, freed = 0;
  for (const e of readdirSync(SESS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('editor-sdk-')) continue;
    if (liveIds.has(e.name)) continue;
    const p = join(SESS_DIR, e.name);
    const s = dirSize(p);
    rmSync(p, { recursive: true, force: true });
    n++; freed += s.bytes;
    console.log('删孤儿', e.name, mb(s.bytes));
  }
  console.log('孤儿目录', n, '个，释放', mb(freed));
}

if (has('--purge-backups') && YES) {
  let n = 0, freed = 0;
  for (const e of readdirSync(SESS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(SESS_DIR, e.name, 'modify_backup');
    try {
      const s = dirSize(p);
      if (s.files > 0) { rmSync(p, { recursive: true, force: true }); n++; freed += s.bytes; }
    } catch {}
  }
  console.log('删 modify_backup', n, '份，释放', mb(freed));
}

function resolveTarget(arg) {
  if (!arg) return null;
  const i = Number(arg);
  if (Number.isFinite(i) && i >= 1 && i <= rows.length) return rows[i - 1];
  return rows.find(r => r.id === arg || r.id.startsWith(arg)) || null;
}

if (has('--soft')) {
  const t = resolveTarget(val('--soft'));
  if (!t) { console.error('找不到会话'); process.exit(2); }
  if (!YES) { console.log('[dry] 会软删', t.id, t.title); process.exit(0); }
  db.prepare('UPDATE sessions SET deleted_at = ? WHERE id = ?').run(Date.now(), t.id);
  console.log('已软删', t.id, String(t.custom_title || t.title || ''));
}

if (has('--hard')) {
  const t = resolveTarget(val('--hard'));
  if (!t) { console.error('找不到会话'); process.exit(2); }
  if (!YES) { console.log('[dry] 会硬删', t.id, t.title); process.exit(0); }
  db.prepare('DELETE FROM session_usage WHERE session_id = ?').run(t.id);
  db.prepare('DELETE FROM session_turn_interruptions WHERE session_id = ?').run(t.id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(t.id);
  const p = join(SESS_DIR, t.id);
  try { rmSync(p, { recursive: true, force: true }); } catch {}
  console.log('已硬删', t.id, String(t.custom_title || t.title || ''));
}

if (has('--vacuum') && YES) {
  db.exec('VACUUM');
  console.log('vacuum 完成');
}

db.close();
