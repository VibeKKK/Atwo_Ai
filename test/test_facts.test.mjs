/**
 * 验收吃测试：改动的波及面 × graft 图 → 只跑受影响的测试文件。
 *
 * 这组断言守的是四个边界，不是「能不能跑通」：
 * 没图不假装跑过、没波及不瞎跑、波及太多不硬跑、真跑时能分辨红与绿。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { graphDbPath, renderTests, runAffectedTests, testsAffected } from '../lib/test-facts.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name); }
};

// ---- 造一个假仓库：lib/a.mjs ← lib/b.mjs ← test/b.test.mjs ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-testfacts-'));
fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
fs.mkdirSync(path.join(root, 'test'), { recursive: true });
fs.mkdirSync(path.join(root, '.graft'), { recursive: true });
fs.writeFileSync(path.join(root, 'lib', 'a.mjs'), 'export const a = 1;\n', 'utf8');
fs.writeFileSync(path.join(root, 'lib', 'b.mjs'), "import { a } from './a.mjs';\nexport const b = a + 1;\n", 'utf8');
fs.writeFileSync(path.join(root, 'test', 'b.test.mjs'), "import { b } from '../lib/b.mjs';\nif (b !== 2) process.exit(1);\n", 'utf8');

const db = new DatabaseSync(path.join(root, '.graft', 'graft.db'));
db.exec('CREATE TABLE tests (file TEXT); CREATE TABLE closure (src TEXT, dst TEXT, depth INTEGER);');
db.exec("INSERT INTO tests (file) VALUES ('test/b.test.mjs')");
db.exec("INSERT INTO closure (src, dst, depth) VALUES ('lib/b.mjs','lib/a.mjs',1)");
db.exec("INSERT INTO closure (src, dst, depth) VALUES ('test/b.test.mjs','lib/b.mjs',1)");
// closure 表存的是**传递**闭包（graft buildClosure 逐层展开），所以深度 2 的行必须存在 ——
// 只插直接边的话，across 两跳的测试就查不出来了（第一版测试就栽在这里）。
db.exec("INSERT INTO closure (src, dst, depth) VALUES ('test/b.test.mjs','lib/a.mjs',2)");
db.close();

// ---- 有图 ----
ok(graphDbPath(root) !== null, '找得到 .graft/graft.db');
const aff = testsAffected(root, ['lib/a.mjs']);
ok(aff.total === 1 && aff.files[0] === 'test/b.test.mjs', '改 lib/a.mjs 会波及 test/b.test.mjs（传递闭包，实际 ' + JSON.stringify(aff.files) + '）');
ok(testsAffected(root, ['lib/nothing.mjs']).total === 0, '没人依赖的文件不波及任何测试');
ok(testsAffected(root, []).total === 0, '不改东西就不波及');

const ran = runAffectedTests(root, ['lib/a.mjs'], { timeoutMs: 60000, maxFiles: 5 });
ok(ran.ran === 1 && ran.ok === true && ran.failed === 0, '真跑一个通过的测试：ok（实际 ' + JSON.stringify(ran).slice(0, 90) + '）');
ok(renderTests(ran).includes('✓'), '回执带绿标（' + renderTests(ran) + '）');

// ---- 红的情形 ----
fs.writeFileSync(path.join(root, 'test', 'b.test.mjs'), "import { b } from '../lib/b.mjs';\nif (b !== 999) process.exit(1);\n", 'utf8');
const red = spawnSync(process.execPath, ['--test', 'test/b.test.mjs'], { cwd: root, encoding: 'utf8' });
const redRan = runAffectedTests(root, ['lib/a.mjs'], { timeoutMs: 60000, maxFiles: 5 });
ok(red.status !== 0, '（前提）这个测试确实是红的');
ok(redRan.ok === false && redRan.failed >= 1, '红测试被判失败，不当成跑过（实际 ' + JSON.stringify({ failed: redRan.failed, ok: redRan.ok }) + '）');
ok(renderTests(redRan).includes('✗'), '回执带红标');

// ---- 上限与无图 ----
const many = runAffectedTests(root, ['lib/a.mjs'], { timeoutMs: 60000, maxFiles: 0 });
ok(many.skipped === 'too-many', '上限为 0 时放弃跑，说明原因（实际 ' + many.skipped + '）');
const noGraphRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-nograph-'));
ok(graphDbPath(noGraphRoot) === null, '没图的仓库返回 null');
const ng = runAffectedTests(noGraphRoot, ['lib/a.mjs']);
ok(ng.skipped === 'no-graph' && ng.ok === null, '没图时不假装跑过（ok=null，实际 ' + JSON.stringify(ng.skipped) + '）');
ok(renderTests(ng).includes('还没有 graft 图'), '回执说清楚为什么没跑');

const nt = runAffectedTests(root, ['lib/nothing.mjs'], { timeoutMs: 60000 });
ok(nt.skipped === 'no-tests', '没波及任何测试时不瞎跑（实际 ' + nt.skipped + '）');

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(noGraphRoot, { recursive: true, force: true });
console.log('');
console.log('test_facts: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
