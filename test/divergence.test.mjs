// lib/divergence.mjs 的边界测试。
// 每条对着一件真事：字面值炸成九个选项、单行为被当成决策点、多选项给不出推荐。
import { groupByBehavior, mergeDecisions, splitByBehavior, renderDecisions } from '../lib/divergence.mjs';

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

// 两个假产物：一个保留负号、一个夹成 0
const keepSign = { formatBytes: (n) => (n < 0 ? '-1 KB' : '0 B'), formatDuration: (n) => (n < 0 ? '-00:01:30' : '0秒') };
const clampZero = { formatBytes: () => '0 B', formatDuration: () => '0秒' };
const products = [{ agent: 'keep', fn: keepSign }, { agent: 'clamp', fn: clampZero }];

const cases = [
  { name: 'formatBytes 负数 -1024', call: (m) => m.formatBytes(-1024) },
  { name: 'formatDuration 负数 -90000', call: (m) => m.formatDuration(-90000) },
];

// 1. 逐用例按字面分组：-1 KB 与 -00:01:30 本来就不同
const r1 = groupByBehavior(products, cases);
ok('两个用例都有字面分歧', r1.divergences.length === 2, r1.divergences.length);
ok('每组都带 behavior 标签', r1.divergences.every((d) => d.groups.every((g) => typeof g.behavior === 'string')));

// 2. 关键：字面不同的「保留负号」要归成同一个行为
const behaviors = r1.divergences
  .flatMap((d) => d.groups.filter((g) => g.agents.includes('keep')).map((g) => g.behavior));
ok('两种负号写法都归成保留负号', behaviors.every((b) => b === '保留负号'), behaviors.join(','));

// 3. 两步归并：先按「函数名 + 议题」分桶，再把「同议题 + 同推荐答案」的桶合成一个决策点。
//    formatBytes 与 formatDuration 的负数都推荐「保留负号」—— 对提问的人是同一个问题，问一次。
//    （旧版只按函数名分桶，于是同一个问题被问三遍，A4 的「≤3 个决策点」就永远过不了）
const s = splitByBehavior(r1.divergences);
ok('两个函数同议题同行为集合 → 合成一个决策点', s.decisions.length === 1, s.decisions.length);
ok('决策点的 scope 列出两个函数', s.decisions[0].scope === 'formatBytes / formatDuration', s.decisions[0].scope);
ok('covers 两个用例都在', s.decisions[0].covers.length === 2, s.decisions[0].covers.join(','));
ok('选项只有两个（保留负号 / 夹成 0）', s.decisions[0].options.length === 2, s.decisions[0].options.map((o) => o.behavior).join(','));
ok('推荐保留负号', s.decisions[0].recommend === 'A', s.decisions[0].recommend);
ok('每条选项带例子', s.decisions[0].options.every((o) => Array.isArray(o.examples) && o.examples.length > 0));

// 3b. 同议题但推荐答案不同 → 不许合并，否则推荐语答非所问
//     （bytes 的负数是保留负号，percent 的负数是报错 —— 合成一个答案就把两边都教错了）
const mixed = [
  { agent: 'keep', fn: { formatBytes: () => '-1 KB', formatPercent: () => '0.00%' } },
  { agent: 'clamp', fn: { formatBytes: () => '0 B', formatPercent: () => { throw new TypeError('bad'); } } },
];
const r1b = groupByBehavior(mixed, [
  { name: 'formatBytes 负数 -1024', call: (m) => m.formatBytes(-1024) },
  { name: 'formatPercent 负数 -0.5', call: (m) => m.formatPercent(-0.5) },
]);
const sb = splitByBehavior(r1b.divergences);
ok('同议题但推荐答案不同 → 分成两个决策点', sb.decisions.length === 2, sb.decisions.length);
ok('两个决策点的选项集不同', sb.decisions[0].options.map((o) => o.behavior).join(',') !== sb.decisions[1].options.map((o) => o.behavior).join(','));
ok('两个决策点的推荐也不同', sb.decisions[0].recommend !== sb.decisions[1].recommend || sb.decisions[0].options[0].behavior !== sb.decisions[1].options[0].behavior);

// 4. 单行为不算决策点，但也不许静默丢
const sameBehavior = [
  { agent: 'a', fn: { f: () => '1h 1m 1s' } },
  { agent: 'b', fn: { f: () => '01:01:01' } },
];
const r2 = groupByBehavior(sameBehavior, [{ name: 'formatDuration 3661000', call: (m) => m.f(3661000) }]);
ok('字面不同即算分歧', r2.divergences.length === 1);
const s2 = splitByBehavior(r2.divergences);
ok('行为一致 → 不出决策点', s2.decisions.length === 0, s2.decisions.length);
ok('行为一致 → 进 formatOnly 不静默丢', s2.formatOnly.length === 1, s2.formatOnly.length);

