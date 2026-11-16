// ledgerLine 的边界测试。
//
// 2026-11-16 与副总管定下 Q2 之后，契约变了：
//   · decision-log 只记人的判断（派给谁、为什么），**不写「已完成/已通过」，也不判定成败**
//   · 成败由 memory/log.jsonl（机器事实）+ accept 报告判定
// 所以这里的重点从「不许把失败说成成功」变成「**不许在这一行里下成败结论**」，
// 同时保留唯一的例外：日志里一条都没有 = 派活可能没开跑，这是人该看一眼的异常。
import { ledgerLine } from '../lib/ledger.mjs';

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

const task = { title: '把入口收成五个动词' };
const good = { time: '2026-11-16 00:17', agent: 'doubao', ok: true, elapsedMs: 189015, outputChars: 6824 };
const flat = (r) => r.args.join(' ');

// 1. 正常一条：不带标记，且不写成败
const a = ledgerLine({ task, entry: good, code: 0 });
ok('正常时不带 needs-you', a.mark === null, a.mark);
ok('正常时 abnormal=false', a.abnormal === false);
ok('不写「成功」这两个字', !/成功/.test(flat(a)), flat(a));
ok('明确指向 log.jsonl 作为成败依据', /以 memory\/log\.jsonl 最后一条为准/.test(flat(a)), flat(a));
ok('参数里有 --phase 派活', a.args[0] === 'add' && a.args.includes('派活'));
ok('证据是日志指针而不是散文', flat(a).includes('memory/log.jsonl 最后一条'), flat(a));

// 2. 退出码非 0：仍不下成败结论，但要点出退出码
const b = ledgerLine({ task, entry: good, code: 3 });
ok('退出码非 0 带 needs-you', b.mark === 'needs-you', b.mark);
ok('把退出码写进结果', /命令返回 3/.test(flat(b)), flat(b));
ok('退出码非 0 也不写「失败」定性', !/派活失败|判定失败/.test(flat(b)), flat(b));

// 3. 通道自己报错：指出原因在 log.jsonl，而不是替它下结论
const bad = { ...good, ok: false, error: 'CDP 被占用' };
const c = ledgerLine({ task, entry: bad, code: 0 });
ok('通道报错带 needs-you', c.mark === 'needs-you', c.mark);
ok('点出 ok=false 但不下判定', /ok=false/.test(flat(c)) && /本行不做成败判定/.test(flat(c)), flat(c));
ok('不把 error 原文当结论搬运', !/CDP 被占用/.test(flat(c)), flat(c));

// 4. 一条日志都没有：唯一允许下判断的异常
const d = ledgerLine({ task, entry: null, code: 0 });
ok('没有日志时带 needs-you', d.mark === 'needs-you', d.mark);
ok('没有日志时明说可能没开跑', /派活可能没真正开跑/.test(flat(d)), flat(d));
ok('没有日志时 abnormal=true', d.abnormal === true);

// 5. 任务名为空也不许崩
const e = ledgerLine({ task: {}, entry: good, code: 0 });
ok('任务名缺失时有兜底文案', flat(e).includes('（未命名任务）'), flat(e).slice(0, 120));

console.log(`ledger: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
