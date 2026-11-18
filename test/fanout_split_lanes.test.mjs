// test/fanout_split_lanes.test.mjs —— 「--split × --lanes」：分片必须摊到编队里的每一条通道上
//
// 纯离线：不起客户端、不打网络、不写文件。两条通道的 ask 都是注入的假函数，
// 只回固定文本；通道归属靠 runFanout 的 onProgress（child-done 带 lane）与假 ask 的调用计数双重取证。
//
// 通道选型说明：PRD 建议 lanes: ['codebuddy','trae']，但 trae 在 LANE_DEFS 里的角色只有 review，
// planLanes(role='writer') 会直接抛「trae 不能当 writer」。所以这里用同样能当写手的 ollama
// 顶替第二条通道 —— 编队里「两条不同通道」这件事不变，只是名字换了。
import { LANE_DEFS } from '../lib/lanes.mjs';
import { runFanout } from '../lib/fanout-run.mjs';

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; } else { fail += 1; console.log('  ✗ ' + m); } };

const unit = (name) => ({ unit: name, abs: name, exists: true });
const planOf = (names) => ({
  chunks: names.map((g, i) => ({ index: i, total: names.length, label: 'chunk-' + (i + 1) + '/' + names.length, units: [unit(g)] })),
  units: names.map(unit),
  strategy: 'units',
  count: names.length,
  reason: 'ok',
});

const CHUNKS = planOf(['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs']);
const reviewFake = async () => ({ ok: true, addedText: '' });

/** 跑一次：临时把 lanes 的并行度与 ask 换成假的，跑完必须还原（别的用例还靠真定义）。 */
async function scenario(lanes, parallel, parts) {
  const seen = {};
  const childHits = {};
  let reviewCalls = 0;
  for (const id of lanes) {
    seen[id] = { ask: LANE_DEFS[id].ask, parallel: LANE_DEFS[id].parallel };
    childHits[id] = 0;
    LANE_DEFS[id].parallel = parallel;
    LANE_DEFS[id].ask = (prompt) => {
      if (/你这一片只负责/.test(String(prompt))) {
        childHits[id] += 1;
        return Promise.resolve({ ok: true, addedText: 'ANSWER: 本片做完了\nEVIDENCE: ' + id + '.mjs:1' });
      }
      reviewCalls += 1;
      return Promise.resolve({ ok: true, addedText: '' });
    };
  }
  const lanesSeen = [];
  let res = null;
  let thrown = null;
  try {
    res = await runFanout({
      task: '把这四个文件分别看完',
      parts,
      cwd: process.cwd(),
      lanes,
      splitPlan: CHUNKS,
      reviewAsk: reviewFake,
      reviewLane: 'injected',
      reviewChunk: 0,
      noPreGate: true,
      speculativeResend: false,
      onProgress: (e) => { if (e.phase === 'child-done') lanesSeen.push(e.lane); },
    });
  } catch (e) {
    thrown = e;
  } finally {
    for (const id of lanes) { LANE_DEFS[id].ask = seen[id].ask; LANE_DEFS[id].parallel = seen[id].parallel; }
  }
  const total = Object.keys(childHits).reduce((s, k) => s + childHits[k], 0);
  return { res, thrown, childHits, total, lanesSeen, reviewCalls };
}

// 1. 两条通道 × 4 片：四片全执行，且真的用到两条通道（本补丁要证明的事）
const two = await scenario(['codebuddy', 'ollama'], 2, 4);
ok(!two.thrown, '1 两条通道跑完不抛：' + (two.thrown && two.thrown.message));
ok(two.total === 4, '1b 四个分片全部被执行（计数 ' + two.total + '）');
ok(new Set(two.lanesSeen).size >= 2, '1c 至少用到 2 条不同通道（实得 ' + JSON.stringify(two.lanesSeen) + '）');

// 2. 轮转而不是全压一条：两条通道的片数相差不超过 1
const counts = Object.keys(two.childHits).map((k) => two.childHits[k]);
ok(counts.length >= 2 && Math.max(...counts) - Math.min(...counts) <= 1,
  '2 两通道片数差 ≤ 1（实得 ' + JSON.stringify(two.childHits) + '）');

// 3. 片不重不漏：每片一个 label，落到的通道数加起来正好 4
const labels = two.res && two.res.children ? two.res.children.map((c) => c.chunkLabel) : [];
ok(labels.length === 4 && new Set(labels).size === 4, '3 四片各自独立，label 不重复（' + JSON.stringify(labels) + '）');
ok(!!two.res && two.res.split && two.res.split.chunks === 4, '3b 结果里的 split 描述仍是 4 片');

// 4. 旧路径不回归：只给 1 条通道时，4 片全走它，不报错
const one = await scenario(['codebuddy'], 4, 4);
ok(!one.thrown, '4 单通道路径不抛：' + (one.thrown && one.thrown.message));
ok(one.total === 4, '4b 单通道下四片也全执行（计数 ' + one.total + '）');
ok(one.childHits.codebuddy === 4, '4c 四片都落在唯一的通道上（实得 ' + one.childHits.codebuddy + '）');

console.log('fanout_split_lanes: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
