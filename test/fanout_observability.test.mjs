// test/fanout_observability.test.mjs —— 父审那条链的可观测性：空片要有理由，原始输出要落盘。
// 起因（2026-11-16 实测）：6 片跑完 3 条「父会话没有对这条给票」，而 reviewRaw 没落盘 →
// 事后无法区分「父审漏答」「解析失败」「调用失败」。可观测性缺口比 bug 更贵。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFanout } from '../lib/fanout.mjs';
import { runFanout } from '../lib/fanout-run.mjs';
import { detectUnits } from '../lib/split.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; } else { fail += 1; console.log('  ✗ ' + m); } };

// 1. 被 .gitignore 命中的文件不该派下去（子会话的 Glob 看不见它们 → 必然假 REVISE）
{
  const withIgnore = detectUnits('统计 lib/*.mjs 全部文件', { cwd: root });
  const raw = detectUnits('统计 lib/*.mjs 全部文件', { cwd: root, keepIgnored: true });
  ok(raw.length > withIgnore.length, '1 keepIgnored 时单元更多（' + raw.length + ' > ' + withIgnore.length + '）');
  const leaked = withIgnore.filter((u) => /\.bak|\.(codebuddy|doubao|trae|workbuddy)\.mjs$|mode_badge/.test(u.unit));
  ok(leaked.length === 0, '1b 过滤后没有草稿/备份/忽略文件，实得 ' + leaked.map((x) => x.unit).join(','));
  ok(raw.some((u) => /\.(codebuddy|doubao|trae|workbuddy)\.mjs$/.test(u.unit)), '1c 原始清单里确实有这些草稿（说明过滤真的起作用）');
}

// 2. writeFanout：原始输出与父审错误都要落盘
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-obs-'));
  const file = writeFanout(dir, {
    task: 't',
    children: [{ id: 'child-1', answer: 'a', evidence: 'lib/split.mjs:5', elapsedMs: 1 }],
    reviews: [{ id: 'child-1', verdict: 'PASS', reason: 'ok' }],
    summary: { state: 'ACCEPT', counts: { PASS: 1, REVISE: 0, unreviewed: 0 }, error: '父审超时' },
    meta: null,
    reviewRaw: '[{"id":"child-1","verdict":"PASS"}]',
  });
  const md = fs.readFileSync(file, 'utf8');
  ok(md.includes('- 父审错误: 父审超时'), '2 FANOUT.md 记下父审错误');
  ok(fs.existsSync(path.join(dir, 'REVIEW-RAW.md')), '2b REVIEW-RAW.md 已落盘');
  ok(fs.readFileSync(path.join(dir, 'REVIEW-RAW.md'), 'utf8').includes('child-1'), '2c 原始输出内容完整');
  ok(md.includes('## 父审原始输出'), '2d FANOUT.md 指到原始输出');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3. 空片不能静默记成「父审没给票」
{
  let reviewCalls = 0;
  const ask = async (prompt, opts = {}) => {
    if (opts.tools === 'Read') {
      reviewCalls += 1;
      if (reviewCalls === 2) return { ok: true, addedText: '', elapsedMs: 1 }; // 第二片返回空
      return { ok: true, addedText: '[{"id":"child-1","verdict":"PASS","reason":"ok"},{"id":"child-2","verdict":"PASS","reason":"ok"},{"id":"child-3","verdict":"PASS","reason":"ok"}]', elapsedMs: 1 };
    }
    return { ok: true, addedText: 'ANSWER: ok\nEVIDENCE: lib/split.mjs:5', elapsedMs: 1 };
  };
  const res = await runFanout({ task: '统计 lib/*.mjs', parts: 6, cwd: root, ask, timeoutMs: 5000, noPreGate: true });
  const byId = Object.fromEntries(res.reviews.map((r) => [r.id, r]));
  ok(reviewCalls === 2, '3 父审分了两片（实得 ' + reviewCalls + '）');
  ok(byId['child-1'].verdict === 'PASS', '3b 第一片拿到票');
  ok(/空内容/.test(byId['child-6'].reason || ''), '3c 空片理由写明「空内容」，实得：' + byId['child-6'].reason);
  ok(!/没有对这条给票/.test(byId['child-6'].reason || ''), '3d 不再误报成解析漏票');
}

console.log((fail === 0 ? '✓ ' : '✗ ') + 'fanout_observability: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);