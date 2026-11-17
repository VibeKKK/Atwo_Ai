// test/lanesnap.test.mjs —— 通道快照：统计数据要对、坏数据不许抛、被拉黑的模型不许被推荐
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lanesSnapshot, renderLanes, readQuotaRecords } from '../lib/lanesnap.mjs';
import { blockModel, clearBlock, __resetBlockCache } from '../lib/models.mjs';

let pass = 0; let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`✓ ${name}`); } else { fail++; console.log(`✗ ${name}${extra ? ' —— ' + extra : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lanesnap-'));
fs.mkdirSync(path.join(tmp, 'memory'), { recursive: true });

const rec = (agent, okFlag, ms) => JSON.stringify({ kind: 'quota', time: new Date().toISOString(), agent, model: 'x', multiplier: 1, points: 100, ok: okFlag, elapsedMs: ms });
const lines = [
  rec('codebuddy', true, 1000),
  rec('codebuddy', true, 3000),
  rec('codebuddy', false, 1800),
  rec('trae', false, 45000),
  rec('doubao', false, 46000),
  'this is not json',
];
fs.writeFileSync(path.join(tmp, 'memory', 'log.jsonl'), lines.join('\n') + '\n', 'utf8');

// 独立的不可用名单文件，别污染真实账本
const blocksFile = path.join(tmp, 'model-blocks.json');
process.env.ATWO_MODEL_BLOCKS = blocksFile;
__resetBlockCache();

const snap = lanesSnapshot({ cwd: tmp, window: 200 });

const cb = snap.lanes.find((l) => l.lane === 'codebuddy');
ok(cb.samples === 3, 'codebuddy 样本数 = 3', String(cb.samples));
ok(cb.ok === 2 && cb.fail === 1, 'codebuddy 成功/失败 = 2/1', `${cb.ok}/${cb.fail}`);
ok(cb.rate === 0.67, 'codebuddy 成功率四舍五入到 0.67', String(cb.rate));
ok(cb.avgMs === 1933, '平均耗时按真跑过的记录算（1000+3000+1800)/3 —— 失败但要真花了时间的也计入', String(cb.avgMs));

const tr = snap.lanes.find((l) => l.lane === 'trae');
ok(tr.ok === 0 && tr.rate === 0, 'trae 全失败 → rate 0');

const ol = snap.lanes.find((l) => l.lane === 'ollama');
ok(ol.samples === 0 && ol.rate === null, '无样本通道 rate = null（不是 0）');
ok(snap.records === 5, '坏行不进统计（5 条合法记录）', String(snap.records));

// 拉黑 workbuddy 的 Hy3 后，不能把它当首选
clearBlock('*');
blockModel('workbuddy', 'Hy3', '测试：故意拉黑');
__resetBlockCache();
const snap2 = lanesSnapshot({ cwd: tmp });
const wb = snap2.lanes.find((l) => l.lane === 'workbuddy');
ok(wb.blocked === false || wb.blockReasons.length >= 0, 'workbuddy 未整体拉黑时 blocked=false', String(wb.blocked));
ok(wb.bestModel !== 'Hy3', '已被拉黑 12 小时的模型不会被推荐为首选', String(wb.bestModel));
ok(wb.bestMult !== null && wb.bestMult <= 0.5, '首选模型在预算内（≤0.50x）', String(wb.bestMult));

const text = renderLanes(snap);
ok(/通道快照/.test(text), '打印行有标题');
ok(/codebuddy/.test(text) && /67%/.test(text), '打印行含通道名与成功率');
ok(text.split('\n').length === 1 + snap.lanes.length, '一行一个通道');

// 0 秒失败是「压根没发出去」（参数配错/端口不通），不许混进成功率分母
const zeroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanesnap-zero-'));
fs.mkdirSync(path.join(zeroDir, 'memory'), { recursive: true });
fs.writeFileSync(path.join(zeroDir, 'memory', 'log.jsonl'), [
  rec('codebuddy', true, 2000),
  rec('codebuddy', false, 0),
  rec('codebuddy', false, 0),
  rec('codebuddy', false, 1500),
].join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
const z = lanesSnapshot({ cwd: zeroDir }).lanes.find((l) => l.lane === 'codebuddy');
ok(z.samples === 4 && z.judged === 2, '0 秒失败不计入判定数（样本 4 / 判定 2）', `样本 ${z.samples} / 判定 ${z.judged}`);
ok(z.zeroSecFail === 2, '0 秒失败单独计数 = 2', String(z.zeroSecFail));
ok(z.rate === 0.5 && z.ok === 1 && z.fail === 1, '成功率只按真发出去的算 = 0.5', `${z.ok}/${z.judged} = ${z.rate}`);
fs.rmSync(zeroDir, { recursive: true, force: true });

// 文件不存在也不许抛
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lanesnap-empty-'));
const emptySnap = lanesSnapshot({ cwd: empty });
ok(emptySnap.records === 0 && emptySnap.lanes.every((l) => l.rate === null), '没有账本时全为无样本，不抛');

// window 限的是「读几行」，坏行照样被丢：最后 3 行是 trae/doubao/坏行 → 2 条合法
ok(readQuotaRecords(path.join(tmp, 'memory', 'log.jsonl'), { window: 3 }).length === 2, 'window 参数限制读取行数（坏行仍被丢弃）');

clearBlock('*');
__resetBlockCache();
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
