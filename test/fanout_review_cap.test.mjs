// test/fanout_review_cap.test.mjs —— 父审不回来也要给结论
// 2026-11-17 01:14 实证：workbuddy 当父审，从 01:14 挂到 01:31（17 分钟）没有任何产出，
// 连整体 deadline 都没把它收住（进程被外面杀掉时日志里一个结论都没有）。
// 「每路超时」不能当成「整体会结束」—— 父审这一步必须有自己的墙。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFanout } from '../lib/fanout-run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.log('  ✗ ' + m); } };

// 1. 父审永不 resolve → 硬墙把它变成「通道太慢」的结论
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-cap-'));
  const prev = process.env.ATWO_REVIEW_HARD_CAP_MS;
  process.env.ATWO_REVIEW_HARD_CAP_MS = '300';
  const ask = async (prompt) => ({ ok: true, addedText: 'ANSWER: 文件 x.mjs:1 里写着 a\nEVIDENCE: x.mjs:1' });
  const never = () => new Promise(() => {}); // 永不返回，模拟 GUI 通道挂着
  const t0 = Date.now();
  const res = await runFanout({ task: '看 x.mjs', parts: 2, cwd: tmp, ask, reviewAsk: never, reviewChunk: 0, speculativeResend: false, noPreGate: true });
  const ms = Date.now() - t0;
  if (prev === undefined) delete process.env.ATWO_REVIEW_HARD_CAP_MS; else process.env.ATWO_REVIEW_HARD_CAP_MS = prev;
  ok(ms < 5000, '1 硬墙 300ms 生效，整跑在 ' + ms + 'ms 内返回（不是无限等）');
  ok(res.summary.state === 'unreviewed' && res.summary.value === 0, '1b 结论是 unreviewed/value 0，绝不因为「没回来」就放行（' + res.summary.state + '）');
  const why = JSON.stringify(res.reviews || res.summary || {});
  ok(/未回|太慢|父审超过/.test(why) || /未回|太慢/.test(String(res.reviewRaw && res.reviewRaw[0] && res.reviewRaw[0].err) || ''), '1c 理由写明「父审超过 Ns 未回」而不是「没给票」');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 2. 父审正常返回时不该被墙误杀
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-cap2-'));
  const ask = async (prompt) => (/审|审查|review/i.test(prompt) || /child-1/.test(prompt) ? { ok: true, addedText: '{"votes":[{"id":"child-1","verdict":"PASS","reason":"引文对得上"}]}' } : { ok: true, addedText: 'ANSWER: a\nEVIDENCE: x.mjs:1' });
  const res = await runFanout({ task: '看 x.mjs', parts: 1, cwd: tmp, ask, reviewChunk: 0, speculativeResend: false, noPreGate: true });
  ok(res.summary.counts.PASS === 1, '2 正常父审不被墙误杀（PASS ' + res.summary.counts.PASS + '）');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 3. 源码层：硬墙不许被 unref（unref 过进程会直接退出，什么都不打印）
{
  const s = fs.readFileSync(path.join(root, 'lib/fanout-run.mjs'), 'utf8');
  ok(/父审超过/.test(s) && /hardCap/.test(s), '3 硬墙理由与标记在源码里');
  ok(!/capTimer && [^;]*\.unref\(\)/.test(s), '3b 硬墙计时器不许 unref（否则进程静默退出）');
}

console.log('fanout_review_cap: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
