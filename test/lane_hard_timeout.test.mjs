// test/lane_hard_timeout.test.mjs —— 适配层不认 timeoutMs 时，外层必须自己到点认输
// 起因（2026-11-17 实测）：`atwo doctor --reviewers workbuddy` 300s 不返回，
// probeReviewer 传下去的 timeoutMs 只到适配层；它不理会 = 等于没有超时。
import { withHardTimeout } from '../lib/lanes.mjs';

let pass = 0; let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`✓ ${name}`); } else { fail++; console.log(`✗ ${name}${extra ? ' —— ' + extra : ''}`); }
}

const never = () => new Promise(() => {});
const t0 = Date.now();
const r1 = await withHardTimeout(never(), 120, 'workbuddy');
const ms1 = Date.now() - t0;
ok(r1.ok === false, '永不返回的 promise 会被判失败');
ok(/硬超时/.test(String(r1.err || '')), '理由里写明是硬超时', String(r1.err));
ok(/workbuddy/.test(String(r1.err || '')), '理由里带通道名（能一眼看出是谁吊住的）', String(r1.err));
ok(ms1 >= 100 && ms1 < 2000, `在 120ms 附近返回（实测 ${ms1}ms）`);

const okRes = await withHardTimeout(Promise.resolve({ ok: true, addedText: '答案' }), 5000, 'trae');
ok(okRes.ok === true && okRes.addedText === '答案', '正常返回原样透出（不篡改内容）');

const rej = await withHardTimeout(Promise.reject(new Error('boom')), 5000, 'doubao');
ok(rej.ok === false && /boom/.test(String(rej.err || '')), 'reject 被转成 ok:false 且保留原因', String(rej.err));
ok(/doubao/.test(String(rej.err || '')), 'reject 理由也带通道名');

const off = await withHardTimeout(Promise.resolve({ ok: true, addedText: 'x' }), 0, 'x');
ok(off.addedText === 'x', 'timeoutMs=0 表示不设超时（直接透出）');

// 语义细节：超时返回的 ok:false 必须能被上层区分出「超时」而不是「占位」
const looksPlaceholderLike = (r) => String(r.addedText || '').trim() === '';
ok(looksPlaceholderLike(r1) === true, '超时结果确实是空文本（所以上层必须靠 err 关键词短路，不能靠文本）');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
