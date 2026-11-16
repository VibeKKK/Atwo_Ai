import fs from 'node:fs';
import { runBlind, renderBlind } from '../lib/blind.mjs';
import { askOllama } from '../agents/ollama.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('./blind-manifest.json', import.meta.url), 'utf8'));
const cwd = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' ');
const report = await runBlind({
  cases: manifest.cases, cwd,
  ask: (text, o) => askOllama(text, { cwd, timeoutMs: o.timeoutMs, model: process.env.BLIND_MODEL || 'qwen3:8b' }),
  model: process.env.BLIND_MODEL || 'qwen3:8b',
  timeoutMs: 120000,
});
console.log(renderBlind(report));
for (const c of report.cases) console.log('  ' + c.id.padEnd(8) + c.verdict.padEnd(11) + (c.viaPreGate ? '[机械] ' : '[父审] ') + c.reason.slice(0, 90));
fs.writeFileSync(new URL('./blind-report.json', import.meta.url), JSON.stringify(report, null, 2));
