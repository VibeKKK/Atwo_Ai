// lib/gate.mjs —— 一条命令跑完所有确定性检查。
//
// 为什么要有它：判断要不要派活是决策成本，而「跑闸门」不该是决策。
// AI 不需要权衡「这次要不要跑测试」，它需要一个不需要权衡的动作。
// 所以 gate 只做确定性的事：跑测试、查运行闭包、查契约、查语法、报告未提交。
// 任何一条红 → 退出 4（验收没过），和 atwo done 同一个口径。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closureOf } from './bootstrap.mjs';
import { findMissingExports, formatMissingExports } from './exports-check.mjs';

function run(cmd, args, cwd, timeoutMs) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ATWO_GATE_NESTED: '1' } });
  const out = (r.stdout || '') + (r.stderr || '');
  return { code: r.status, out, ms: Date.now() - t0, timedOut: !!r.error };
}

/**
 * 找出「源文件里混进了测试内容」的文件。
 *
 * 两次事故同源：模型把代码和测试一起吐出来，落盘时没切开 ——
 * vm/judge.mjs 被整段英文回答覆盖过一次，lib/score.mjs 尾部被粘进整份
 * test/score.test.mjs（以至于 import 它就会跑测试、往 stdout 打 5 行）。
 * 语法层看不出来：粘进去的东西本身是合法 JS。
 */
export function findPollutedSources(cwd) {
  const targets = [];
  for (const d of ['lib', 'vm', 'agents']) {
    const abs = path.join(cwd, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.mjs') && !f.includes('.bak')) targets.push(d + '/' + f);
    }
  }
  if (fs.existsSync(path.join(cwd, 'atwo.mjs'))) targets.push('atwo.mjs');
  const bad = [];
  for (const rel of targets) {
    let src;
    try { src = fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { continue; }
    // 只扫真代码行：文档注释里举「// file: test/x.behavior.mjs」这种格式是说明，不是污染。
    const code = src.split('\n').filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    }).join('\n');
    // 顶格的「// file: test/」才是粘贴痕迹；块注释里缩进举例的（land.mjs 那种）不算。
    const testFileMark = src.split('\n').some((l) => /^\/\/\s*file:\s*test\//.test(l));
    const assertImport = /from\s+'node:assert(\/strict)?'/.test(code);
    const harness = /function\s+test\s*\(\s*name\s*,/.test(code);
    if (testFileMark || (assertImport && harness)) bad.push(rel);
  }
  return bad;
}

function step(name, fn) {
  const t0 = Date.now();
  try {
    const r = fn() || {};
    return { name, ok: r.ok !== false, ms: Date.now() - t0, detail: r.detail || '', skip: !!r.skip };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, detail: '抛错：' + (e && e.message) };
  }
}

/**
 * @param {{cwd?: string, files?: string[], testTimeoutMs?: number, skipTests?: boolean}} [opts]
 */
