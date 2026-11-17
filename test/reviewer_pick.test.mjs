// test/reviewer_pick.test.mjs —— 默认父审必须来自台账，而不是写死的 codebuddy
// 起因（2026-11-17）：`fanout-run.mjs` 里 `const reviewLane = opts.reviewLane || (opts.ask ? 'injected' : 'codebuddy')`
// 一行写死，导致台账里明明记着「哪几条通道真当过父审」，评审却永远落在同源通道上。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickReviewLane } from '../lib/fanout-run.mjs';
import { appendEntry, ledgerPath } from '../lib/reviewer-ledger.mjs';

let pass = 0; let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`✓ ${name}`); } else { fail++; console.log(`✗ ${name}${extra ? ' —— ' + extra : ''}`); }
}

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-pick-'));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const H = 3600 * 1000;
const seed = (dir, lane, { ok: okFlag = true, ago = H, source = 'fanout', ms = 20000, n = 4 } = {}) => {
  for (let i = 0; i < n; i++) {
    appendEntry(dir, { lane, ok: okFlag, ms, reason: okFlag ? null : 'stub', chunks: 3, source, ts: iso(ago) });
  }
};

// 1) 空台账 → 退回 codebuddy（这是唯一允许的写死）
const d1 = mk();
ok(pickReviewLane(d1) === 'codebuddy', '台账为空时退回 codebuddy（不让推荐变成不确定行为）');

// 2) 有一条真跑验过、且更快的异源通道 → 选它，而不是 codebuddy
const d2 = mk();
seed(d2, 'trae', { ago: 2 * H, ms: 8000 });
seed(d2, 'codebuddy', { ago: 2 * H, ms: 60000 });
ok(pickReviewLane(d2) === 'trae', '台账里有更快的真跑验过通道时选它（不再恒 codebuddy）', pickReviewLane(d2));

// 3) 唯一可用的那条已经过期（>24h）→ 视为没有记录，退回 codebuddy
const d3 = mk();
seed(d3, 'ollama', { ago: 30 * H, ms: 5000 });
seed(d3, 'codebuddy', { ago: 30 * H, ms: 60000 });
ok(pickReviewLane(d3) === 'codebuddy', '超过 24 小时的旧记录不作为推荐依据（模型可能已被删）', pickReviewLane(d3));

// 4) 通道连续失败（dead）→ 不能推荐
const d4 = mk();
seed(d4, 'workbuddy', { ok: false, ago: 1 * H, n: 5 });
seed(d4, 'codebuddy', { ago: 1 * H, ms: 60000, n: 4 });
const got4 = pickReviewLane(d4);
ok(got4 === 'codebuddy', '连续失败的通道不会被推荐当父审', got4);

// 5) 台账文件里混入坏行 → 不抛，仍能给结论
//    可用性判据是「最近 5 次里至少 3 次成功」，所以这里给 3 条好行 + 1 条坏行：
//    坏行被跳过，3 条好行仍够「可用」。
const d5 = mk();
fs.mkdirSync(path.dirname(ledgerPath(d5)), { recursive: true });
const goodLine = JSON.stringify({ v: 1, contract: 'atwo-reviewer-ledger/1', lane: 'trae', ok: true, ms: 9000, source: 'fanout', ts: iso(1 * H) });
for (let i = 0; i < 3; i++) fs.appendFileSync(ledgerPath(d5), goodLine + '\nnot-json\n');
let threw = null;
let got5 = null;
try { got5 = pickReviewLane(d5); } catch (e) { threw = e; }
ok(!threw, '台账里有坏行时不抛（旁证不该把派活搞挂）', threw && threw.message);
ok(got5 === 'trae', '坏行被跳过，3 条好行仍凑够可用（trae 胜出）', String(got5));

// 6) 探活记录（source=probe）也算证据，但真跑过的优先
const d6 = mk();
seed(d6, 'trae', { ago: 1 * H, ms: 4000, source: 'probe' });
seed(d6, 'doubao', { ago: 1 * H, ms: 30000, source: 'fanout' });
const got6 = pickReviewLane(d6);
ok(got6 === 'doubao', '真跑验过优先于只探活过（哪怕它更慢）', got6);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
