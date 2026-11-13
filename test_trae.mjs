import { askTrae } from './agents/trae.mjs';
const prompt = process.argv[2] || '只回复两个字：收到';
console.log('SEND:', prompt);
const t0 = Date.now();
try {
  const r = await askTrae(prompt, { timeoutMs: 90000, settleMs: 3000 });
  console.log('OK  elapsed=', Math.round((Date.now()-t0)/1000)+'s');
  console.log('TAIL:', r.fullTail.slice(-500));
} catch (e) {
  console.log('FAIL', e.message);
}
