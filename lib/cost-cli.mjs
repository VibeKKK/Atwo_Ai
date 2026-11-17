// atwo cost —— 读 memory/cost.jsonl 的每任务账。
import { readCost, summarizeCost, formatCost, COST_CONTRACT } from './taskcost.mjs';

export function makeCostVerb({ EXIT, RESULT, HERE, die }) {
  return async function cmdCost(argv) {
    const sinceIdx = argv.indexOf('--since');
    const since = sinceIdx >= 0 ? String(argv[sinceIdx + 1] || '') : '';
    const r = readCost(HERE);
    if (!r.ok) die('读不到账本：' + r.reason, EXIT.precondition);
    const s = summarizeCost(r.records, since ? { since } : {});
    RESULT.data = { contract: COST_CONTRACT, corrupt: r.corrupt, since: since || null, summary: s };
    console.log(formatCost(s));
    if (r.corrupt) console.log('（坏行 ' + r.corrupt + ' 条已跳过）');
    return EXIT.ok;
  };
}
