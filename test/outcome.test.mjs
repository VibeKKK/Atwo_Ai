// lib/outcome.mjs 的判据测试：成败只看产物，且有两条「必须抓到」的反向断言。
// 反向断言比正向更值钱：假成功比真失败贵得多。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeOutcome, formatOutcome, exitForOutcome, judgeStall, predictRun, MIN_BYTES, STALL_MS } from '../lib/outcome.mjs';

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra ? ' :: ' + extra : ''));
}
function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  return dir;
}

// ——— 1. 盘上没有产物 → failed（退出码说成功也不算）———
{
  const dir = mk();
  const r = judgeOutcome({ srcText: '交付 lib/none.mjs', sinceMs: Date.now() - 60000, cwd: dir });
  ok('无产物 → failed', r.verdict === 'failed', r.verdict);
  ok('无产物 hint 说清', /盘上没有产物/.test(r.hint), r.hint);
  ok('无产物不编造 verified', r.verified.length === 0);
}

// ——— 2. 产物在本轮之后落盘 + 语法过 → ok ———
{
  const dir = mk();
  const t0 = Date.now();
  fs.writeFileSync(path.join(dir, 'lib', 'good.mjs'), 'export const a = 1;\n');
  const r = judgeOutcome({ srcText: '交付 lib/good.mjs', sinceMs: t0, cwd: dir });
  ok('产物在 + 语法过 → ok', r.verdict === 'ok', r.verdict);
  ok('ok 时带回路径', r.landed.length === 1 && /good\.mjs$/.test(r.landed[0].path));
  ok('ok 时语法已验', r.verified.length === 1 && r.verified[0].syntax === true);
}

// ——— 3. 语法坏 → partial（不是 failed，也不是 ok）———
{
  const dir = mk();
  const t0 = Date.now();
  fs.writeFileSync(path.join(dir, 'lib', 'bad.mjs'), 'export const = ;\n');
  const r = judgeOutcome({ srcText: '交付 lib/bad.mjs', sinceMs: t0, cwd: dir });
  ok('语法坏 → partial', r.verdict === 'partial', r.verdict);
  ok('partial 给下一步', /修/.test(r.hint), r.hint);
}

// ——— 4. 反向：旧产物不许冒充本次产出 ———
{
  const dir = mk();
  const old = path.join(dir, 'lib', 'stale.mjs');
  fs.writeFileSync(old, 'export const b = 2;\n');
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(old, past, past);
  const r = judgeOutcome({ srcText: '交付 lib/stale.mjs', sinceMs: Date.now() - 60000, cwd: dir });
  ok('反向：旧文件不算本次产物', r.verdict === 'failed', r.verdict);
}

// ——— 5. 太小的文件不默认判死（阈值 8B，能不能用交给语法闸）———
{
  const dir = mk();
  const t0 = Date.now();
  fs.writeFileSync(path.join(dir, 'lib', 'tiny.mjs'), 'let x=1\n');
  const r = judgeOutcome({ srcText: '交付 lib/tiny.mjs', sinceMs: t0, cwd: dir });
  ok('小文件也是产物', r.verdict === 'ok', r.verdict);
  ok('MIN_BYTES 是 8', MIN_BYTES === 8, String(MIN_BYTES));
}

// ——— 6. 非 JS 产物：不假装验过 ———
{
  const dir = mk();
  const t0 = Date.now();
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'note.md'), '# hi\n\n产物优先：先看盘上有没有东西。\n');
  const r = judgeOutcome({ srcText: '交付 docs/note.md', sinceMs: t0, cwd: dir });
  ok('md 产物 → ok', r.verdict === 'ok', r.verdict);
  ok('md 不编造语法验证', r.verified.length === 0, JSON.stringify(r.verified));
}

// ——— 7. 回执与退出码 ———
{
  const lines = formatOutcome({ verdict: 'ok', landed: [{ path: 'lib/a.mjs', size: 12 }], verified: [], hint: '' });
  ok('回执首行带勾', lines[0].startsWith('✓ 结果：ok'), lines[0]);
  ok('回执带产物行', /产物：lib\/a\.mjs 12B/.test(lines[1]), lines[1]);
  ok('ok 时退出码归零', exitForOutcome(5, { verdict: 'ok' }) === 0);
  ok('failed 时保留原码', exitForOutcome(5, { verdict: 'failed' }) === 5);
  ok('partial 时保留原码', exitForOutcome(4, { verdict: 'partial' }) === 4);
}

// ——— 8. 停摆判据 ———
{
  const s1 = judgeStall({ lastOutputAt: Date.now() - 1000, now: Date.now() });
  ok('刚有输出不算卡', s1.stalled === false);
  const s2 = judgeStall({ lastOutputAt: Date.now() - STALL_MS - 500, now: Date.now() });
  ok('超过阈值判卡住', s2.stalled === true);
  ok('卡住文案报秒数', /秒没有新输出/.test(s2.text), s2.text);
  const s3 = judgeStall({ lastOutputAt: 0, now: Date.now() });
  ok('从没输出过不算卡（还没开始）', s3.stalled === false);
}

// ——— 9. 四行预测 ———
{
  const recs = [];
  for (let i = 0; i < 10; i += 1) recs.push({ agent: 'codebuddy', ok: i < 8, elapsedMs: 30000 + i * 1000 });
  for (let i = 0; i < 4; i += 1) recs.push({ agent: 'workbuddy', ok: i < 2, elapsedMs: 90000 });
  const p = predictRun({ records: recs, lanes: ['codebuddy', 'workbuddy'], units: 6 });
  ok('预测四行', p.lines.length === 4, String(p.lines.length));
  ok('预测报路数', /2 路（codebuddy, workbuddy）/.test(p.lines[0]), p.lines[0]);
  ok('预测用 p50 而不是平均', /预计：\d+s（按 workbuddy 的 p50）/.test(p.lines[1]), p.lines[1]);
  ok('预测点名最弱通道', /workbuddy 近 4 次成功率 50%/.test(p.lines[2]), p.lines[2]);
  const empty = predictRun({ records: [], lanes: ['trae'] });
  ok('没样本就明说算不出', /算不出/.test(empty.lines[1]), empty.lines[1]);
  ok('没样本不编成功率', /没有历史样本/.test(empty.lines[2]), empty.lines[2]);
}

if (fails.length) {
  console.log('outcome.test.mjs: ' + pass + ' 通过 / ' + fails.length + ' 失败');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('outcome.test.mjs: ' + pass + ' 通过 / 0 失败');
