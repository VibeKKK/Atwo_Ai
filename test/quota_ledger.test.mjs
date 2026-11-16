// lib/quota-ledger.mjs 的回归断言（对应 PRD 15 条 + 2 条附加）
// 规矩：失败要能说清「哪条、期望什么、实际什么」，不许只打一句 failed。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mod = require(path.join(HERE, '..', 'lib', 'quota-ledger.mjs'));
const { MULTIPLIERS, quotaEntry, summarizeQuota, pickCheapest } = mod;

let pass = 0;
let fail = 0;
const seen = [];

function ok(name, cond, detail = '') {
  if (cond) { pass += 1; seen.push(`  ✓ ${name}`); }
  else { fail += 1; seen.push(`  ✗ ${name}${detail ? `  ← ${detail}` : ''}`); }
}
function throws(name, fn) {
  try { fn(); fail += 1; seen.push(`  ✗ ${name}  ← 没抛错`); }
  catch (e) {
    if (e instanceof TypeError) { pass += 1; seen.push(`  ✓ ${name}`); }
    else { fail += 1; seen.push(`  ✗ ${name}  ← 抛的是 ${e.constructor.name}`); }
  }
}

// 导出齐全（少一个就算没交）
ok('导出 MULTIPLIERS', !!MULTIPLIERS && typeof MULTIPLIERS === 'object');
ok('导出 quotaEntry', typeof quotaEntry === 'function');
ok('导出 summarizeQuota', typeof summarizeQuota === 'function');
ok('导出 pickCheapest', typeof pickCheapest === 'function');

// 倍率换算：0.00x / 0.08x / 1.62x
const hy3 = quotaEntry({ channel: 'workbuddy', model: 'Hy3', ok: true });
ok('Hy3 是 0 积分', hy3.points === 0 && hy3.multiplier === 0, JSON.stringify(hy3));
const glm = quotaEntry({ channel: 'workbuddy', model: 'GLM-5.3-Flash', ok: true });
ok('GLM-5.3-Flash 是 8 积分', glm.points === 8, JSON.stringify(glm));
const kimi = quotaEntry({ channel: 'workbuddy', model: 'Kimi-K3', ok: true });
ok('Kimi-K3 是 162 积分', kimi.points === 162, JSON.stringify(kimi));

// 兜底：未知模型按基准价 1 倍（宁可高估）
const unknown = quotaEntry({ channel: 'x', model: 'unknown-1', ok: false });
ok('未知模型按 1 倍', unknown.multiplier === 1 && unknown.points === 100 && unknown.ok === false, JSON.stringify(unknown));

// 严格布尔：字符串 'true' 不算成功
ok("ok:'true' 不算成功", quotaEntry({ channel: 'x', model: 'm', ok: 'true' }).ok === false);

// 耗时兜底
ok('负耗时归零', quotaEntry({ channel: 'x', model: 'm', ok: true, elapsedMs: -5 }).elapsedMs === 0);
ok('NaN 耗时归零', quotaEntry({ channel: 'x', model: 'm', ok: true, elapsedMs: NaN }).elapsedMs === 0);

// 必填校验
throws('空 channel 抛 TypeError', () => quotaEntry({ channel: '', model: 'm', ok: true }));
throws('非字符串 model 抛 TypeError', () => quotaEntry({ channel: 'x', model: 123, ok: true }));

// 空数组汇总
const empty = summarizeQuota([]);
ok('空数组全零',
  empty.total === 0 && empty.points === 0 && empty.slowest === null
  && Object.keys(empty.byChannel).length === 0 && Object.keys(empty.byModel).length === 0,
  JSON.stringify(empty));

// 汇总：先各自取整再相加
const a = quotaEntry({ channel: 'workbuddy', model: 'GLM-5.3-Flash', ok: true, elapsedMs: 100 });
const b = quotaEntry({ channel: 'x', model: 'unknown-1', ok: false, elapsedMs: 900 });
const sum = summarizeQuota([a, b]);
ok('汇总积分 108 = 8 + 100', sum.points === 108 && sum.pointsOk === 8 && sum.pointsFailed === 100, JSON.stringify(sum));
ok('汇总计成功/失败数', sum.ok === 1 && sum.failed === 1 && sum.total === 2);
ok('slowest 取耗时最大的那条', !!sum.slowest && sum.slowest.elapsedMs === 900, JSON.stringify(sum.slowest));
ok('byChannel 分通道累计', sum.byChannel['workbuddy']?.points === 8 && sum.byChannel['x']?.points === 100, JSON.stringify(sum.byChannel));
ok('byModel 用 通道/模型 作键', !!sum.byModel['workbuddy/GLM-5.3-Flash'] && !!sum.byModel['x/unknown-1']);

// 选路：okRate 不达标要能被过滤掉（降级靠它）
ok('okRate 不足返回 null', pickCheapest([{ multiplier: 1.62, okRate: 0.9 }, { multiplier: 0.08, okRate: 0.4 }]) === null);
const cheapest = pickCheapest([{ multiplier: 1.62, okRate: 0.9 }, { multiplier: 0.08, okRate: 0.8 }]);
ok('选倍率最低的', !!cheapest && cheapest.multiplier === 0.08, JSON.stringify(cheapest));
const tie = pickCheapest([{ multiplier: 0.11, okRate: 0.9, tag: 'first' }, { multiplier: 0.11, okRate: 0.9, tag: 'second' }]);
ok('并列取先出现的', !!tie && tie.tag === 'first', JSON.stringify(tie));
ok('空候选返回 null', pickCheapest([], {}) === null);
ok('负数倍率被过滤', pickCheapest([{ multiplier: -1, okRate: 1 }]) === null);

// 不可变：传入冻结对象不许炸
let immutable = true;
try { pickCheapest(Object.freeze([Object.freeze({ multiplier: 0.11, okRate: 0.9 })])); }
catch { immutable = false; }
ok('pickCheapest 不改入参', immutable);

// 类型校验
throws('summarizeQuota 非数组抛 TypeError', () => summarizeQuota('x'));

console.log(seen.join('\n'));
console.log(`\n${fail === 0 ? 'quota-ledger: ' : 'quota-ledger FAILED: '}${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
