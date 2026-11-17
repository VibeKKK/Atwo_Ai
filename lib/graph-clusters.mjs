/**
 * 从 graft 的图库里读依赖边，供切分器使用。
 *
 * 为什么不自己读源码：切分器本来就在读（正则那条路），但它只有「本次任务
 * 涉及的几个单元」的局部视角。graft 的库是全仓的、解析过的、带三态标记的——
 * 同一份事实没必要算两遍，而且两份算术迟早会给出两个答案。
 *
 * 读不到就返回 null，让调用方退回正则：图是加速器，不是硬依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SEP = '\u0000';

export function graphDbPath(cwd) {
  return path.join(cwd || process.cwd(), '.graft', 'graft.db');
}

/** 返回 { edges:Set, files:Set, db 路径 } 或 null（没有库 / 打不开 / 库里没边）。 */
export function loadGraph(cwd) {
  if (process.env.ATWO_GRAPH === '0') return null;
  const file = graphDbPath(cwd);
  if (!fs.existsSync(file)) return null;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const edges = new Set();
    for (const r of db.prepare('SELECT src, dst FROM edges WHERE external = 0').all()) {
      edges.add(r.src + SEP + r.dst);
    }
    const files = new Set(db.prepare('SELECT path FROM files').all().map((r) => r.path));
    if (!edges.size) return null;
    return { edges, files, file };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* 关不掉不影响结果 */ }
  }
}

/** 两个单元在图里有没有依赖（任一方向都算：切分要判的是「该不该一起改」）。 */
export function linked(graph, a, b) {
  if (!graph) return false;
  return graph.edges.has(a + SEP + b) || graph.edges.has(b + SEP + a);
}
