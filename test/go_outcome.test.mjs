// P0-1「产物优先」回归：成败看盘上的产物，不看进程退出码。
// 用假 orchestra（写文件后永不退出）造「超时但产物已落」这个真实事故形状。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.resolve(import.meta.dirname, '..');
const ATWO = path.join(HERE, 'atwo.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'go-outcome-'));
const MODE = path.join(HERE, '.atw', 'mode.json');

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed += 1; }
};
const eq = (a, b, why) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${why || ''} 期望 ${B}，实际 ${A}`);
};

// 假 orchestra：ms 后写 body，然后永不退出（模拟「产物已落但进程被超时砍掉」）
const fake = (ms, body) => {
  const p = path.join(TMP, `orch_${ms}_${Math.random().toString(36).slice(2, 6)}.mjs`);
  fs.writeFileSync(p, [
    "import fs from 'node:fs';",
    `setTimeout(() => { fs.writeFileSync(${JSON.stringify('lib/p01_probe.mjs')}, ${JSON.stringify(body)}, 'utf8'); }, ${ms});`,
    'setInterval(() => {}, 1000);',
  ].join('\n'), 'utf8');
  return p;
};

const runGo = ({ orch, deadline, target = 'lib/p01_probe.mjs' }) => {
  const r = spawnSync(process.execPath, [ATWO, 'go', `交付 ${target}`, '--size', 'S', '--json'], {
    cwd: HERE,
    encoding: 'utf8',
    env: { ...process.env, ATWO_ORCH: orch, ATWO_GO_DEADLINE_MS: String(deadline), ORCH_NO_CACHE: '1' },
  });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* 拿不到 JSON 就让断言去报 */ }
  return { status: r.status, json: j };
};

const probe = path.join(HERE, 'lib', 'p01_probe.mjs');
const hadMode = fs.existsSync(MODE);
const savedMode = hadMode ? fs.readFileSync(MODE, 'utf8') : null;

try {
  // 让 go 不要求「有进行中的任务」：mode off 只影响派活前的检查
  fs.mkdirSync(path.dirname(MODE), { recursive: true });
  fs.writeFileSync(MODE, JSON.stringify({ name: 'off' }), 'utf8');

  t('超时但产物已落 + 语法过 → ok，退出码 0', () => {
    fs.rmSync(probe, { force: true });
    const { status, json } = runGo({ orch: fake(800, 'export const a = 1;\n'), deadline: 2500 });
    eq(status, 0, '退出码');
    eq(json && json.data && json.data.outcome && json.data.outcome.verdict, 'ok', 'verdict');
    eq(fs.existsSync(probe), true, '产物应在盘上');
  });

  t('没产物 → failed，退出码非 0', () => {
    fs.rmSync(probe, { force: true });
    const { status, json } = runGo({ orch: fake(5000, 'export const a = 1;\n'), deadline: 600 });
    eq(status !== 0, true, '退出码应非 0');
    eq(json && json.data && json.data.outcome && json.data.outcome.verdict, 'failed', 'verdict');
  });

  t('产物落下了但语法坏 → partial', () => {
    fs.rmSync(probe, { force: true });
    const { json } = runGo({ orch: fake(800, 'export const a = ;\n'), deadline: 2500 });
    eq(json && json.data && json.data.outcome && json.data.outcome.verdict, 'partial', 'verdict');
  });

  t('outcome 里带产物路径与大小（可核对）', () => {
    fs.rmSync(probe, { force: true });
    const { json } = runGo({ orch: fake(800, 'export const a = 1;\n'), deadline: 2500 });
    const o = json && json.data && json.data.outcome;
    eq(Array.isArray(o && o.landed) && o.landed.length, 1, 'landed 条数');
    eq(typeof o.landed[0].size === 'number' && o.landed[0].size > 0, true, 'size');
    eq(path.basename(String(o.landed[0].path)), 'p01_probe.mjs', '路径');
  });
} finally {
  if (savedMode === null) fs.rmSync(MODE, { force: true });
  else fs.writeFileSync(MODE, savedMode, 'utf8');
  fs.rmSync(probe, { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\ngo_outcome: ${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
