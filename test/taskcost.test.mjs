// test/cost.test.mjs —— 成本账：算钱、落盘、坏行、三维汇总、人读格式。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COST_CONTRACT, PRICE_PER_MTOK, usdOf, appendCost, readCost, summarizeCost, formatCost,
} from '../lib/taskcost.mjs';

// 每个用例自己造 cwd：账本是共享文件，跑在同一个目录里会互相污染。
function tmpCwd(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-cost-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const close = (a, b) => Math.abs(a - b) < 1e-9;

const R1 = {
  taskId: 't1', kind: 'fanout', lane: 'laneA', model: 'deepseek-v4.1-flash',
  startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:10.000Z',
  tokensIn: 1000000, tokensOut: 0, calls: 2,
};
const R2 = {
  taskId: 't1', kind: 'fanout', lane: 'laneA', model: 'glm-5.3-flash',
  startedAt: '2026-01-01T00:00:05.000Z', endedAt: '2026-01-01T00:00:07.500Z',
  tokensIn: 1000000, tokensOut: 1000000, calls: 1,
};
const R3 = {
  taskId: 't2', kind: 'fanout', lane: 'laneB', model: 'no-such-model',
  startedAt: '2026-02-01T00:00:00.000Z', endedAt: '2026-02-01T00:00:01.000Z',
  tokensIn: 0, tokensOut: 1000000, calls: 1,
};
const RECORDS = [R1, R2, R3];

test('usdOf：已知模型按每百万 token 单价算', () => {
  // 期望值按公式自己算：deepseek 输入 0.14 / 输出 0.28
  assert.equal(usdOf('deepseek-v4.1-flash', 1000000, 500000), 0.14 + 0.5 * 0.28);
  // glm 输入 2.5M、输出 1M：2.5*0.1 + 1*0.1
  assert.ok(close(usdOf('glm-5.3-flash', 2500000, 1000000), 2.5 * 0.1 + 1 * 0.1));
  // kimi 输入 0.1M、输出 0.2M：0.1*1.2 + 0.2*1.2
  assert.ok(close(usdOf('kimi-k3.1-pro', 100000, 200000), 0.1 * 1.2 + 0.2 * 1.2));
  // 单价表就是契约，被改动了这里先红
  assert.equal(PRICE_PER_MTOK['deepseek-v4.1-flash'].in, 0.14);
  assert.equal(PRICE_PER_MTOK['glm-5.3-flash'].out, 0.1);
});

test('usdOf：未知模型落到 default 单价', () => {
  assert.equal(usdOf('no-such-model', 1000000, 1000000), 0.5 + 1.5);
  // 子会话原来在这里写 2 —— 它自己的单价表 default.in=0.5，2000000 输入 token 应是 1.0。
  // 这是子会话算术写错，跑起来才暴露；断言按表算出来的真值改。
  assert.equal(usdOf(undefined, 2000000, 0), 1);
  assert.equal(usdOf('no-such-model', 1000000, 0), PRICE_PER_MTOK.default.in);
});

test('usdOf：token 不是数字一律按 0', () => {
  assert.equal(usdOf('deepseek-v4.1-flash', 'abc', null), 0);
  assert.equal(usdOf('deepseek-v4.1-flash', NaN, undefined), 0);
  assert.equal(usdOf('deepseek-v4.1-flash', '1000000', '0'), 0.14);   // 数字字符串能救回来
});

test('appendCost 后 readCost 能读回', (t) => {
  const cwd = tmpCwd(t);
  const a = appendCost(cwd, R1);
  assert.equal(a.ok, true);
  assert.match(a.id, /^\d{14}-[0-9a-f]{4}$/);
  const b = appendCost(cwd, { taskId: 't2', lane: 'laneB' });   // 字段全缺也要落得下去
  assert.equal(b.ok, true);
  const got = readCost(cwd);
  assert.equal(got.ok, true);
  assert.equal(got.corrupt, 0);
  assert.equal(got.records.length, 2);
  assert.equal(got.records[0].id, a.id);
  assert.equal(got.records[0].taskId, 't1');
  assert.equal(got.records[0].lane, 'laneA');
  assert.equal(got.records[0].calls, 2);
  assert.ok(close(got.records[0].usd, 0.14));
  assert.equal(got.records[1].lane, 'laneB');
  assert.equal(got.records[1].model, 'default');
  assert.equal(got.records[1].kind, 'run');
  assert.equal(got.records[1].calls, 1);
  assert.equal(fs.existsSync(path.join(cwd, 'memory', 'cost.jsonl')), true);
});

test('readCost：坏行只计数，不中断也不丢好行', (t) => {
  const cwd = tmpCwd(t);
  appendCost(cwd, R1);
  const file = path.join(cwd, 'memory', 'cost.jsonl');
  fs.appendFileSync(file, '{oops\n', 'utf8');
  fs.appendFileSync(file, '42\n', 'utf8');   // 能解析但不是对象，也算坏账
  appendCost(cwd, R3);
  const got = readCost(cwd);
  assert.equal(got.records.length, 2);
  assert.equal(got.corrupt, 2);
  assert.equal(got.records[1].taskId, 't2');
});

test('readCost：文件不存在算空账本', (t) => {
  const got = readCost(tmpCwd(t));
  assert.equal(got.ok, true);
  assert.deepEqual(got.records, []);
  assert.equal(got.corrupt, 0);
});

test('summarizeCost：lane / model / task 三维度都聚合对', () => {
  const sum = summarizeCost(RECORDS);
  assert.equal(sum.contract, COST_CONTRACT);
  assert.equal(sum.contract, 'atwo-cost/1');
  assert.equal(sum.total.calls, 4);
  assert.equal(sum.total.ms, 10000 + 2500 + 1000);
  assert.equal(sum.total.tokensIn, 2000000);
  assert.equal(sum.total.tokensOut, 2000000);
  assert.ok(close(sum.total.usd, 0.14 + 0.2 + 1.5));
  assert.equal(sum.byLane.laneA.calls, 3);
  assert.equal(sum.byLane.laneA.ms, 12500);
  assert.ok(close(sum.byLane.laneA.usd, 0.34));
  assert.ok(close(sum.byLane.laneB.usd, 1.5));
  assert.equal(sum.byLane.laneB.tokensOut, 1000000);
  assert.equal(sum.byModel['deepseek-v4.1-flash'].calls, 2);
  assert.ok(close(sum.byModel['glm-5.3-flash'].usd, 0.2));
  assert.ok(close(sum.byModel['no-such-model'].usd, 1.5));
  assert.equal(sum.byTask.t1.calls, 3);
  assert.equal(sum.byTask.t2.ms, 1000);
  // 维度小计必须等于总额，否则账就对不上
  const laneUsd = Object.values(sum.byLane).reduce((acc, x) => acc + x.usd, 0);
  assert.ok(close(laneUsd, sum.total.usd));
});

test('summarizeCost：since 生效与不生效', () => {
  assert.equal(summarizeCost(RECORDS).total.calls, 4);   // 不传 since 全算
  const onlyLate = summarizeCost(RECORDS, { since: '2026-01-15T00:00:00.000Z' });
  assert.equal(onlyLate.total.calls, 1);
  assert.equal(onlyLate.total.ms, 1000);
  assert.ok(close(onlyLate.total.usd, 1.5));
  assert.deepEqual(Object.keys(onlyLate.byLane), ['laneB']);
  const twoOfThree = summarizeCost(RECORDS, { since: '2026-01-01T00:00:03.000Z' });
  assert.equal(twoOfThree.total.calls, 2);
  assert.equal(twoOfThree.total.tokensIn, 1000000);
  assert.deepEqual(Object.keys(twoOfThree.byTask).sort(), ['t1', 't2']);
  // since 读不出来就当没设：不能把账全筛掉
  assert.equal(summarizeCost(RECORDS, { since: 'not-a-date' }).total.calls, 4);
});

test('summarizeCost：空输入给全 0 结构，坏记录走默认值', () => {
  for (const input of [[], undefined, null]) {
    const s = summarizeCost(input);
    assert.deepEqual(s.total, { calls: 0, ms: 0, tokensIn: 0, tokensOut: 0, usd: 0 });
    assert.deepEqual(s.byLane, {});
    assert.deepEqual(s.byModel, {});
    assert.deepEqual(s.byTask, {});
    assert.equal(s.contract, 'atwo-cost/1');
  }
  const junk = summarizeCost([{}, 'x', null, { startedAt: 'nope', endedAt: 'nope' }]);
  assert.equal(junk.total.calls, 4);   // 四个都缺 calls，各按 1 算
  assert.equal(junk.total.ms, 0);      // 时间读不出来当 0
  assert.equal(junk.byLane.unknown.calls, 4);
  assert.equal(junk.byModel.default.calls, 4);
  assert.equal(junk.byTask.unknown.calls, 4);
});

test('appendCost：写不进去只返回 ok:false，不抛', (t) => {
  const cwd = tmpCwd(t);
  fs.writeFileSync(path.join(cwd, 'memory'), 'a file where a dir should be', 'utf8');
  let res;
  assert.doesNotThrow(() => { res = appendCost(cwd, R1); });
  assert.equal(res.ok, false);
  assert.equal(typeof res.reason, 'string');
  assert.ok(res.reason.length > 0);
  assert.match(res.id, /^\d{14}-[0-9a-f]{4}$/);
});

test('formatCost：人读、4 位小数、没有 undefined 和 NaN', () => {
  const out = formatCost(summarizeCost(RECORDS));
  assert.equal(typeof out, 'string');
  assert.ok(!out.includes('undefined'));
  assert.ok(!out.includes('NaN'));
  const lines = out.split('\n');
  assert.ok(lines.length <= 8);
  assert.equal(lines.length, 4);                  // total + 三维各一行
  assert.ok(lines[0].startsWith('total calls=4 '));
  assert.ok(lines[0].includes('$1.8400'));        // 金额 4 位小数
  assert.ok(lines[0].includes('13.50s'));         // 13500ms 换成秒
  assert.ok(lines[1].startsWith('lane '));
  assert.ok(lines[1].includes('laneB=$1.5000'));  // 每维只列最贵的三项
  assert.ok(lines[2].startsWith('model '));
  assert.ok(lines[3].startsWith('task '));
  // 空汇总也不能打出 undefined/NaN
  const bare = formatCost({});
  assert.ok(!bare.includes('undefined'));
  assert.ok(!bare.includes('NaN'));
  assert.equal(bare.split('\n').length, 4);
});
