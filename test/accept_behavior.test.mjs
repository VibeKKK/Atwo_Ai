// accept 的第五层：行为用例
//
// 这一层存在的唯一理由：2026-11-16 那天，一份四层全过的产物
// 在「输入 17 个问题」时输出「共列出 0 个问题」。
// 形状、语法、行数、导出名一个都没拦住它。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accept } from '../packages/accept/index.mjs';

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass++; } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-beh-'));
const w = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body, 'utf8'); return p; };

// 被测模块：一个「少数了」的函数（就是那次真事故的缩小版）
const goodMod = w('good.mjs', `
export function count(rec) {
  if (typeof rec.n === 'number') return rec.n;
  if (Array.isArray(rec.n)) return rec.n.length;
  return null;
}
`);
const badMod = w('bad.mjs', `
export function count(rec) {
  return Array.isArray(rec.n) ? rec.n.length : null;
}
`);

// 1. 全过的用例集
const casesGood = w('c1.mjs', `export const cases = [
  { name: '数字要能被读到', call: (m) => m.count({ n: 17 }), expect: 17 },
  { name: '数组要能算长度', call: (m) => m.count({ n: [1,2,3] }), expect: 3 },
  { name: '没值返回 null', call: (m) => m.count({}), expect: null },
];`);

const r1 = accept(goodMod, { behave: casesGood });
ok('好产物 + 全过用例 → 行为层过', r1.layers.behavior.ok === true, JSON.stringify(r1.layers.behavior));
ok('行为层报出总数', r1.layers.behavior.total === 3, String(r1.layers.behavior.total));

// 2. 同一份用例集，换坏产物
const r2 = accept(badMod, { behave: casesGood });
ok('坏产物 → 行为层不过', r2.layers.behavior.ok === false);
ok('坏产物 → 判定 FAIL', r2.verdict === 'FAIL');
ok('坏产物 → 指出「数字要能被读到」这条挂了', r2.layers.behavior.notes.some((n) => n.includes('数字要能被读到')), JSON.stringify(r2.layers.behavior.notes));
// badMod 只挂第一条（{n:17} 返回 null），数组和空值都碰巧对 → 2/3
ok('坏产物 → 报出 2/3 通过', r2.layers.behavior.passed === 2, String(r2.layers.behavior.passed));

// 3. expect 的三种写法
const casesForms = w('c2.mjs', `export const cases = [
  { name: '函数形式', call: (m) => m.count({ n: 5 }), expect: (v) => v === 5 },
  { name: '正则形式', call: (m) => '问题数 5', expect: /5/ },
  { name: '值形式', call: (m) => m.count({ n: [1,2] }), expect: 2 },
];`);
const r3 = accept(goodMod, { behave: casesForms });
ok('expect 支持函数 / 正则 / 值三种写法', r3.layers.behavior.ok === true, JSON.stringify(r3.layers.behavior.notes));

// 4. 抛错不算崩溃，算结果
const casesThrow = w('c3.mjs', `export const cases = [
  { name: '抛错也能被断言', call: () => { throw new TypeError('boom'); }, expect: (v, err) => !!err && /boom/.test(err.message) },
  { name: '抛错用正则也能匹配', call: () => { throw new RangeError('too big'); }, expect: /too big/ },
];`);
const r4 = accept(goodMod, { behave: casesThrow });
ok('抛错被当成结果交给 expect', r4.layers.behavior.ok === true, JSON.stringify(r4.layers.behavior.notes));

// 5. 用例文件本身有问题 → 说人话，不许假装通过
const casesBroken = w('c4.mjs', 'export const cases = [ oops');
const r5 = accept(goodMod, { behave: casesBroken });
ok('用例文件语法坏 → 不过', r5.layers.behavior.ok === false);
ok('用例文件语法坏 → 提示是「用例文件本身有问题」', /用例文件本身有问题|没吐 JSON|用例进程/.test((r5.layers.behavior.notes || []).join(' ')), JSON.stringify(r5.layers.behavior.notes));

const casesEmpty = w('c5.mjs', 'export const cases = [];');
const r6 = accept(goodMod, { behave: casesEmpty });
ok('空用例集 → 不过（不能空跑就算过）', r6.layers.behavior.ok === false, JSON.stringify(r6.layers.behavior.notes));

const casesNoExport = w('c6.mjs', 'export const nope = 1;');
const r7 = accept(goodMod, { behave: casesNoExport });
ok('用例文件没导出 cases → 不过', r7.layers.behavior.ok === false);

const r8 = accept(goodMod, { behave: path.join(dir, 'nope.mjs') });
ok('用例文件不存在 → 不过', r8.layers.behavior.ok === false);

// 6. 不传 behave 就不执行（默认行为完全不变）
const r9 = accept(goodMod, {});
ok('不传 behave → 没有行为层', r9.layers.behavior === undefined);
// 没给 lines/exports/spec 时只有 shape + syntax 两层，custom 不会凭空出现
ok('不传 behave → 只剩 shape/syntax', Object.keys(r9.layers).join(',') === 'shape,syntax', JSON.stringify(Object.keys(r9.layers)));

// 7. 被测文件不存在 → 行为层不去猜
const r10 = accept(path.join(dir, 'ghost.mjs'), { behave: casesGood });
ok('产物不存在 → 连形状层都不过', r10.verdict === 'FAIL' && r10.layers.shape.ok === false);

// 8. formatReport 里「行为」有中文名且带分数
const { formatReport } = await import('../packages/accept/index.mjs');
const txt = formatReport(r1);
ok('报告里有「行为」两个字', txt.includes('行为'), txt);
ok('报告里带 3/3 通过', txt.includes('3/3'), txt);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
