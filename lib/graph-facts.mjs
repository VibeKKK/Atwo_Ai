/**
 * 把 graft 的依赖图变成「评审时能直接引用的事实」。
 *
 * 为什么需要这个：父审现在只能看到子会话自己写的 EVIDENCE，而「你改的这个函数被
 * 35 个文件依赖、15 个测试覆盖」这类事实它无从得知 —— 于是它只能凭文本判断改动
 * 是否安全。这不是父审不聪明，是它没有数据。
 *
 * 三条设计约束：
 * 1. 只读、零依赖：直接开 graft 的 sqlite 库（Node 内置），不 spawn 子进程，不进模型。
 * 2. 读不到就返回空数组：图是加速器不是硬依赖，没有 graft 的仓库要能照常跑。
 * 3. 事实必须带出处口径：「被依赖 N 个」= 闭包里 dst 是我且 src 是我的不同文件数，
 *    与 `graft impact` 的口径完全一致 —— 两个工具给出两个数字比不给更坏。
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { graphDbPath } from './graph-clusters.mjs';

/** 从任意文本里抠出「看着像仓库相对路径」的文件名（带不带 :行号 都认）。 */
const FILE_RE = /([\w./-]+\.(?:mjs|js|cjs|ts|tsx|jsx|json|md|py|ya?ml|html|css))(?::\d+)?/g;

/** 去重、去绝对路径、按出现顺序保留。 */
export function pickFilesFrom(texts, { maxFiles = 8 } = {}) {
  const seen = new Set();
  const out = [];
  for (const t of texts || []) {
    for (const m of String(t || '').matchAll(FILE_RE)) {
      // 绝对路径（C:\… 或 /…）不属于仓库相对路径，图里也不会有它，直接跳过。
      if (m[1].charCodeAt(1) === 58 || m[1].startsWith('/')) continue;
      const rel = m[1].replace(/^[a-zA-Z]:[\\/]/, '').replace(/\\/g, '/').replace(/^\.\//, '');
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      out.push(rel);
      if (out.length >= maxFiles) return out;
    }
  }
  return out;
}

/**
 * 查每个文件的影响面。返回 [{ file, dependents, tests }]，只保留 dependents > 0 的
 * （0 个依赖者的文件没必要占评审的注意力）。
 */
export function impactFacts(cwd, files, { limit = 5 } = {}) {
  if (process.env.ATWO_GRAPH === '0') return [];
  const file = graphDbPath(cwd);
  if (!fs.existsSync(file)) return [];
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const depStmt = db.prepare('SELECT COUNT(DISTINCT src) AS c FROM closure WHERE dst = ? AND src <> ?');
    const testStmt = db.prepare(
      'SELECT COUNT(DISTINCT c.src) AS c FROM closure c JOIN tests t ON t.file = c.src WHERE c.dst = ?',
    );
    const isTest = db.prepare('SELECT 1 FROM tests WHERE file = ?');
    const out = [];
    for (const f of (files || []).slice(0, limit)) {
      const dependents = Number(depStmt.get(f, f)?.c || 0);
      if (!dependents) continue;
      // 自己就是测试文件时算 1 个（与 graft 的 testsFor 同口径）
      const tests = Number(testStmt.get(f)?.c || 0) + (isTest.get(f) ? 1 : 0);
      out.push({ file: f, dependents, tests });
    }
    return out;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* 关不掉不影响结果 */ }
  }
}

/** 人读/给模型读的一段文本；空数组返回空串，让调用方整段省略。 */
export function renderImpactFacts(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.dependents > 0) : [];
  if (!list.length) return '';
  const lines = list.map((r) => (
    '- ' + r.file + '：被 ' + r.dependents + ' 个文件依赖'
    + (r.tests ? '、' + r.tests + ' 个测试覆盖' : '、没有测试覆盖')
  ));
  return lines.join('\n');
}

/** 一步到位：从子会话文本取文件 → 查图 → 渲染。任何一步失败都返回空串。 */
export function impactTextFor(cwd, texts, opts = {}) {
  try {
    const files = pickFilesFrom(texts, opts);
    if (!files.length) return '';
    return renderImpactFacts(impactFacts(cwd, files, opts));
  } catch {
    return '';
  }
}
