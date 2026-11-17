/**
 * 把 graft 的图用在「验收」这一步，而不是只用在新功能里。
 *
 * 原来的验收只看「产物在不在 + 语法过不过」。这有两类漏网：
 *   1) 产物在、语法过，但把别人依赖的函数改坏了 —— 语法闸看不出来；
 *   2) 改的是一个 35 处依赖的文件，却一个测试都没跑就说「完成」。
 *
 * 这里不自己发明测试选择：直接读 graft 建好的图（`.graft/graft.db`），
 * 用 closure ⋈ tests 得出「这次改动会影响哪些测试文件」，然后只跑那些。
 *
 * 三个刻意的边界：
 *   - 没有图就没有结论（返回 skipped:'no-graph'），不假装跑过；
 *   - 选中文件太多就放弃（默认 >12 个），跑全量测试不是「验收」，是把人拖住；
 *   - 只跑 node --test，不解析覆盖率 —— 我们只需要「有没有红」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const DB_REL = path.join('.graft', 'graft.db');

export function graphDbPath(cwd) {
  const p = path.join(cwd || process.cwd(), DB_REL);
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * 哪些测试文件会被这些改动影响（含它们自己就是测试文件的情况）。
 * 返回 {files, total, db}；没有图时 files=[] 且 db=null。
 */
export function testsAffected(cwd, changed, { max = 200 } = {}) {
  const db = graphDbPath(cwd);
  if (!db) return { files: [], total: 0, db: null };

  const out = new Set();
  try {
    const conn = new DatabaseSync(db, { readOnly: true });
    const q = conn.prepare('SELECT DISTINCT c.src AS src FROM closure c JOIN tests t ON t.file = c.src WHERE c.dst = ?');
    const isTest = conn.prepare('SELECT 1 AS hit FROM tests WHERE file = ? LIMIT 1');
    for (const f of changed || []) {
      const rel = String(f || '').replace(/\\/g, '/');
      if (!rel) continue;
      for (const row of q.all(rel)) if (row && row.src) out.add(String(row.src));
      if (isTest.get(rel)) out.add(rel);
    }
    conn.close();
  } catch {
    return { files: [], total: 0, db };
  }
  const files = [...out].sort();
  return { files: files.slice(0, max), total: files.length, db };
}

/**
 * 真跑一遍受影响的测试。只跑选中的文件，逐个超时都算失败。
 * 返回 {ran, files, passed, failed, ms, skipped, ok}
 */
export function runAffectedTests(cwd, changed, { timeoutMs = 120000, maxFiles = 12 } = {}) {
  const t0 = Date.now();
  const pick = testsAffected(cwd, changed, { max: maxFiles + 1 });
  if (!pick.db) return { ran: 0, files: [], passed: 0, failed: 0, ms: 0, skipped: 'no-graph', ok: null };
  if (!pick.total) return { ran: 0, files: [], passed: 0, failed: 0, ms: 0, skipped: 'no-tests', ok: null };
  if (pick.total > maxFiles) {
    return { ran: 0, files: pick.files, passed: 0, failed: 0, ms: 0, skipped: 'too-many', ok: null };
  }
  const env = { ...process.env };
  // 嵌套跑测试时子进程会继承测试上下文，`node --test` 的汇总行就不打印了，解析器会读到 0/0。
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', ...pick.files], {
    cwd: cwd || process.cwd(),
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const text = String(r.stdout || '') + String(r.stderr || '');
  const num = (key) => {
    const m = text.match(new RegExp('(?:ℹ|#)\\s*' + key + '\\s+(\\d+)'));
    return m ? Number(m[1]) : null;
  };
  const passed = num('pass') || 0;
  const failed = num('fail');
  const timedOut = r.error && String(r.error.code || '') === 'ETIMEDOUT';
  const failCount = failed === null ? (r.status === 0 ? 0 : pick.files.length) : failed;
  return {
    ran: pick.files.length,
    files: pick.files,
    passed,
    failed: failCount,
    ms: Date.now() - t0,
    skipped: timedOut ? 'timeout' : null,
    ok: timedOut ? false : failCount === 0,
  };
}

/** 一行回执：跑了几个、过几个、红几个。 */
export function renderTests(t) {
  if (!t) return '测试：没跑';
  if (t.skipped === 'no-graph') return '测试：没跑（这个仓库还没有 graft 图）';
  if (t.skipped === 'no-tests') return '测试：没跑（改动没波及任何测试文件）';
  if (t.skipped === 'too-many') return '测试：没跑（波及 ' + t.files.length + '+ 个测试文件，超过上限；要跑请手动指定）';
  if (t.skipped === 'timeout') return '测试：超时（' + t.ran + ' 个文件没跑完）';
  const mark = t.ok ? '✓' : '✗';
  return '测试：' + mark + ' 跑 ' + t.ran + ' 个文件 · 过 ' + t.passed + ' · 红 ' + t.failed + ' · ' + Math.round(t.ms / 1000) + 's';
}
