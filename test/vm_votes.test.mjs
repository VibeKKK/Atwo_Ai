// 票 → 三态决议测试。判据与 vm/judge.mjs 同源（不在这里另立阈值）。
//
// 核心断言是那三条「看起来一样的三种失败」必须分开：
//   全 ACCEPT        → ACCEPT（可判，方向正）
//   全 REVISE        → REVISE（可判，方向负）
//   一半一半 / 有人没评 → unreviewed（下不了结论）
// 大多数评审系统会把第三种塞进前两种的某一边，那正是它分不清「通过」和「没评成」的原因。

import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V = await import(pathToFileURL(path.join(root, 'vm/votes.mjs')).href).catch((e) => ({ __missing: String(e && e.message) }));
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

if (V.__missing) check('vm/votes.mjs 可加载', false, V.__missing);
else {
  // —— 票面归一化 ——
  check('parseVote ACCEPT 各写法', ['ACCEPT', 'accept', 'A', '+1'].every((v) => V.parseVote(v) === 'ACCEPT'));
  check('parseVote REVISE 各写法', ['REVISE', 'revise', 'R', '-1'].every((v) => V.parseVote(v) === 'REVISE'));
  check('parseVote 没评成 → null', [null, undefined, '', 'unreviewed', '0'].every((v) => V.parseVote(v) === null));
  check('parseVote 认不出 → undefined（不静默当没评成）', V.parseVote('MAYBE') === undefined && V.parseVote(3) === undefined);

  // —— 指标换算 ——
  const z1 = V.votesToZ(['ACCEPT', 'REVISE', null]);
  check('votesToZ 票转指标 +1/-1，没评成不计入', JSON.stringify(z1.zValues) === '[1,-1]' && z1.counts.unreviewed === 1, JSON.stringify(z1));

  // —— 三态决议 ——
  const a = V.judgeVotes({ votes: ['ACCEPT', 'ACCEPT', 'ACCEPT'], expected: 3 });
  check('三票全 ACCEPT → ACCEPT +1', a.state === 'ACCEPT' && a.value === 1 && a.direction === 1, JSON.stringify(a));
  const r = V.judgeVotes({ votes: ['REVISE', 'REVISE', 'REVISE'], expected: 3 });
  check('三票全 REVISE → REVISE（不是 unreviewed）', r.state === 'REVISE' && r.value === 1 && r.direction === -1, JSON.stringify({ s: r.state, v: r.value, d: r.direction }));
  const mix = V.judgeVotes({ votes: ['ACCEPT', 'REVISE', 'ACCEPT'], expected: 3 });
  check('2:1 分歧 → unreviewed（多数票不等于有结论）', mix.state === 'unreviewed' && mix.value === -1, JSON.stringify({ s: mix.state, v: mix.value, r: mix.reason }));
  const half = V.judgeVotes({ votes: ['ACCEPT', 'REVISE'], expected: 2 });
  check('1:1 打平 → unreviewed（meanZ=0 不给方向）', half.state === 'unreviewed', JSON.stringify({ v: half.value, d: half.direction }));
  const few = V.judgeVotes({ votes: ['ACCEPT', null, null], expected: 3 });
  check('一票 ACCEPT + 两票没评成 → unreviewed（有效比例不够）', few.state === 'unreviewed', JSON.stringify({ v: few.value, n: few.stats.nValid }));
  const none = V.judgeVotes({ votes: [null, null], expected: 2 });
  check('全没评成 → unreviewed 且 reason 标明证据不足', none.state === 'unreviewed' && none.value === -1, JSON.stringify(none.reason));

  // —— reason 必须是机器码：会进 --json、会被别的程序当判断条件 ——
  // 踩过的坑：value<0 时原来把 judge 的中文 reason（「别判」）直接塞进 reason，
  // 于是同一字段有时是 'consensus-accept'、有时是「别判」，下游写
  // reason === 'insufficient' 永远不成立，而且看不出哪里错。人话改放 reasonText。
  check('reason 是机器码 insufficient（不是「别判」这种中文）', none.reason === 'insufficient', JSON.stringify(none.reason));
  check('人话单独放 reasonText，且不污染 reason', typeof none.reasonText === 'string' && none.reasonText.length > 0, JSON.stringify(none.reasonText));
  check('可判时 reason 是共识码', V.judgeVotes({ votes: ['ACCEPT', 'ACCEPT'], expected: 2 }).reason === 'consensus-accept');

  // —— 没有声明应评名单：到票率不可算，绝不许落成 ACCEPT ——
  // 这是 2026-11-16 堵的第二个放行侧漏洞：不传 expected 时旧逻辑把「来几张」当「应评几张」，
  // 于是三张 ACCEPT 自动等于到票率 100%，闸门形同虚设。
  const noRoster = V.judgeVotes({ votes: ['ACCEPT', 'ACCEPT', 'ACCEPT'] });
  check('未声明名单时三票全认也不给 ACCEPT', noRoster.state === 'unreviewed' && noRoster.value <= 0, JSON.stringify({ s: noRoster.state, v: noRoster.value }));
  check('未声明名单 → reason 是机器码 no-roster', noRoster.reason === 'no-roster', JSON.stringify(noRoster.reason));
  check('未声明名单 → rosterMissing 标记为 true', noRoster.rosterMissing === true);
  const noRosterRev = V.judgeVotes({ votes: ['REVISE', 'REVISE'] });
  check('未声明名单时也不给 REVISE（同样没到票率）', noRosterRev.state === 'unreviewed' && noRosterRev.reason === 'no-roster');

  // —— 与 judge 同源：决议阈值必须等于 judge 的 CUT ——
  const J = await import(pathToFileURL(path.join(root, 'vm/judge.mjs')).href);
  check('votes 的分档阈值与 judge 一致', JSON.stringify(a.cut) === JSON.stringify({ high: J.CUT.high, mid: J.CUT.mid }), JSON.stringify(a.cut));

  // —— 一致性：同票重复判两次必须同结论（无随机、无缓存污染） ——
  const again = V.judgeVotes({ votes: ['REVISE', 'REVISE', 'REVISE'], expected: 3 });
  check('同输入重复判定结论一致', again.state === r.state && again.confidence === r.confidence);
}

let pass = 0; let fail = 0;
for (const x of results) {
  if (x.ok) { pass++; console.log('  ✓ ' + x.name); }
  else { fail++; console.log('  ✗ ' + x.name + (x.detail ? '  → ' + x.detail : '')); }
}
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
