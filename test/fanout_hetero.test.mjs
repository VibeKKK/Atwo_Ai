// test/fanout_hetero.test.mjs —— 父审必须默认与主力异源，且「退回同源」必须留痕。
//
// 2026-11-18 查出的两个洞：
// ① pickReviewLane(cwd) 不知道主力是谁，可能挑中同一条通道 —— 自审只能抓矛盾与硬错；
// ② 不显式给 --review-lane 时 reviewAsk 用的是**主力**的 ask，标签写 A、实际用 B 审。
//    产物层面完全看不出来，读的人会以为有人交叉核过。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickReviewLaneDetail, pickReviewLane, runFanout } from '../lib/fanout-run.mjs';
import { reviewTimeoutFor } from '../lib/fanout-run.mjs';
import { laneReady } from '../lib/lanes.mjs';

let pass = 0, fail = 0;
async function ta(name, fn) { try { await fn(); pass += 1; console.log('  ✓ ' + name); } catch (e) { fail += 1; console.log('  ✗ ' + name + ' — ' + ((e && e.message) || e)); } }
console.log('fanout hetero reviewer');

// 台账要造在临时 cwd 里：memory/ 在 .gitignore 里，测试绝不能往真仓库写运行时证据。
function tmpLedger(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-hetero-'));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  const now = new Date().toISOString();
  const lines = [];
  for (const r of rows) {
    for (let i = 0; i < (r.n || 3); i += 1) {
      lines.push(JSON.stringify({ v: 1, contract: 'atwo-reviewer-ledger/1', ts: now, lane: r.lane, ok: true, ms: r.ms, reason: 'ok', chunks: 1, source: 'fanout' }));
    }
  }
  fs.writeFileSync(path.join(dir, 'memory', 'reviewer-ledger.jsonl'), lines.join('\n') + '\n', 'utf8');
  return dir;
}



await ta('台账里两条都可用 → 默认挑最快的那条', async () => {
  const dir = tmpLedger([{ lane: 'codebuddy', ms: 1000 }, { lane: 'trae', ms: 50000 }]);
  assert.strictEqual(pickReviewLane(dir), 'codebuddy');
});

await ta('主力是 codebuddy 时必须避开它 → 挑 trae', async () => {
  const dir = tmpLedger([{ lane: 'codebuddy', ms: 1000 }, { lane: 'trae', ms: 50000 }]);
  assert.strictEqual(pickReviewLane(dir, { avoid: ['codebuddy'] }), 'trae', '主力通道不许当自己的父审');
});

await ta('只有主力一条可用时退回它，而不是瞎挑一条', async () => {
  const dir = tmpLedger([{ lane: 'codebuddy', ms: 1000 }]);
  assert.strictEqual(pickReviewLane(dir, { avoid: ['codebuddy'] }), 'codebuddy');
});

const childAsk = async () => ({ ok: true, addedText: 'ANSWER:\n答案\nEVIDENCE:\natwo.mjs:190 const EXIT' });
const reviewAsk = async () => ({ ok: true, addedText: JSON.stringify({ reviews: [{ id: 'child-1', verdict: 'PASS', why: 'w' }, { id: 'child-2', verdict: 'PASS', why: 'w' }] }) });
const PROBES = [{ lane: 'codebuddy', ready: true, parallel: 6, quality: 'high', roles: ['writer', 'review'] }];

await ta('自动挑选的通道起不来 → 如实退回主力并留 reviewFallback（不许装异源）', async () => {
  // 台账里混进一条「名字解析不了」的通道（历史遗留/拼错都会这样）：
  // 自动挑选会把它排在前面，但它根本起不来 —— 这时退回主力是对的，装异源是错的。
  const dir = tmpLedger([{ lane: 'ghost-lane', ms: 100 }, { lane: 'codebuddy', ms: 1000 }]);
  const r = await runFanout({ cwd: dir, task: 't', parts: 2, lanes: ['codebuddy'], autoLanes: false, probes: PROBES, ask: childAsk, preGate: false, reviewChunk: 0 });
  assert.strictEqual(r.reviewLane, 'codebuddy', '退回时 reviewLane 必须是真实在用的那条');
  assert.strictEqual(r.reviewWanted, 'ghost-lane', '原本想要的那条要留着，否则无从解释为什么同源');
  assert.ok(r.reviewFallback && String(r.reviewFallback).length > 0, '退回原因必须落成字段');
  assert.strictEqual(r.homogeneous, true, '退回主力就是同源，不许标异源');
});

