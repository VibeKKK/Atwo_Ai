// test/durfmt.test.mjs —— fmtMs：人看的时长格式
// 产物由 atwo 派活写出（deepseek 通道，49.6s，2026-11-17），本文件只钉行为边界。
import { fmtMs } from '../lib/durfmt.mjs';

let pass = 0; let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`✓ ${name}`); } else { fail++; console.log(`✗ ${name}${extra ? ' —— ' + extra : ''}`); }
}

ok(fmtMs(0) === '0ms', '亚秒 0ms');
ok(fmtMs(850) === '850ms', '亚秒 850ms');
ok(fmtMs(999) === '999ms', '亚秒边界 999ms');
ok(fmtMs(1000) === '1.0s', '秒档下界 1000 → 1.0s');
ok(fmtMs(33300) === '33.3s', '秒档 33300 → 33.3s');
ok(fmtMs(59999) === '59.9s', '秒档上界必须截断，不许四舍五入成 60.0s');
ok(fmtMs(60000) === '1m00s', '分钟档下界 60000 → 1m00s');
ok(fmtMs(125000) === '2m05s', '分钟档秒补零 125000 → 2m05s');

for (const bad of [-1, NaN, Infinity, 'x', null, undefined]) {
  ok(fmtMs(bad) === '-', `非法输入 ${String(bad)} → -`);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
