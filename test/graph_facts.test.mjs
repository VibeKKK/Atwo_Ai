/**
 * 波及面事实（graph-facts）与它在父审提示里的呈现。
 *
 * 守两件事：
 * 1. 数字口径必须与 graft 的 impact 一致（同一份事实不能有两个答案）；
 * 2. 没有图的时候必须安静地退场 —— 不能因为没装 graft 就报错或往提示词里塞空段。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { impactFacts, impactTextFor, pickFilesFrom, renderImpactFacts } from '../lib/graph-facts.mjs';
import { buildReviewPrompt } from '../lib/fanout.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-impact-'));
const dbDir = path.join(tmp, '.graft');
fs.mkdirSync(dbDir, { recursive: true });

function makeDb() {
  const file = path.join(dbDir, 'graft.db');
  try { fs.rmSync(file, { force: true }); } catch { /* 首次没有 */ }
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT)');
  db.exec('CREATE TABLE edges (src TEXT, dst TEXT, external INTEGER)');
  db.exec('CREATE TABLE closure (src TEXT, dst TEXT, depth INTEGER)');
  db.exec('CREATE TABLE tests (file TEXT, runner TEXT)');
  const f = db.prepare('INSERT INTO files (path) VALUES (?)');
  for (const p of ['lib/a.mjs', 'lib/b.mjs', 'lib/c.mjs', 'test/a.test.mjs', 'lib/lonely.mjs']) f.run(p);
  const e = db.prepare('INSERT INTO edges (src, dst, external) VALUES (?, ?, 0)');
  e.run('lib/b.mjs', 'lib/a.mjs');
  e.run('lib/c.mjs', 'lib/a.mjs');
  e.run('test/a.test.mjs', 'lib/a.mjs');
  e.run('lib/c.mjs', 'lib/b.mjs');
  const c = db.prepare('INSERT INTO closure (src, dst, depth) VALUES (?, ?, ?)');
  c.run('lib/a.mjs', 'lib/a.mjs', 0);
  // closure 的方向是（依赖者 → 被依赖）：dependsOn(src=我) 走 dst，dependedBy(dst=我) 走 src。
  c.run('lib/b.mjs', 'lib/a.mjs', 1);
  c.run('lib/c.mjs', 'lib/a.mjs', 2);
  c.run('test/a.test.mjs', 'lib/a.mjs', 1);
  c.run('lib/b.mjs', 'lib/b.mjs', 0);
  c.run('lib/lonely.mjs', 'lib/lonely.mjs', 0);
  db.prepare('INSERT INTO tests (file, runner) VALUES (?, ?)').run('test/a.test.mjs', 'node');
  db.close();
  return file;
}

// ---- pickFilesFrom ----
const picked = pickFilesFrom([
  'EVIDENCE: lib/a.mjs:12 这一行是导出的入口',
  'ANSWER: 我改了 ./lib/b.mjs 和 D:/x/lib/c.mjs',
  'lib/a.mjs:99 重复出现不该再算一次',
]);
ok(picked.includes('lib/a.mjs') && picked.includes('lib/b.mjs'), '取出相对路径（a、b）');
ok(picked.filter((p) => p === 'lib/a.mjs').length === 1, '重复路径只留一次');
ok(!picked.some((p) => p.startsWith('D:') || p.startsWith('/')), '绝对路径整条跳过，不混进相对路径里');
ok(pickFilesFrom(['a.mjs b.mjs c.mjs d.mjs'], { maxFiles: 2 }).length === 2, 'maxFiles 生效');

// ---- 没有库：安静退场 ----
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-nograph-'));
ok(impactFacts(emptyDir, ['lib/a.mjs']).length === 0, '没有 graft 库时返回空数组');
ok(impactTextFor(emptyDir, ['lib/a.mjs:1']) === '', '没有库时影响面文本是空串');

// ---- 有库：数字要对 ----
makeDb();
const facts = impactFacts(tmp, ['lib/a.mjs']);
ok(facts.length === 1, '查到一条事实');
ok(facts[0].dependents === 3, 'lib/a.mjs 被 3 个文件依赖（b、c、test）实际 ' + facts[0]?.dependents);
ok(facts[0].tests === 1, 'lib/a.mjs 有 1 个测试覆盖 实际 ' + facts[0]?.tests);
const lonely = impactFacts(tmp, ['lib/lonely.mjs']);
ok(lonely.length === 0, '没人依赖的文件不占注意力');
ok(impactFacts(tmp, ['lib/a.mjs', 'lib/b.mjs'], { limit: 1 }).length === 1, 'limit 生效');

// ---- 渲染 ----
const text = renderImpactFacts(facts);
ok(text.includes('lib/a.mjs：被 3 个文件依赖、1 个测试覆盖'), '文案含准确数字：' + text);
ok(renderImpactFacts([]) === '', '空事实渲染成空串');
const noTest = renderImpactFacts([{ file: 'lib/z.mjs', dependents: 2, tests: 0 }]);
ok(noTest.includes('没有测试覆盖'), '零覆盖要说清楚，不能留空');

// ---- ATWO_GRAPH=0 关机开关 ----
const before = process.env.ATWO_GRAPH;
process.env.ATWO_GRAPH = '0';
ok(impactFacts(tmp, ['lib/a.mjs']).length === 0, 'ATWO_GRAPH=0 时彻底关掉');
if (before === undefined) delete process.env.ATWO_GRAPH; else process.env.ATWO_GRAPH = before;

// ---- 接进父审提示 ----
const kids = [{ id: 1, lane: 'codebuddy', answer: '改好了', evidence: 'lib/a.mjs:12 是入口' }];
const withImpact = buildReviewPrompt('改 lib/a.mjs', kids, '', '', text);
const without = buildReviewPrompt('改 lib/a.mjs', kids, '', '', '');
ok(withImpact.includes('这次改动波及谁'), '有事实时提示里出现波及面段');
ok(withImpact.includes('被 3 个文件依赖'), '段里带具体数字');
ok(!without.includes('这次改动波及谁'), '没有事实时不留空段');
ok(withImpact.includes('## 你有核对权（必须用）'), '原核对权段仍在（没有被顶掉）');

// ---- impactTextFor 一步到位 ----
ok(impactTextFor(tmp, ['证据：lib/a.mjs:12']).includes('被 3 个文件依赖'), 'impactTextFor 能一步出文本');
ok(impactTextFor(tmp, ['完全没提文件']).length === 0, '文本里没文件时给空串');

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(emptyDir, { recursive: true, force: true });
console.log('');
console.log('graph_facts: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
