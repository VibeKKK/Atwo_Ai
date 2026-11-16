// eval/run-fanout-eval.mjs —— 回放金标准题集，量漏判率 / 误杀率。
// 用法：node eval/run-fanout-eval.mjs [--model glm-5.3-flash] [--json]
import { fileURLToPath } from 'node:url';
import { CASES } from './fanout-cases.mjs';
import { buildReviewPrompt, parseReview, VERDICT } from '../lib/fanout.mjs';
import { askCodeBuddy } from '../agents/codebuddy.mjs';

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const models = get('--model', 'deepseek-v4.1-flash,glm-5.3-flash').split(',').map((s) => s.trim()).filter(Boolean);
const asJson = argv.includes('--json');
const cwd = fileURLToPath(new URL('..', import.meta.url)); // pathname 带 %20，spawn 的 cwd 会 ENOENT

async function runCase(c, model) {
  const t0 = Date.now();
  const r = await askCodeBuddy(buildReviewPrompt(c.task, c.children), { cwd, timeoutMs: 180000, model, tools: 'Read' });
  const reviews = parseReview(r.addedText || '', c.children.map((x) => x.id));
  const byId = Object.fromEntries(reviews.map((x) => [x.id, x]));
  return {
    id: c.id,
    model,
    ms: Date.now() - t0,
    wrongCaught: byId.c2 && byId.c2.verdict === VERDICT.revise,   // 植入错误是否被抓
    falseAlarm: byId.c1 && byId.c1.verdict === VERDICT.revise,     // 正确答案是否被误杀
    c3: byId.c3 ? byId.c3.verdict : 'unreviewed',
    quoted: /EXIT|MAX_PARTS|arity|0\.45|0\.22|11 个|Z_LIMIT/.test(reviews.map((x) => x.reason).join(' ')),
    reviews,
  };
}

const rows = [];
for (const model of models) {
  const out = await Promise.all(CASES.map((c) => runCase(c, model)));
  rows.push(...out);
}

const sum = (arr, f) => arr.filter(f).length;
const report = models.map((m) => {
  const rs = rows.filter((r) => r.model === m);
  return {
    model: m,
    cases: rs.length,
    caught: sum(rs, (r) => r.wrongCaught),
    missed: sum(rs, (r) => !r.wrongCaught),
    falseAlarm: sum(rs, (r) => r.falseAlarm),
    quoted: sum(rs, (r) => r.quoted),
    avgMs: Math.round(rs.reduce((a, r) => a + r.ms, 0) / rs.length),
  };
});

if (asJson) {
  console.log(JSON.stringify({ report, rows: rows.map(({ reviews, ...r }) => r) }, null, 1));
} else {
  for (const r of report) {
    console.log(`${r.model}  题数 ${r.cases}  抓到错 ${r.caught}  漏判 ${r.missed}  误杀 ${r.falseAlarm}  引用原文 ${r.quoted}  均 ${r.avgMs}ms`);
  }
  const missedRows = rows.filter((r) => !r.wrongCaught);
  if (missedRows.length) {
    console.log('\n漏判明细：');
    for (const m of missedRows) console.log('  ' + m.model + ' / ' + m.id + ' → ' + m.reviews.map((x) => x.id + ':' + x.verdict).join(' '));
  }
  const fa = rows.filter((r) => r.falseAlarm);
  if (fa.length) {
    console.log('\n误杀明细：');
    for (const m of fa) console.log('  ' + m.model + ' / ' + m.id + ' → ' + (m.reviews.find((x) => x.id === 'c1') || {}).reason);
  }
}
const bad = report.some((r) => r.missed > 0);
process.exit(bad ? 1 : 0);
