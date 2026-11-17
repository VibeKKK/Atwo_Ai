// test/lanes.test.mjs —— 编队层：谁能并行、谁能出产物、探测说不行就别派。
import assert from 'node:assert/strict';
import { LANE_DEFS, describePlan, dispatchLanes, laneIds, planLanes, probeLanes, resolveAsk } from '../lib/lanes.mjs';
import { MAX_PARTS, MAX_TOTAL_PARTS, clampFanoutParts, clampParts } from '../lib/fanout-run.mjs';
import { buildReviewPrompt } from '../lib/fanout.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}
async function ta(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}

console.log('lanes');

t('每条通道都有 parallel/quality/roles', () => {
  for (const id of laneIds()) {
    const d = LANE_DEFS[id];
    assert.ok(Number.isFinite(d.parallel) && d.parallel >= 1, id + ' parallel');
    assert.ok(Number.isFinite(d.quality), id + ' quality');
    assert.ok(Array.isArray(d.roles) && d.roles.length, id + ' roles');
  }
});

t('GUI 通道 parallel 恒为 1（单窗口独占）', () => {
  for (const id of ['trae', 'workbuddy', 'doubao']) assert.equal(LANE_DEFS[id].parallel, 1, id);
});

t('单通道拐点 6 / 编队总上限 14', () => {
  assert.equal(MAX_PARTS, 6);
  assert.equal(MAX_TOTAL_PARTS, 14);
  assert.equal(clampParts(99), 6);
  assert.equal(clampFanoutParts(99), 14);
  assert.equal(clampFanoutParts(0), 1);
});

t('3 路全给 codebuddy（质量优先，不为了免费去开本地小模型）', () => {
  const { plan } = planLanes(3);
  assert.deepEqual(plan.map((p) => p.lane + 'x' + p.count), ['codebuddyx3']);
});

t('10 路：codebuddy 6 + ollama 溢出 4', () => {
  const probes = [{ lane: 'codebuddy', ready: true }, { lane: 'deepseek', ready: false, reason: 'key 没配' }, { lane: 'codex', ready: false, reason: 'app-server' }, { lane: 'ollama', ready: true }];
  const { plan, unassigned } = planLanes(10, { probes });
  assert.equal(describePlan(plan), 'codebuddy×6 + ollama×4');
  assert.equal(unassigned, 0);
});

t('探测说不行就不派（codex 跳过）', () => {
  const probes = [{ lane: 'codebuddy', ready: false, reason: 'x' }, { lane: 'deepseek', ready: false, reason: 'k' }, { lane: 'codex', ready: false, reason: 'y' }, { lane: 'ollama', ready: true }];
  const { plan } = planLanes(4, { probes });
  assert.equal(plan[0].lane, 'ollama');
});

t('一路都派不出去时抛错并带上原因', () => {
  const probes = [{ lane: 'codebuddy', ready: false, reason: 'CLI 不在' }, { lane: 'deepseek', ready: false, reason: 'key 没配' }, { lane: 'codex', ready: false, reason: '起不来' }, { lane: 'ollama', ready: false, reason: '服务没跑' }];
  assert.throws(() => planLanes(2, { probes }), /没有可用通道[\s\S]*CLI 不在/);
});

t('显式指定通道：只填它，填不满的算 unassigned', () => {
  const { plan, unassigned } = planLanes(6, { lanes: ['ollama'] });
  assert.equal(describePlan(plan), 'ollama×4');
  assert.equal(unassigned, 2);
});

t('未知通道名字要报错，不许静默忽略', () => {
  assert.throws(() => planLanes(2, { lanes: ['gemini'] }), /未知通道/);
});

t('review 角色换个顺序（GUI 通道能当评审）', () => {
  const { plan } = planLanes(2, { role: 'review' });
  assert.equal(plan[0].lane, 'codebuddy');
});

t('父审提示里带上来源通道，并给 ollama 加重点核对', () => {
  const p = buildReviewPrompt('T', [
    { id: 'child-1', lane: 'ollama', answer: 'a', evidence: 'e' },
    { id: 'child-2', lane: 'codebuddy', answer: 'b', evidence: 'f' },
  ], '');
  assert.match(p, /通道：ollama/);
  assert.match(p, /通道：codebuddy/);
  assert.match(p, /本地小模型，可信度低/);
});

await ta('dispatchLanes：按计划分派、结果保持 child 顺序、lane 正确', async () => {
  const seen = [];
  const fake = (lane) => async (prompt) => { seen.push(lane + ':' + prompt); return { ok: true, addedText: 'ANSWER:\nx\nEVIDENCE:\ny', lane }; };
  const planned = [{ lane: 'codebuddy', count: 2 }, { lane: 'ollama', count: 2 }];
  const children = [{ prompt: 'p0' }, { prompt: 'p1' }, { prompt: 'p2' }, { prompt: 'p3' }];
  const out = await dispatchLanes(planned, children, { asks: { codebuddy: fake('codebuddy'), ollama: fake('ollama') } });
  assert.deepEqual(out.map((o) => o.index), [0, 1, 2, 3]);
  assert.deepEqual(out.map((o) => o.lane), ['codebuddy', 'codebuddy', 'ollama', 'ollama']);
  assert.equal(seen.length, 4);
});

// 2026-11-16 改（异源父审）：GUI 通道不再是 ask=null，懒加载实现接上来了。
// 于是「静默丢活」这条风险从「没有 ask」变成「取不到就偷偷退回 codebuddy」——
// 后者更危险（看起来异源，其实同源），所以 resolveAsk 一律抛错。
await ta('resolveAsk：GUI 通道能取到 ask，未知通道必须抛错（不许静默退回 codebuddy）', async () => {
  assert.equal(typeof LANE_DEFS.trae.ask, 'function');
  assert.equal(typeof LANE_DEFS.workbuddy.ask, 'function');
  assert.equal(typeof LANE_DEFS.doubao.ask, 'function');
  assert.equal(typeof resolveAsk('trae'), 'function');
  assert.throws(() => resolveAsk('nope'), /没有这个通道/);
  assert.throws(() => resolveAsk(''), /没有通道 id/);
});

await ta('dispatchLanes：不传 asks 时用编队表里各通道自己的 ask', async () => {
  let used = null;
  const orig = LANE_DEFS.trae.ask;
  LANE_DEFS.trae.ask = async () => { used = 'trae'; return { ok: true, addedText: 'ANSWER:\nx' }; };
  try {
    const out = await dispatchLanes([{ lane: 'trae', count: 1 }], [{ prompt: 'p' }], {});
    assert.equal(used, 'trae');
    assert.equal(out.length, 1);
  } finally { LANE_DEFS.trae.ask = orig; }
});

await ta('dispatchLanes：计划少于 children 时补到首选通道，不丢活', async () => {
  const fake = async () => ({ ok: true, addedText: 'ANSWER:\nx' });
  const out = await dispatchLanes([{ lane: 'codebuddy', count: 1 }], [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }], { asks: { codebuddy: fake } });
  assert.equal(out.length, 3);
});

await ta('probeLanes 真探测：ollama 报模型是否已下载', async () => {
  const p = await probeLanes({ only: ['ollama'], timeoutMs: 3000 });
  assert.equal(p.length, 1);
  assert.equal(typeof p[0].available, 'boolean');
  if (p[0].available) assert.ok('hasModel' in p[0]);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
