// 选路的回归：异源优先，别把 N 路活全塞给第一条通道。
// 为什么单独立测试：这条 bug 从上线起就在（planLanes(4) 返回 codebuddy×4，deepseek ready 却闲置），
// 一直是靠命令行 --lanes 手动兜着的，机器规划从没真的并行过。
import { planLanes } from '../lib/lanes.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('ok ' + name); }
  else { fail += 1; console.log('FAIL ' + name); }
};

// 固定探测结果，不吸气机器现状：本机 codebuddy/deepseek 常开，GUI 三条默认不探。
const probes = [
  { lane: 'codebuddy', ready: true, parallel: 6 },
  { lane: 'deepseek', ready: true, parallel: 4 },
  { lane: 'codex', ready: false, parallel: 6, reason: 'codex 起不来' },
  { lane: 'trae', ready: false, parallel: 1, reason: '未探测' },
  { lane: 'workbuddy', ready: false, parallel: 1, reason: '未探测' },
  { lane: 'doubao', ready: false, parallel: 1, reason: '未探测' },
  { lane: 'ollama', ready: false, parallel: 4, reason: 'ollama 没跑' },
];

const sum = (plan) => plan.reduce((s, p) => s + p.count, 0);
const byLane = (plan) => Object.fromEntries(plan.map((p) => [p.lane, p.count]));

// ① 四路：必须异源（这就是修好的 bug）
{
  const r = planLanes(4, { role: 'writer', probes });
  const m = byLane(r.plan);
  ok(r.plan.length === 2, '四路分给两条通道（实际 ' + r.plan.length + '）');
  ok(sum(r.plan) === 4, '总数正好四路（实际 ' + sum(r.plan) + '）');
  ok((m.deepseek || 0) > 0, 'deepseek 被用上了（旧实现这里是 0）');
  ok((m.codebuddy || 0) <= 6, 'codebuddy 不超过自己的并行上限');
  ok(r.unassigned === 0, '没有剩下的路');
}

// ② 两路：一人一路最公平
{
  const m = byLane(planLanes(2, { role: 'writer', probes }).plan);
  ok(m.codebuddy === 1 && m.deepseek === 1, '两路时一人一路（实际 ' + JSON.stringify(m) + '）');
}

// ③ 一路：只给第一条
{
  const r = planLanes(1, { role: 'writer', probes });
  ok(r.plan.length === 1 && r.plan[0].lane === 'codebuddy', '一路只派 codebuddy');
}

// ④ 超出总并行上限：截断并如实报 unassigned
{
  const r = planLanes(20, { role: 'writer', probes });
  ok(sum(r.plan) === 10, '总并行上限 6+4=10（实际 ' + sum(r.plan) + '）');
  ok(r.unassigned === 10, '剩下的如实报成 unassigned（实际 ' + r.unassigned + '）');
}

// ⑤ 未探测的 GUI 通道不许自己冒出来
{
  const lanes = planLanes(4, { role: 'review', probes }).plan.map((p) => p.lane);
  ok(!lanes.includes('doubao'), '没点名时 doubao 不入选');
  ok(!lanes.includes('trae'), '没点名时 trae 不入选');
}

// ⑥ 点名的 GUI 通道要放行（否则那三条等于不存在）
{
  const r = planLanes(1, { role: 'review', probes, lanes: ['doubao'] });
  ok(r.plan.length === 1 && r.plan[0].lane === 'doubao', '显式 --lanes doubao 能派出去');
}

// ⑦ 写错名字要报得清，不许变成「没有可用通道」
{
  let msg = '';
  try { planLanes(1, { role: 'writer', probes, lanes: ['doubao2'] }); } catch (e) { msg = e.message; }
  ok(msg.includes('未知通道'), '错误通道名报「未知通道」（实际：' + msg.slice(0, 20) + '）');
}

// ⑧ 角色不符要说明它能当什么
{
  let msg = '';
  try { planLanes(1, { role: 'writer', probes, lanes: ['workbuddy'] }); } catch (e) { msg = e.message; }
  ok(msg.includes('不能当 writer') && msg.includes('review'), '角色不符时说明它只能当 review');
}

// ⑨ 全死时要说清为什么，而不是空计划
{
  const dead = probes.map((p) => ({ ...p, ready: false }));
  let msg = '';
  try { planLanes(2, { role: 'writer', probes: dead }); } catch (e) { msg = e.message; }
  ok(msg.includes('没有可用通道'), '全不可用时给出「没有可用通道」');
}

console.log('');
console.log((fail === 0 ? '全部通过' : '有失败') + '：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