export function runGate(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const started = Date.now();

  // 闸门自己也在测试里被调用会无限递归 —— 嵌套调用直接跳过测试层并说明原因。
  const nested = process.env.ATWO_GATE_NESTED === '1' || process.env.ATWO_DONE_SKIP_REGRESSION === '1';

  const steps = [];

  steps.push(step('closure', () => {
    const c = closureOf(path.join(cwd, 'atwo.mjs'));
    return c.missing.length
      ? { ok: false, detail: '运行闭包缺 ' + c.missing.length + ' 个：' + c.missing.slice(0, 5).join(', ') }
      : { ok: true, detail: c.files.length + ' 个文件全部在' };
  }));

  steps.push(step('syntax', () => {
    const targets = opts.files && opts.files.length
      ? opts.files
      : ['atwo.mjs', ...fs.readdirSync(path.join(cwd, 'lib')).filter((f) => f.endsWith('.mjs') && !f.includes('.bak')).map((f) => 'lib/' + f)];
    // 半成品不该把闸门堵死：别人正在写的未跟踪文件语法错，只记 ⚠ 不判红。
    // 例外是闭包内的文件 —— 那是 atwo 真要 import 的，坏了就必须红（否则闸门放行一个跑不起来的 atwo）。
    const tracked = new Set();
    const g = run('git', ['ls-files'], cwd, 20000);
    if (g.code === 0) for (const line of (g.out || '').split('\n')) { if (line.trim()) tracked.add(line.trim().replace(/\\/g, '/')); }
    const inClosure = new Set((closureOf(path.join(cwd, 'atwo.mjs')).files || []).map((f) => path.relative(cwd, f).replace(/\\/g, '/')));
    const bad = [];
    const warn = [];
    for (const f of targets) {
      const p = path.isAbsolute(f) ? f : path.join(cwd, f);
      if (!fs.existsSync(p)) { bad.push(f + '（不存在）'); continue; }
      const r = run(process.execPath, ['--check', p], cwd, 30000);
      if (r.code === 0) continue;
      const rel = path.relative(cwd, p).replace(/\\/g, '/');
      const line = f + '：' + r.out.split('\n').filter(Boolean).slice(-1)[0];
      // 只有「在本仓库内、且 git 还没跟踪」才算半成品。仓库外的临时文件（测试造的坏样本）一律判红：
      // 那是调用方显式要求检查的，放过等于闸门对坏样本失明。
      const outsideRepo = rel.startsWith('..') || path.isAbsolute(rel);
      if (outsideRepo || tracked.has(rel) || inClosure.has(rel)) bad.push(line);
      else warn.push(line);
    }
    if (bad.length) return { ok: false, detail: bad.slice(0, 4).join(' | ') + (warn.length ? '（另有 ' + warn.length + ' 个未跟踪文件语法错，不算红）' : '') };
    if (warn.length) return { ok: true, warn: true, detail: targets.length + ' 个文件通过；未跟踪半成品 ' + warn.length + ' 个语法错不阻塞：' + warn.slice(0, 3).join(' | ') };
    return { ok: true, detail: targets.length + ' 个文件语法通过' };
  }));

  // 第 9 步：import 的名字必须真的被导出。
  // 2026-11-17 实测事故：HEAD 的 lib/outcome.mjs import 了 land.mjs 的 selfLanded，
  // 而 selfLanded 只活在某人工作区没提交 —— git clone 之后 atwo 直接起不来，
  // 干净 checkout 跑 test/all.mjs 13 个测试全红。closure 只查文件在不在，查不出这个。
  steps.push(step('exports', () => {
    const problems = findMissingExports(cwd);
    return problems.length
      ? { ok: false, detail: '引用了不存在的导出（裸 clone 会起不来）：' + formatMissingExports(problems) }
      : { ok: true, detail: '具名导入与导出一致' };
  }));
  steps.push(step('contract', () => {
    const p = path.join(cwd, 'vm', 'oracle-contract.json');
    if (!fs.existsSync(p)) return { ok: false, detail: '没有 vm/oracle-contract.json' };
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    const need = [
      ['cut.high', c.cut && c.cut.high],
      ['cut.mid', c.cut && c.cut.mid],
      ['votes.arity', c.votes && c.votes.arity],
      ['contractVersion', c.contractVersion],
    ].filter(([, v]) => v == null).map(([k]) => k);
    if (need.length) return { ok: false, detail: '契约缺字段：' + need.join(', ') };
    // 阈值只许在契约里出现一次：代码里出现 0.45/0.22 字面量就算漂移。
    const drift = [];
    for (const rel of ['vm/judge.mjs', 'vm/votes.mjs']) {
      const f = path.join(cwd, rel);
      if (!fs.existsSync(f)) continue;
      const src = fs.readFileSync(f, 'utf8');
      // 只扫代码行：块注释里的「不许写 0.45」是说明文字，不是写死。
      const code = src.split('\n').filter((l) => {
        const t = l.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      }).join('\n').replace(/\/\/.*$/gm, '');
      if (/0\.45|0\.22|0\.8\b/.test(code)) drift.push(rel);
    }
    return drift.length
      ? { ok: false, detail: '阈值被写死进代码：' + drift.join(', ') + '（改契约，不要改代码）' }
      : { ok: true, detail: '契约 v' + c.contractVersion + ' 字段齐、阈值未写死' };
  }));

  steps.push(step('vm-smoke', () => {
    // 契约里写的参考向量，必须被本机 VM 重算出同一批 value。
    // 上一版问题：contract 步只查「阈值没写死在代码里」，查不出「阈值被改了」。
    // 2026-11-16 实测：cut.high 0.45→0.50，gate 全绿，但同一份 z 的结论从可判翻成存疑。
    const smoke = path.join(cwd, 'vm', 'smoke.mjs');
    if (!fs.existsSync(smoke)) return { ok: true, skip: true, detail: '没有 vm/smoke.mjs（老仓库）' };
    const r = run(process.execPath, [smoke], cwd, 60000);
    let out = null;
    const text = r.out.trim().split('\n').pop() || '';
    try { out = JSON.parse(text); } catch { /* 下面按退出码报 */ }
    if (!out) return { ok: false, detail: 'vm/smoke.mjs 没输出可解析的 JSON（退出码 ' + r.code + '）' };
    if (out.ok) return { ok: true, detail: out.checked + ' 组参考向量重算一致（契约 v' + out.contractVersion + '）' };
    const first = (out.failed && out.failed[0]) || {};
    return { ok: false, detail: '参考向量重算不一致（' + (out.failed ? out.failed.length : 0) + ' 组）：' + (first.name || '?') + ' —— ' + (first.why || '') };
  }));

  steps.push(step('tests', () => {
    if (nested) return { ok: true, skip: true, detail: '嵌套调用（闸门在测试里被调），跳过回归避免递归' };
    if (opts.skipTests) return { ok: true, skip: true, detail: '--no-tests' };
    const r = run(process.execPath, ['test/all.mjs'], cwd, opts.testTimeoutMs || 300000);
    const tail = r.out.split('\n').filter(Boolean).slice(-1)[0] || '';
    return { ok: r.code === 0, detail: tail.trim() };
  }));

  steps.push(step('pollution', () => {
    const bad = findPollutedSources(cwd);
    return bad.length
      ? { ok: false, detail: '源文件里混进了测试内容：' + bad.join(', ') + '（把测试拆回 test/，源文件只留实现）' }
      : { ok: true, detail: '源文件是源文件' };
  }));

  steps.push(step('accept', () => {
    const files = (opts.files || []).filter((f) => /\.mjs$/.test(f));
    if (!files.length) return { ok: true, skip: true, detail: '没指定文件（给 --files 才跑五层验收）' };
    const bad = [];
    for (const f of files) {
      const r = run(process.execPath, [path.join(cwd, 'packages/accept/bin/accept.mjs'), f, '--json'], cwd, 60000);
      if (r.code !== 0) bad.push(f);
    }
    return bad.length ? { ok: false, detail: '验收未过：' + bad.join(', ') } : { ok: true, detail: files.length + ' 个文件五层验收通过' };
  }));

  steps.push(step('uncommitted', () => {
    const r = run('git', ['status', '--porcelain'], cwd, 20000);
    if (r.code !== 0) return { ok: true, skip: true, detail: '不是 git 仓库' };
    const n = r.out.split('\n').filter(Boolean).length;
    return { ok: true, detail: n ? n + ' 项未提交（不影响闸门，但别人看不见）' : '干净' };
  }));

  const failed = steps.filter((s) => !s.ok);
  return {
    contract: 'atwo-gate/1',
    ok: failed.length === 0,
    elapsedMs: Date.now() - started,
    steps,
    failed: failed.map((s) => s.name),
    nested,
    next: failed.length
      ? '先修 ' + failed.map((s) => s.name).join('、') + '，再看 ' + failed[0].detail
      : '可以提交了（atwo gate 全绿）',
  };
}

export function formatGate(r) {
  const lines = ['闸门 ' + (r.ok ? '✓ 全绿' : '✗ ' + r.failed.join('、') + ' 没过') + ' · ' + r.elapsedMs + 'ms'];
  for (const s of r.steps) {
    const mark = s.skip ? '– ' : s.ok ? '✓ ' : '✗ ';
    lines.push('  ' + mark + s.name.padEnd(12) + String(s.ms).padStart(6) + 'ms  ' + s.detail);
  }
  lines.push('');
  lines.push(r.next);
  return lines.join('\n');
}