// 5. 多选项也要给推荐（不能只认恰好两种）
const three = [
  { agent: 'a', fn: { f: () => { throw new TypeError('bad'); } } },
  { agent: 'b', fn: { f: () => '0 B' } },
  { agent: 'c', fn: { f: () => '—' } },
];
const r3 = groupByBehavior(three, [{ name: 'formatBytes 非数字 NaN', call: (m) => m.f(NaN) }]);
const s3 = splitByBehavior(r3.divergences);
ok('三种行为出一个决策点', s3.decisions.length === 1);
ok('三个选项', s3.decisions[0].options.length === 3, s3.decisions[0].options.length);
ok('多选项也给推荐（报错优先）', s3.decisions[0].recommend === 'A', s3.decisions[0].recommend);

// 6. 渲染：决策点 + 写法差异两节都在
const text = renderDecisions(s3.decisions, { formatOnly: s2.formatOnly });
ok('有决策点标题', text.includes('## D1'));
ok('有写法差异一节', text.includes('只是写法不同'));
ok('报错被翻成人话', /报错 TypeError/.test(text), text.slice(0, 120));

// 7. 一致时不假装有分歧
const same = groupByBehavior([{ agent: 'a', fn: { f: () => 'x' } }, { agent: 'b', fn: { f: () => 'x' } }], [{ name: 'x', call: (m) => m.f() }]);
ok('完全一致时无分歧', same.divergences.length === 0);
ok('无分歧时渲染给出明确结论', /没有需要你拍板的分歧/.test(renderDecisions([], {})));

// 8. 脏输入一律不抛
const dirty = [null, undefined, 0, 'x', [], {}, { groups: 'x' }];
let threw = null;
for (const d of dirty) {
  try {
    mergeDecisions(d);
    renderDecisions(d);
    splitByBehavior(d);
    groupByBehavior(d, d);
  } catch (err) { threw = err; break; }
}
ok('八种脏输入不抛异常', threw === null, threw && threw.message);

// 9. A4 回归：par7 那四份真产物的行为分布（_probe/decisions.json 同源），决策点必须 ≤3。
//    这是「一次批量汇总只问人 ≤3 个问题」这条判据的锁；旧版归并键只认函数名时这里是 4。
const mk = (name, groups) => ({ case: name, groups });
const par7 = [
  mk('formatBytes 负数 -1024', [{ mark: '-1 KB', agents: ['trae', 'workbuddy', 'codebuddy'] }, { mark: '0 B', agents: ['doubao'] }]),
  mk('formatBytes 非数字 NaN', [{ mark: '0 B', agents: ['trae'] }, { mark: 'throw:TypeError', agents: ['doubao', 'workbuddy'] }, { mark: '—', agents: ['codebuddy'] }]),
  mk('formatBytes 字符串 "2048"', [{ mark: '2 KB', agents: ['trae'] }, { mark: 'throw:TypeError', agents: ['doubao', 'workbuddy'] }, { mark: '—', agents: ['codebuddy'] }]),
  mk('formatDuration 负数 -90000', [{ mark: '-00:01:30', agents: ['trae'] }, { mark: '0秒', agents: ['doubao'] }, { mark: '-1m 30s', agents: ['codebuddy'] }]),
  mk('formatDuration NaN', [{ mark: '00:00:00', agents: ['trae'] }, { mark: 'throw:TypeError', agents: ['doubao', 'workbuddy'] }, { mark: '—', agents: ['codebuddy'] }]),
  mk('formatPercent 负数 -0.5', [{ mark: '0.00%', agents: ['trae'] }, { mark: 'throw:TypeError', agents: ['doubao', 'workbuddy'] }, { mark: '—', agents: ['codebuddy'] }]),
  mk('formatPercent NaN', [{ mark: '0.00%', agents: ['trae'] }, { mark: 'throw:TypeError', agents: ['doubao', 'workbuddy'] }, { mark: '—', agents: ['codebuddy'] }]),
];
const sp = splitByBehavior(par7);
const shape = sp.decisions.map((d) => d.scope + '·' + d.topic).join(' / ');
ok('A4 回归：par7 四份产物决策点 ≤3', sp.decisions.length <= 3, sp.decisions.length + '：' + shape);
ok('A4 回归：恰好 3 个（旧版按函数名分桶是 4 个）', sp.decisions.length === 3, shape);
ok('A4 回归：bytes 与 duration 的负数合成一个决策点', sp.decisions.some((d) => d.scope === 'formatBytes / formatDuration' && d.topic === '负数' && d.covers.length === 2), shape);
ok('A4 回归：percent 的负数单独一个（推荐答案不同）', sp.decisions.some((d) => d.scope === 'formatPercent' && d.topic === '负数' && d.options.length === 3), shape);
ok('A4 回归：非法输入跨三个函数合成一个（推荐答案都是报错）', sp.decisions.some((d) => d.topic === '非法输入' && d.covers.length === 4 && d.scope.includes('formatPercent')), shape);
ok('A4 回归：每个决策点都给人话推荐与代价', sp.decisions.every((d) => d.recommend && d.why && d.cost));

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