await ta('显式 --review-lane 指向不存在的通道 → 抛，不许悄悄换人', async () => {
  await assert.rejects(
    () => runFanout({ task: 't', parts: 2, lanes: ['codebuddy'], autoLanes: false, probes: PROBES, ask: childAsk, reviewLane: 'no-such-lane', preGate: false, reviewChunk: 0 }),
    /没有这个通道|no-such-lane/,
  );
});
await ta('静态推测挑中 GUI 通道 → 只等 90s（不是 180s，也不是 300s 地板）', async () => {
  // 2026-11-18 实测：trae 当父审 340s 才回「界面占位文案」。没有实测记录时不该押 5 分钟。
  assert.strictEqual(laneReady('deepseek'), false, 'HTTP 通道没有 Read 工具，不能当父审');
  assert.strictEqual(laneReady('ollama'), false, '8B 会编引文');
  // 2026-11-18 踩过：产物写「只等 90s」，实际因为 Math.max(timeoutMs=180000, 90000) 还是 180s，
  // 整跑 205s 才退回自审 —— 产物里写假话比没有墙更糟。所以这层逻辑必须是可单测的纯函数。
  assert.strictEqual(reviewTimeoutFor({ lane: 'trae', source: 'static', timeoutMs: 180000 }), 90000, '静态 GUI 只等 90s');
  assert.strictEqual(reviewTimeoutFor({ lane: 'trae', source: 'ledger', timeoutMs: 180000 }), 300000, '台账验过的 GUI 给 300s 地板');
  assert.strictEqual(reviewTimeoutFor({ lane: 'codebuddy', source: null, timeoutMs: 180000 }), 180000, 'CLI 通道不受 GUI 地板影响');
  assert.strictEqual(reviewTimeoutFor({ lane: 'trae', source: 'static', timeoutMs: 180000, staticCapMs: 45000 }), 45000, '短墙可被环境变量覆盖');
});

await ta('通道把失败原因放在 error 字段（不是 err）→ 退回原因也要能读', async () => {
  // 2026-11-18 实测：codex 明明回了「codex CLI 不存在：…」/「app-server 初始化被拒（os error 5）」，
  // 产物里却只写「通道返回 ok:false 且没给 err」—— 排障时等于什么都没说。
  const errInError = async () => ({ ok: false, error: 'app-server 初始化被拒（os error 5）', addedText: '' });
  const r = await runFanout({ task: 't', parts: 2, lanes: ['codebuddy'], autoLanes: false, probes: PROBES, ask: childAsk, reviewAsk: errInError, reviewLane: 'trae', preGate: false, reviewChunk: 0 });
  assert.ok(/os error 5|app-server/.test(String(r.reviewFallback || '')), '真实原因要进 reviewFallback：' + r.reviewFallback);
  assert.ok(!/没给 err/.test(String(r.reviewFallback || '')), '有 error 字段就不许说「没给 err」');
});

await ta('台账空（陌生人的干净 clone）也要异源：静态推测一条不同于主力的，并标明依据', async () => {
  // 2026-11-18 干净检出实测：没有 memory/reviewer-ledger.jsonl，旧代码直接返回 'codebuddy'，
  // 而主力也是 codebuddy → reviewWanted=codebuddy、homogeneous=true，父审只能自审。
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-hetero-empty-'));
  const detail = pickReviewLaneDetail(d, { avoid: ['codebuddy'] });
  assert.notStrictEqual(detail.lane, 'codebuddy', '台账空时也不许挑主力那条');
  assert.strictEqual(detail.source, 'static', '来源要如实标 static，别冒充实测');
  assert.strictEqual(pickReviewLane(d, { avoid: ['codebuddy'] }), detail.lane, '薄壳返回同一条');
  // 一整个本机只有一条通道时不许瞎挑：排空就退回，留着来源标记让人看得见。
  const all = pickReviewLaneDetail(d, { avoid: [detail.lane] });
  assert.ok(all.lane && all.lane !== detail.lane, '避开首选后要换下一条：' + all.lane);
});

await ta('异源父审没给票 → 退回主力重审一次，并留痕（不许白等成 exit 5）', async () => {
  // 2026-11-18 实测形态：父审是 trae，340s 后回「界面占位文案」，两片全 unreviewed，整跑退出 5。
  // 退回自审至少能给出结论 —— 但必须在产物里说清「这次是自审，因为异源没给票」。
  const placeholder = async () => ({ ok: true, addedText: '思考中' });
  const r = await runFanout({ task: 't', parts: 2, lanes: ['codebuddy'], autoLanes: false, probes: PROBES, ask: childAsk, reviewAsk: placeholder, reviewLane: 'trae', preGate: false, reviewChunk: 0 });
  assert.strictEqual(r.reviewLane, 'codebuddy', '退回后 reviewLane 必须是真实在用的那条');
  assert.strictEqual(r.reviewWanted, 'trae', '原本那条异源要留着');
  assert.ok(/没给票|占位|文案/.test(String(r.reviewFallback || '')), '退回原因要写清：' + r.reviewFallback);
  assert.ok(Array.isArray(r.rounds) && r.rounds.some((x) => x.reviewFallbackFrom), '退回这件事要进 rounds 台账');
});

await ta('源码守卫：父审 ask 不许在不知道主力的情况下定下来', async () => {
  const src = fs.readFileSync(new URL('../lib/fanout-run.mjs', import.meta.url), 'utf8');
  assert.ok(!/opts\.reviewLane \? resolveAsk\(opts\.reviewLane\) : ask/.test(src), '旧写法：挑的是 A 通道、用的却是主力的 ask');
  assert.ok(/avoid: mainLanes/.test(src), 'pickReviewLane 必须收到主力名单');
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;