// 一次性脚本：把最近一次 codebuddy 与 trae 的评测结果合并成 eval/baseline.json
// 目的：给出「可复算的基线」，以后任何改动都能拿它对比，而不是凭印象说变好了。
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'eval/results';
const picks = {
  codebuddy: '20261115-021706-codebuddy.json',
  trae: '20261114-212803-trae.json',
};

const out = {
  schema: 'orch-eval-baseline/v1',
  generatedAt: new Date().toISOString(),
  note:
    '每题的 ok 取 rows[].checks 里是否存在 ok===false（rows[].ok 字段是 undefined，别用它判成败）。' +
    'trae 的样本只有 4 题：2026-11-15 02:17 跑 8 题时整体超时（15 分钟未完成），未产生结果文件。',
  agents: {},
};

for (const [agent, file] of Object.entries(picks)) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) { out.agents[agent] = { missing: p }; continue; }
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  const tasks = {};
  for (const row of r.rows || []) {
    const failed = (row.checks || []).some((c) => c && c.ok === false);
    tasks[row.id || row.task || row.name || '?'] = {
      pass: !failed,
      ms: row.ms || row.durationMs || null,
      chars: (row.text || row.answer || '').length,
      error: row.error || null,
    };
  }
  const total = Object.keys(tasks).length;
  const pass = Object.values(tasks).filter((t) => t.pass).length;
  out.agents[agent] = {
    source: file,
    ranAt: r.ts || null,
    total,
    pass,
    rate: total ? +(pass / total).toFixed(4) : null,
    avgMs: r.avgMs || (r.durationMs && total ? Math.round(r.durationMs / total) : null),
    tasks,
  };
}

fs.writeFileSync('eval/baseline.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
for (const [a, v] of Object.entries(out.agents)) {
  console.log(`${a}: ${v.pass}/${v.total} = ${(v.rate * 100).toFixed(1)}%  均 ${v.avgMs}ms  源 ${v.source}`);
}
console.log('→ eval/baseline.json');
