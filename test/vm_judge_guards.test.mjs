// file: test/vm_judge_guards.test.mjs
/**
 * @file test/vm_judge_guards.test.mjs
 * @description 第二步改造的四条判据 + 三条退化向量，钉死在测试里。
 *
 * 这份测试存在的理由：置信度公式的分母是全仓所有结论的根。改它的时候，
 * 「测试还是绿的」不代表没坏 —— 参数一变，一批原本「可判」的会变成「别判」，
 * 而旧断言只检查 value，看不出这种位移。所以这里检查的是**机制**：
 * 去重算几个证据、n=1 时 agreement 是否归零、到票率够不够、常量是不是真从契约来。
 *
 * 纪律：阈值一律从 vm/oracle-contract.json 读，本文件不写 0.45 / 0.22 / 0.8 字面量。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; failures.push(name + (detail ? '  → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

const contract = JSON.parse(fs.readFileSync(path.join(root, 'vm/oracle-contract.json'), 'utf8'));
const J = await load('vm/judge.mjs');
const V = await load('vm/votes.mjs');

// —— 1. 常量确实来自契约（不是代码里另写一份） ——
check('CUT.high 等于契约 cut.high', J.CUT.high === contract.cut.high, J.CUT.high + ' vs ' + contract.cut.high);
check('CUT.mid 等于契约 cut.mid', J.CUT.mid === contract.cut.mid, J.CUT.mid + ' vs ' + contract.cut.mid);
check('Z_LIMIT 等于契约 zLimit', J.Z_LIMIT === contract.zLimit, String(J.Z_LIMIT));
check('VOTE_ARITY 等于契约 votes.arity 且是正数', J.VOTE_ARITY === contract.votes.arity && J.VOTE_ARITY > 0, String(J.VOTE_ARITY));
check('契约显式声明了 votes.arity（不是靠代码兜底）', Object.prototype.hasOwnProperty.call(contract.votes, 'arity'));
check('votes.mjs 转出的 ARITY 与 judge 同源', V.ARITY === J.VOTE_ARITY, V.ARITY + ' vs ' + J.VOTE_ARITY);

// —— 2. 代码里不许出现阈值字面量 ——
// 剥掉注释再扫：注释里写明「不再写 0.45」本身不该算违规。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const srcJudge = stripComments(fs.readFileSync(path.join(root, 'vm/judge.mjs'), 'utf8'));
const srcVotes = stripComments(fs.readFileSync(path.join(root, 'vm/votes.mjs'), 'utf8'));
const literals = [String(contract.cut.high), String(contract.cut.mid), String(contract.votes.arity)];
for (const lit of literals) {
  check('vm/judge.mjs 里没有阈值字面量 ' + lit, !srcJudge.includes(lit));
  check('vm/votes.mjs 里没有阈值字面量 ' + lit, !srcVotes.includes(lit));
}

// —— 3. 去重：同一读数九次只算一个证据（这是原来的放行漏洞） ——
const same9 = J.computeConfidence([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
check('同一读数九次 → 只算 1 个来源', same9.nSources === 1, String(same9.nSources));
check('同一读数九次 → agreement 归零（一个来源不能自证）', same9.agreement === 0, String(same9.agreement));
check('同一读数九次 → 结论不是 +1', J.judge({ zValues: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }).value !== 1);

// —— 4. 但真·多重印证不许被判死：九个独立来源同一个值 ——
const srcs = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'];
const nineSame = J.computeConfidence(srcs.map(() => ({ z: 1.2 })), { sources: srcs });
check('九个独立 source 同值 → 算 9 个来源', nineSame.nSources === 9, String(nineSame.nSources));
check('九个独立 source 同值 → agreement 保留 1（方差不该杀死印证）', Math.abs(nineSame.agreement - 1) < 1e-9, String(nineSame.agreement));
check('九个独立 source 同值 → 结论是 +1', J.judge({ zValues: srcs.map(() => ({ z: 1.2 })), sources: srcs }).value === 1);

// —— 5. 单值不算证据 ——
const single = J.computeConfidence([1.0]);
check('单值 → 1 个来源', single.nSources === 1, String(single.nSources));
check('单值 → agreement 归零', single.agreement === 0, String(single.agreement));
check('单值 → 不给 +1', J.judge({ zValues: [1.0] }).value !== 1);

// —— 6. 截断不能当去重键：3.1/3.2/3.4 会被截成同一个 3 ——
const clamped = J.computeConfidence([3.1, 3.2, 3.4, 2.9, 2.8, 2.7, 2.6, 2.5, 2.4]);
check('九条不同读数（含三条超限）→ 算 9 个来源，不被截断合并', clamped.nSources === 9, String(clamped.nSources));

// —— 7. 到票率闸门 ——
const short = V.judgeVotes({ votes: ['ACCEPT', 'ACCEPT', 'ACCEPT'], expected: 5 });
check('3 张 ACCEPT / 应评 5 → 到票率 0.6 < arity', short.turnout < V.ARITY, String(short.turnout));
check('3 张 ACCEPT / 应评 5 → 不判 ACCEPT（缺席不等于同意）', short.state === 'unreviewed', short.state);
check('3 张 ACCEPT / 应评 5 → value 必须 ≤ 0', short.value <= 0, String(short.value));
check('3 张 ACCEPT / 应评 5 → reason 是 insufficient', short.reason === 'insufficient', short.reason);

const full = V.judgeVotes({ votes: ['ACCEPT', 'ACCEPT', 'ACCEPT'], expected: 3 });
check('3 张 ACCEPT / 应评 3 → 到票率 1，判 ACCEPT', full.state === 'ACCEPT' && full.value === 1, full.state + '/' + full.value);

const none = V.judgeVotes({ votes: [null, null], expected: 2 });
check('零票 → value 保留 -1（证据不足不是「存疑」也不是「同意」）', none.value === -1, String(none.value));
check('零票 → reason 是 insufficient 且 reasonText 说明到票不足', none.reason === 'insufficient' && /到票/.test(none.reasonText || ''), none.reasonText);

// —— 8. 每张票是一个来源：三张 REVISE 不该被合并成一票 ——
const rev = V.judgeVotes({ votes: ['REVISE', 'REVISE', 'REVISE'], expected: 3 });
check('三张 REVISE → REVISE（三票是三个证据）', rev.state === 'REVISE' && rev.stats.nSources === 3, rev.state + '/' + rev.stats.nSources);

// —— 9. 三张 ACCEPT 不能因为「值相同」被去重成一张 ——
const acc = V.judgeVotes({ votes: ['ACCEPT', 'ACCEPT', 'ACCEPT'], expected: 3 });
check('三张 ACCEPT → stats.nSources 必须是 3', acc.stats.nSources === 3, String(acc.stats.nSources));

console.log('');
if (fail) {
  console.log('✗ 通过 ' + pass + ' / 失败 ' + fail);
  for (const f of failures) console.log('   - ' + f);
  process.exit(1);
}
console.log('✓ 通过 ' + pass + ' / 失败 0');
