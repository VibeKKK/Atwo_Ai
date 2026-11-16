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

function run(cmd, args, cwd, timeoutMs) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ATWO_GATE_NESTED: '1' } });
  const out = (r.stdout || '') + (r.stderr || '');
  return { code: r.status, out, ms: Date.now() - t0, timedOut: !!r.error };
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
    const bad = [];
    for (const f of targets) {
      const p = path.isAbsolute(f) ? f : path.join(cwd, f);
      if (!fs.existsSync(p)) { bad.push(f + '（不存在）'); continue; }
      const r = run(process.execPath, ['--check', p], cwd, 30000);
      if (r.code !== 0) bad.push(f + '：' + r.out.split('\n').filter(Boolean).slice(-1)[0]);
    }
    return bad.length ? { ok: false, detail: bad.slice(0, 4).join(' | ') } : { ok: true, detail: targets.length + ' 个文件语法通过' };
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

  steps.push(step('tests', () => {
    if (nested) return { ok: true, skip: true, detail: '嵌套调用（闸门在测试里被调），跳过回归避免递归' };
    if (opts.skipTests) return { ok: true, skip: true, detail: '--no-tests' };
    const r = run(process.execPath, ['test/all.mjs'], cwd, opts.testTimeoutMs || 300000);
    const tail = r.out.split('\n').filter(Boolean).slice(-1)[0] || '';
    return { ok: r.code === 0, detail: tail.trim() };
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
