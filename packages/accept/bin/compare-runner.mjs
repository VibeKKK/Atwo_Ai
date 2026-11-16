// 对拍：同一组用例喂两个实现，比结论是否一致。
// 与 behavior-runner 的分工：那个判「对不对」（要人给期望值），这个判「一样不一样」（不需要期望值）。
// 用得上的场合：跨层契约、重构前后、两个 AI 各写一份同一规格。
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [aPath, bPath, casesPath] = process.argv.slice(2);
if (!aPath || !bPath || !casesPath) {
  console.log(JSON.stringify({ ok: false, fatal: '用法：compare-runner <a.mjs> <b.mjs> <cases.mjs>' }));
  process.exit(0);
}

function show(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

async function runOne(fn, mod) {
  try {
    const got = await fn(mod);
    return { kind: 'value', shown: show(got) };
  } catch (e) {
    return { kind: 'throw', shown: 'throw:' + (e && e.message ? e.message : String(e)) };
  }
}

try {
  const A = await import(pathToFileURL(path.resolve(aPath)).href);
  const B = await import(pathToFileURL(path.resolve(bPath)).href);
  const C = await import(pathToFileURL(path.resolve(casesPath)).href);
  const cases = C.cases || C.default || [];
  if (!Array.isArray(cases) || !cases.length) {
    console.log(JSON.stringify({ ok: false, fatal: '用例文件没有导出 cases 数组' }));
    process.exit(0);
  }
  const diffs = [];
  for (const c of cases) {
    const fn = c.call || c.run || c.fn;
    if (typeof fn !== 'function') { diffs.push({ name: c.name, a: '(用例没有 call/run/fn)', b: '' }); continue; }
    const ra = await runOne(fn, A);
    const rb = await runOne(fn, B);
    if (ra.shown !== rb.shown) diffs.push({ name: c.name, a: ra.shown, b: rb.shown });
  }
  console.log(JSON.stringify({ ok: true, total: cases.length, diffs }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, fatal: e && e.message ? e.message : String(e) }));
}
