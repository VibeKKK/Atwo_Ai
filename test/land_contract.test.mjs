// 落盘契约（FILE: 块头）的本土化行为：显式契约优先，绝不靠猜。
// 背景：2026-11-16 一次真跑把 3858 字节的库写成了 memory/log.js ——
// 任务文本里同时写了「交付 lib/quota-log.mjs」和「写入 memory/log.jsonl」，
// detectTarget 正则先命中后者。aider 用显式 FILE 头 + 编辑块解决这个问题，这里照抄并本土化。
import assert from 'node:assert/strict';
import { splitByFileMarker, planLanding } from '../lib/land.mjs';

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '←', String(e.message).slice(0, 160)); fail++; }
}

const body = (n = 30) => Array.from({ length: n }, (_, i) => 'export const v' + i + ' = ' + i + ';').join('\n');

// ---------- 一、认得哪些块头 ----------
const forms = [
  ['// file: lib/a.mjs', 'lib/a.mjs', '行首 // file:'],
  ['# file: lib/b.py', 'lib/b.py', '行首 # file:（python 注释）'],
  ['/* file: lib/c.js */', 'lib/c.js', '块注释 /* file: */'],
  ['=== FILE: lib/d.mjs ===', 'lib/d.mjs', '=== FILE: ... ==='],
  ['--- FILE: docs/e.md ---', 'docs/e.md', '--- FILE: ... ---'],
  ['### FILE: test/f.test.mjs', 'test/f.test.mjs', 'markdown ### FILE:'],
  ['文件：lib/g.mjs', 'lib/g.mjs', '中文「文件：」'],
  ['路径: lib/h.json', 'lib/h.json', '中文「路径:」'],
];
for (const [head, want, label] of forms) {
  t('认得出 ' + label, () => {
    const r = splitByFileMarker(head + '\n' + body());
    assert.ok(r && r.length === 1, '应当解析出一段');
    assert.equal(r[0].target, want);
    assert.ok(r[0].code.includes('export const v0'));
  });
}

// ---------- 二、没有契约就是没有（交给猜测，并在报告里标 guessed） ----------
t('没有块头 → null', () => {
  assert.equal(splitByFileMarker('export const x = 1;\n'.repeat(20)), null);
});

// ---------- 三、★ 显式契约哪怕只有一段，也必须独占 ----------
t('单段显式契约独占：不采用任务文本里的路径', () => {
  const plan = planLanding([{
    id: 1, status: 'done',
    text: '交付 lib/quota-log.mjs，写入 memory/log.jsonl',
    output: '// file: lib/real-target.mjs\n' + body(),
  }], {});
  assert.equal(plan[0].target, 'lib/real-target.mjs', '必须用块头，不能用文本里先命中的 memory/log.jsonl');
  assert.notEqual(plan[0].target, 'memory/log.js');
});

// ---------- 四、多段：顺序、内容、互斥 ----------
t('两段 FILE: 各归各的，内容不串', () => {
  const r = splitByFileMarker(
    '// file: lib/one.mjs\n' + body(5) + '\n// file: test/two.test.mjs\n' + body(3)
  );
  assert.equal(r.length, 2);
  assert.equal(r[0].target, 'lib/one.mjs');
  assert.equal(r[1].target, 'test/two.test.mjs');
  assert.ok(r[0].code.includes('v0') && !r[0].code.includes('test/two'));
  assert.ok(r[1].code.includes('v0'));
});

t('同路径两个任务 → 后者被拒绝（防互相覆盖）', () => {
  const out = '// file: lib/same.mjs\n' + body();
  const plan = planLanding([
    { id: 1, status: 'done', text: '', output: out },
    { id: 2, status: 'done', text: '', output: out },
  ], {});
  assert.equal(plan[0].action !== 'skip', true, '第一个应当可以落盘');
  assert.equal(plan[1].action, 'skip');
  assert.ok(/目标路径相同/.test(plan[1].reason));
});

// ---------- 五、白名单照旧生效 ----------
t('目录不在白名单 → skip 并说明', () => {
  const plan = planLanding([{ id: 1, status: 'done', text: '', output: '// file: ../evil/x.mjs\n' + body() }], {});
  assert.equal(plan[0].action, 'skip');
});

t('扩展名不在白名单 → skip 并说明', () => {
  const plan = planLanding([{ id: 1, status: 'done', text: '', output: '// file: lib/x.exe\n' + body() }], {});
  assert.equal(plan[0].action, 'skip');
  assert.ok(/扩展名/.test(plan[0].reason));
});

// ---------- 六、内容太短不放行（残答防护） ----------
t('内容太短 → skip', () => {
  const plan = planLanding([{ id: 1, status: 'done', text: '', output: '// file: lib/tiny.mjs\nexport const x=1;' }], {});
  assert.equal(plan[0].action, 'skip');
  assert.ok(/太短/.test(plan[0].reason));
});

console.log('');
console.log('land_contract: ' + pass + ' passed / ' + fail + ' failed');
if (fail) process.exit(1);
