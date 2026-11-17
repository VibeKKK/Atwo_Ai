// test/score.test.mjs —— atwo 交付物验收（PRD 10 条）
// 只从公开导出走，任何一条不满足就红。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from '../lib/score.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name + '\n     got ' + a + '\n     want ' + b); }
};
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name + (extra ? ' :: ' + extra : '')); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'score-'));

// 1 kind + 原样透传
const r1 = S.scoreRecord({ task: 't1', assertion: 'a1', ok: true, now: '2026-11-16T03:00:00Z' });
eq('1 scoreRecord kind/passthrough', r1, { kind: 'score', time: '2026-11-16T03:00:00.000Z', task: 't1', assertion: 'a1', ok: true });

// 2 time 归一（Date / ms / 串 / 坏值不抛）
ok('2a Date -> ISO', S.scoreRecord({ now: new Date('2026-11-16T03:00:00Z') }).time === '2026-11-16T03:00:00.000Z');
ok('2b ms -> ISO', S.scoreRecord({ now: Date.UTC(2026, 10, 16, 3) }).time === '2026-11-16T03:00:00.000Z');
ok('2c 坏值不抛且仍是 ISO', (() => { try { const t = S.scoreRecord({ now: 'not-a-date' }).time; return /^\d{4}-\d{2}-\d{2}T/.test(t); } catch { return false; } })());

// 3 ok 严格布尔
eq('3 字符串 true 视为 false', S.scoreRecord({ ok: 'true' }).ok, false);
eq('3b 数字 1 视为 false', S.scoreRecord({ ok: 1 }).ok, false);

// 4 appendScore 建目录 + 一行 JSON + 换行
const f4 = path.join(TMP, 'deep', 'dir', 's.jsonl');
const a4 = S.appendScore(f4, { kind: 'score', time: '2026-11-16T03:00:00.000Z', ok: true });
ok('4a 目录被创建', fs.existsSync(path.dirname(f4)));
ok('4b 文件只有一行且以换行结尾', (() => { const t = fs.readFileSync(f4, 'utf8'); return t.split('\n').filter(Boolean).length === 1 && t.endsWith('\n'); })());
ok('4c 返回 ok:true', a4 && a4.ok === true);

// 5 readScore 缺文件 / 坏行
eq('5a 缺文件 -> []', S.readScore(path.join(TMP, 'nope.jsonl')), []);
fs.writeFileSync(f4, '{"ok":true}\nTHIS IS NOT JSON\n{"ok":false}\n');
eq('5b 坏行跳过', S.readScore(f4).length, 2);

// 6 空集无 NaN
eq('6 summarize([]) 零值', S.summarizeScores([]), { total: 0, passed: 0, failed: 0, rate: 0 });

// 7 rate 3 位小数
eq('7 rate 3dp', S.summarizeScores([{ ok: true }, { ok: false }, { ok: true }]), { total: 3, passed: 2, failed: 1, rate: 0.667 });

// 8 dailyTrend 分日 + 升序
const tr = S.dailyTrend([
  { time: '2026-11-16T01:00:00.000Z', ok: true },
  { time: '2026-11-15T01:00:00.000Z', ok: false },
  { time: '2026-11-16T05:00:00.000Z', ok: false },
]);
eq('8 dailyTrend', tr, [
  { date: '2026-11-15', total: 1, passed: 0, rate: 0 },
  { date: '2026-11-16', total: 2, passed: 1, rate: 0.5 },
]);

// 9 delta 三向 + 任一侧无数据 flat
const dUp = S.delta([
  { time: '2026-11-10T00:00:00.000Z', ok: false },
  { time: '2026-11-16T00:00:00.000Z', ok: true },
], { days: 3 });
ok('9a up', dUp.direction === 'up' && dUp.delta > 0, JSON.stringify(dUp));
ok('9b flat 无数据', S.delta([], { days: 3 }).direction === 'flat');
const dDown = S.delta([
  { time: '2026-11-10T00:00:00.000Z', ok: true },
  { time: '2026-11-16T00:00:00.000Z', ok: false },
], { days: 3 });
ok('9c down', dDown.direction === 'down' && dDown.delta < 0, JSON.stringify(dDown));

// 10 纯函数不改入参
const seed = [{ time: '2026-11-16T01:00:00.000Z', ok: true }];
const snapshot = JSON.stringify(seed);
S.summarizeScores(seed); S.dailyTrend(seed); S.delta(seed, { days: 1 });
eq('10 入参未被修改', JSON.stringify(seed), snapshot);

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed / ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
