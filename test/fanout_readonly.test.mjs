// test/fanout_readonly.test.mjs —— 事故防线：派出去的子会话默认不许写仓库。
// 背景：2026-11-16 vm/judge.mjs 被某次派活的子会话覆盖成一坨 LLM 回答文本（3 行）。
// codebuddy 的 --tools 默认是 Write,Edit,Read，所以「父只审不干」只约束了父审，没约束子会话。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFanout, READ_ONLY_TOOLS } from '../lib/fanout-run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let pass = 0; let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.log('  ✗ ' + msg); } };

const ANSWER = 'ANSWER: 看 atwo.mjs:194，EXIT 六个码。\nEVIDENCE: atwo.mjs:194 「const EXIT = { ok: 0, usage: 2, precondition: 3, accept: 4, channel: 5, budget: 6 };」';
const seenTools = [];
const fakeAsk = async (prompt, opts = {}) => { seenTools.push(opts.tools); return { ok: true, addedText: ANSWER, elapsedMs: 1 }; };

// 1. 默认：子会话拿到只读工具集。
{
  seenTools.length = 0;
  await runFanout({ task: '子会话默认工具集是什么', parts: 2, cwd: root, ask: fakeAsk, timeoutMs: 5000, noPreGate: true });
  ok(seenTools[0] === READ_ONLY_TOOLS && seenTools[1] === READ_ONLY_TOOLS,
    '1 子会话 tools 应为 ' + READ_ONLY_TOOLS + '，实得 ' + JSON.stringify(seenTools.slice(0, 2)));
  ok(!seenTools.slice(0, 2).some((t) => /Write|Edit/.test(String(t || ''))), '1b 默认工具集不许含 Write/Edit');
}

// 2. 父审升级前后不受影响：父审永远是 Read。
{
  const last = seenTools[seenTools.length - 1];
  ok(last === 'Read', '2 父审 tools 应为 Read，实得 ' + JSON.stringify(last));
}

// 3. 显式 childTools 覆盖会透传（需要真写文件的任务才这么用）。
{
  seenTools.length = 0;
  await runFanout({ task: '显式给写权限', parts: 2, cwd: root, ask: fakeAsk, timeoutMs: 5000, noPreGate: true, childTools: 'Write,Edit,Read' });
  ok(seenTools[0] === 'Write,Edit,Read', '3 childTools 覆盖应透传，实得 ' + JSON.stringify(seenTools[0]));
}

// 4. 源码级回归：只读是默认值，不是某次调用顺手传的。
{
  const src = fs.readFileSync(path.join(root, 'lib', 'fanout-run.mjs'), 'utf8');
  ok(/export const READ_ONLY_TOOLS = 'Read,Grep,Glob'/.test(src), '4a READ_ONLY_TOOLS 常量存在且为 Read,Grep,Glob');
  // 2026-11-17：默认值分成两条路 —— 不开执行面时仍是只读三件套；开 --allow-run 才给 Bash。
  ok(/childTools = opts\.childTools \|\| \(allowRun \? RUN_TOOLS : READ_ONLY_TOOLS\)/.test(src), '4b 默认值：不开执行面时是 READ_ONLY_TOOLS');
  ok(/export const RUN_TOOLS = 'Read,Grep,Glob,Bash'/.test(src), '4b2 开执行面时给 Bash，但只多这一个');
  ok(!/childTools = RUN_TOOLS/.test(src), '4b3 Bash 不许成为无条件默认（写文件/执行必须显式开）');
  ok(/tools: childTools/.test(src), '4c 子会话调用真的把 tools 传下去了');
}

console.log((fail === 0 ? '✓ ' : '✗ ') + 'fanout_readonly: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);