// test/review_pitfall.test.mjs —— 父审「不带引文就判 REVISE」必须自动进坑账本。
// 起因（2026-11-17）：坑账本一直靠人手记；而这类事件机器每次都看得见（会被 requireCitation 降级）。
// 验收标准：一次真实派活之后，memory/pitfalls.jsonl（或 ATWO_PITFALL 指的临时文件）里出现一条
// trigger=评审不带引文 的记录，且派活本身不受记账影响。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFanout } from '../lib/fanout-run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; } else { fail += 1; console.log('  ✗ ' + m); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-pitfall-'));
const book = path.join(tmp, 'pitfalls.jsonl');
process.env.ATWO_PITFALL = book;
delete process.env.ATWO_NO_PITFALL;

// 父审「无引文就判 REVISE」→ parseReview 得到 REVISE、理由里没有「文件:行」→ 降级为没结论
const badReviewer = async () => ({ ok: true, addedText: 'VERDICT: REVISE\n理由：这一片的结论讲得太笼统，我觉得不行。\n' });
const writer = async () => ({ ok: true, addedText: 'ANSWER:\n我改了 split.mjs 的聚类阈值。\nEVIDENCE:\n读了 lib/split.mjs。\n' });

const res = await runFanout({
  task: '核对 lib/durfmt.mjs 的注释是否够用，给结论。',
  ask: writer,
  reviewAsk: badReviewer,
  cwd: root,
  noVerify: true,
});

ok(!!res, '派活本身要返回结果（记账不许影响主流程）');
const downgraded = (res.reviews || []).filter((r) => r && r.downgraded === 'revise-without-citation');
ok(downgraded.length > 0, '这条 REVISE 应被降级为没结论（实得 ' + downgraded.length + ' 条）');

const exists = fs.existsSync(book);
ok(exists, '坑账本文件应被创建：' + book);
let lines = [];
if (exists) lines = fs.readFileSync(book, 'utf8').split(/\r?\n/).filter((s) => s.trim());
ok(lines.length >= 1, '至少要落一条坑（实得 ' + lines.length + '）');
let rec = null;
for (const ln of lines) { try { rec = JSON.parse(ln); } catch { /* 跳过坏行 */ } }
ok(!!rec, '落盘的要是一行合法 JSON');
ok(rec && rec.trigger === '评审不带引文', 'trigger 应为「评审不带引文」（实得 ' + (rec && rec.trigger) + '）');
ok(rec && String(rec.lesson || '').includes('降级'), 'lesson 里要写清「被降级为没结论」');
ok(rec && String(rec.fix || '').includes('引文'), 'fix 里要给出「必须给引文」的修法');
ok(rec && String(rec.lesson || '').includes('原话：'), 'lesson 要带「原话：」前缀，保留可追溯的原始理由');

// 有引文的真 REVISE 不该落账（否则账本会被正常打回灌满）
// 注意：写手的 EVIDENCE 也必须带「文件:行」，否则机械闸门会独立造成一次「无引文降级」，
// 那就测不出「父审有引文时不落账」这件事（这是第一版写错的地方）。
{
  const book3 = path.join(tmp, 'pitfalls-cited.jsonl');
  process.env.ATWO_PITFALL = book3;
  const writerCited = async () => ({ ok: true, addedText: 'ANSWER:\n改了 split.mjs 的聚类阈值。\nEVIDENCE:\nlib/split.mjs:151 这个函数就是 chunkTask。\n' });
  const cited = async () => ({ ok: true, addedText: 'VERDICT: REVISE\n理由：lib/fanout-run.mjs:308 这行的判定条件写反了。\n' });
  await runFanout({ task: '核对 lib/durfmt.mjs 的注释是否够用，给结论。', ask: writerCited, reviewAsk: cited, cwd: root, noVerify: true });
  const n = fs.existsSync(book3) ? fs.readFileSync(book3, 'utf8').split(/\r?\n/).filter((s) => s.trim()).length : 0;
  ok(n === 0, '写手与父审都有「文件:行」时不该进坑账本（实得 ' + n + ' 条）');
  process.env.ATWO_PITFALL = book;
}

// ATWO_NO_PITFALL=1 时不许落账（跑测试/全量时不许污染真账本）
{
  const book2 = path.join(tmp, 'pitfalls-off.jsonl');
  process.env.ATWO_PITFALL = book2;
  process.env.ATWO_NO_PITFALL = '1';
  await runFanout({ task: '核对 lib/durfmt.mjs 的注释是否够用，给结论。', ask: writer, reviewAsk: badReviewer, cwd: root, noVerify: true });
  ok(!fs.existsSync(book2), 'ATWO_NO_PITFALL=1 时不该落账');
  delete process.env.ATWO_NO_PITFALL;
  process.env.ATWO_PITFALL = book;
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exit(1);
