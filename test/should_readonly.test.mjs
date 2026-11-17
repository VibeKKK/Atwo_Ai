// 热点文件的判据抓的是「文件名」，但同一个文件在「读它」和「改它」里是完全不同的事。
// 由来：2026-11-17 插件 atwo_fanout 传只读审计任务，文本里有 atwo.mjs / package.json，
// 直接被 should 判 self 拒掉（exit 3）—— 只读任务永远不会跟别人顶掉文件。
import assert from 'node:assert/strict';
import { shouldDelegate } from '../lib/should.mjs';

let pass = 0; let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); }
}

console.log('atwo should · 只读任务不因热点文件判 self');

await test('只读：提 atwo.mjs 但只是看 → 不再扣 3 分', () => {
  const r = shouldDelegate('看 atwo.mjs 的 table 有几个动词');
  assert.notEqual(r.verdict, 'self');
  assert.ok(r.score >= 0, 'score 应该不被扣：' + r.score);
  const s = r.signals.find((x) => x.key === 'hot-file-readonly');
  assert.ok(s, '要给出「只读不算冲突」这条判据');
  assert.equal(s.weight, 0);
});

await test('只读：审计两个热点文件 → 仍不判 self', () => {
  const r = shouldDelegate('审计 atwo.mjs 与 package.json 的 CI 配置是否完整');
  assert.notEqual(r.verdict, 'self');
});

await test('写：改 atwo.mjs → 仍然 self，扣 3 分那套不变', () => {
  const r = shouldDelegate('改 atwo.mjs 的 done 闸门：accept 从只在 relatedFiles 时跑改成有产物必须跑');
  assert.equal(r.verdict, 'self');
  const s = r.signals.find((x) => x.key === 'hot-file');
  assert.ok(s, '写动作必须保留 hot-file 惩罚');
  assert.equal(s.weight, -3);
});

await test('读写都提 → 按写算（模糊文本从紧）', () => {
  const r = shouldDelegate('看 atwo.mjs 然后把里面的 EXIT 表加上退出码 7');
  assert.ok(r.signals.some((x) => x.key === 'hot-file'), '有写动作就不许免罚');
});

await test('完全不提动作 → 从紧（不因为找不到写动词就放行）', () => {
  const r = shouldDelegate('atwo.mjs 的 fanout 部分');
  assert.ok(r.signals.some((x) => x.key === 'hot-file'), '判据不许靠猜：没读也没写就按冲突算');
});

await test('非热点文件不受影响', () => {
  const r = shouldDelegate('看 lib/writeback.mjs 的 readOnly 分支');
  assert.ok(!r.signals.some((x) => /hot-file/.test(x.key)));
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);