// 图龄：graft 的依赖图有多旧。
//
// 为什么要单独算这个（2026-11-18）：atwo 的六处融合里有三处会去读 `.graft/graft.db`，
// 读不到或读到旧的都会「静默退回旧行为」—— 看起来一切正常，实际上那三处等于没接。
// 这类退化最贵：你不知道自己什么时候失去了眼睛。所以把「图龄」变成一条能打印、
// 能被闸门读的数字，而不是等某次派活结果不对劲再去猜。
import fs from 'node:fs';
import path from 'node:path';

const DB_REL = path.join('.graft', 'graft.db');

/** 只扫一层：这些目录的改动一定会让闭包过期，深层文件改动由 graft 自己的增量负责。 */
const WATCH = ['lib', 'agents', 'test', 'bin', 'vm', 'eval'];

function newestUnder(dir, depth = 1, now = Date.now()) {
  let newest = 0;
  let cur = dir;
  for (let d = 0; d <= depth; d += 1) {
    let names = [];
    try { names = fs.readdirSync(cur, { withFileTypes: true }); } catch { return newest; }
    for (const ent of names) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) continue;
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs > newest && st.mtimeMs <= now + 60000) newest = st.mtimeMs;
      } catch { /* 文件刚被删，跳过 */ }
    }
    break;
  }
  return newest;
}

/**
 * 图龄体检。绝不抛：没图、库坏了、目录不存在都只是「stale + 原因」。
 * @returns {{exists:boolean, dbPath:string, indexedAt:number, ageMs:number|null,
 *            newestSrcMs:number, stale:boolean, reason:string}}
 */
export function graphAge(cwd, { now = Date.now() } = {}) {
  const dbPath = path.join(cwd || '.', DB_REL);
  let exists = false;
  let dbMs = 0;
  try {
    dbMs = fs.statSync(dbPath).mtimeMs;
    exists = true;
  } catch {
    return { exists: false, dbPath, indexedAt: 0, ageMs: null, newestSrcMs: 0, stale: true, reason: '没有图库（先跑 graft index）' };
  }
  let newestSrcMs = 0;
  for (const d of WATCH) newestSrcMs = Math.max(newestSrcMs, newestUnder(path.join(cwd || '.', d), 1, now));
  try {
    newestSrcMs = Math.max(newestSrcMs, fs.statSync(path.join(cwd || '.', 'atwo.mjs')).mtimeMs);
  } catch { /* 换个仓库就没有 atwo.mjs，不算错 */ }
  const ageMs = Math.max(0, now - dbMs);
  const stale = newestSrcMs > dbMs;
  return {
    exists,
    dbPath,
    indexedAt: dbMs,
    ageMs,
    newestSrcMs,
    stale,
    reason: stale ? '源码比图新（先跑 graft index）' : '新鲜',
  };
}

/** 一行给人看的图龄；给 selfcheck 与 cmdGo 的告警共用，避免两处说法不一致。 */
export function renderGraphAge(g, { now = Date.now() } = {}) {
  if (!g.exists) return '图龄：没有图库（六处融合里的三处会静默退化成旧行为）';
  const hours = g.ageMs === null ? null : g.ageMs / 3600000;
  const ageText = hours === null ? '未知' : hours < 1 ? Math.round(g.ageMs / 60000) + ' 分钟' : hours < 48 ? hours.toFixed(1) + ' 小时' : Math.round(hours / 24) + ' 天';
  if (!g.stale) return '图龄：' + ageText + '（新鲜）';
  const lagMin = Math.round(Math.max(0, g.newestSrcMs - g.indexedAt) / 60000);
  return '图龄：' + ageText + '，但源码比图新 ' + lagMin + ' 分钟 —— 先跑 graft index';
}
