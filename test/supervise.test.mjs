// lib/supervise.mjs 的回归断言 —— PRD 21 条用例 + 若干边界
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLines, progressLine, classifyLine, decideAbort, summarizeRun } from '../lib/supervise.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
void HERE;

let pass = 0;
let fail = 0;
const out = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; out.push(`  ✓ ${name}`); }
  else { fail += 1; out.push(`  ✗ ${name}${detail ? `  ← ${detail}` : ''}`); }
};
const throws = (name, fn) => {
  try { fn(); fail += 1; out.push(`  ✗ ${name}  ← 没抛错`); }
  catch (e) {
    if (e instanceof TypeError) { pass += 1; out.push(`  ✓ ${name}`); }
    else { fail += 1; out.push(`  ✗ ${name}  ← 抛的是 ${e.constructor.name}`); }
  }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// —— parseLines
const p1 = parseLines('a\nb\nc');
ok('#1 切行并留 rest', eq(p1.lines, ['a', 'b']) && p1.rest === 'c', JSON.stringify(p1));
const p2 = parseLines('a\r\nb\r\n');
ok('#2 容忍 CRLF', eq(p2.lines, ['a', 'b']) && p2.rest === '', JSON.stringify(p2));
ok('#3 空串', eq(parseLines(''), { lines: [], rest: '' }));
throws('#4 非字符串抛 TypeError', () => parseLines(123));

// —— progressLine
ok('#5 12.3s', progressLine({ elapsedMs: 12300, text: 'x' }) === '[  12.3s] x', progressLine({ elapsedMs: 12300, text: 'x' }));
ok('#6 120.0s 且去空白', progressLine({ elapsedMs: 120000, text: '  x  ' }) === '[ 120.0s] x', progressLine({ elapsedMs: 120000, text: '  x  ' }));
ok('#7 负耗时归零、空文本只留时间', progressLine({ elapsedMs: -5, text: '' }) === '[   0.0s]', progressLine({ elapsedMs: -5, text: '' }));

// —— classifyLine
ok('#8 0 字符 → channel-dead', classifyLine('trae ok=false 0 字符') === 'channel-dead', classifyLine('trae ok=false 0 字符'));
ok('#9 已返回 → channel-ok', classifyLine('codebuddy 已返回 3980 字符') === 'channel-ok', classifyLine('codebuddy 已返回 3980 字符'));
ok('#10 评审 → review', classifyLine('进入评审 2 个') === 'review', classifyLine('进入评审 2 个'));
ok('#11 形状 → accept', classifyLine('形状 过') === 'accept', classifyLine('形状 过'));
ok('#12 其它 → noise', classifyLine('随便一行') === 'noise', classifyLine('随便一行'));
// 附加：3980 字符不许被误判成死
ok('附：3980 字符不算死', classifyLine('3980 字符') !== 'channel-dead', classifyLine('3980 字符'));

// —— decideAbort
const d13 = decideAbort({ elapsedMs: 600000, deadlineMs: 600000 });
ok('#13 到点即超时', d13.abort === true && d13.exitCode === 5 && d13.reason === '超时', JSON.stringify(d13));
const d14 = decideAbort({ channels: [{ name: 'a', ok: false }, { name: 'b', ok: false }], expectedChannels: 2 });
ok('#14 全通道失败', d14.abort === true && d14.exitCode === 5 && d14.reason === '全部通道失败', JSON.stringify(d14));
const d15 = decideAbort({ channels: [{ name: 'a', ok: true }], expectedChannels: 2 });
ok('#15 有人成功就不掐', d15.abort === false, JSON.stringify(d15));
const d16 = decideAbort({ sawReview: true, channels: [{ name: 'a', ok: false }], expectedChannels: 1 });
ok('#16 无产物时评审无意义', d16.abort === true && d16.exitCode === 5 && d16.reason === '没有可用产物，评审无意义', JSON.stringify(d16));
const d17 = decideAbort({ lastLine: 'ok=false 空文本', channels: [], expectedChannels: 1 });
ok('#17 唯一通道已失败', d17.abort === true && d17.exitCode === 5 && d17.reason === '唯一通道已失败', JSON.stringify(d17));
const d18 = decideAbort({});
ok('#18 空状态不掐', d18.abort === false && d18.exitCode === 0, JSON.stringify(d18));
// 附加：不设上限时不该因超时误杀
const dNoDeadline = decideAbort({ elapsedMs: 9e9, deadlineMs: 0 });
ok('附：deadlineMs<=0 视为不设上限', dNoDeadline.reason !== '超时', JSON.stringify(dNoDeadline));

// —— summarizeRun
const s19 = summarizeRun({ channels: [{ name: 'a', ok: true }, { name: 'b', ok: true }], elapsedMs: 34200 });
ok('#19 全成功', s19.ok === true && s19.text === '2/2 路成功 · 用时 34.2s', JSON.stringify(s19));
const s20 = summarizeRun({ channels: [{ name: 'a', ok: true }, { name: 'b', ok: false, reason: '空文本' }], elapsedMs: 140000 });
ok('#20 部分成功', s20.ok === true && s20.text.includes('1/2 路成功') && s20.text.includes('b 空文本'), JSON.stringify(s20));
const s21 = summarizeRun({ channels: [{ name: 'a', ok: false, reason: '超时' }], elapsedMs: 300000 });
ok('#21 全失败', s21.ok === false && s21.text.includes('0/1 路成功'), JSON.stringify(s21));

console.log(out.join('\n'));
console.log(`\n${fail === 0 ? 'supervise: ' : 'supervise FAILED: '}${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
