import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReviewPrompt } from '../lib/fanout.mjs';
import { runFanout } from '../lib/fanout-run.mjs';

// 派活是「发出去就收不回」的动作。可观察（--follow）与可转向（notes.md）
// 是它唯一能补救的两处 —— 少了这两个，AI 派完就进入黑箱：看不到过程、改不了要求。

let pass = 0, fail = 0;
const cases = [];
const it = (n, f) => cases.push([n, f]);

const kids = [{ id: 'child-1', answer: 'A', evidence: 'atwo.mjs:194' }];

it('不传批注时，审查提示里没有「父批注」段（模板说明不再漏进去）', () => {
  const p = buildReviewPrompt('任务', kids);
  assert.ok(!p.includes('父批注'));
});

it('给了批注就单独成段，且写明优先级高于原任务', () => {
  const p = buildReviewPrompt('任务', kids, 'child-1 引用的 orch.mjs 不算证据');
  assert.match(p, /父批注/);
  assert.match(p, /优先级高于原任务/);
  assert.ok(p.includes('child-1 引用的 orch.mjs 不算证据'));
});

it('空批注（空白字符串）不产生空段', () => {
  const p = buildReviewPrompt('任务', kids, '   \n  ');
  assert.ok(!p.includes('父批注'));
});

it('notes.md 只有注释时不算追加（第一版把模板说明当 6 行指令喂给了父审）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-notes-'));
  const nf = path.join(dir, 'notes.md');
  fs.writeFileSync(nf, '<!-- 说明文字\n     任务：x\n     注释里的内容不会进父审 -->\n', 'utf8');
  const seen = [];
  const fakeAsk = async () => ({ ok: true, addedText: 'ANSWER: ok\nEVIDENCE: e' });
  const r = await runFanout({ task: 't', parts: 1, cwd: dir, ask: fakeAsk, notesPath: nf, onProgress: (e) => seen.push(e) });
  assert.equal(r.notes, '');
  assert.ok(!seen.some((e) => e.phase === 'notes'), '空批注不该触发 notes 事件');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

it('notes.md 里真写了指令就被吸收，并广播 notes 事件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-notes2-'));
  const nf = path.join(dir, 'notes.md');
  fs.writeFileSync(nf, '<!-- 说明 -->\nchild-1 引用的 orch.mjs 不算证据\n', 'utf8');
  const seen = [];
  const fakeAsk = async () => ({ ok: true, addedText: 'ANSWER: ok\nEVIDENCE: e' });
  const r = await runFanout({ task: 't', parts: 1, cwd: dir, ask: fakeAsk, notesPath: nf, onProgress: (e) => seen.push(e) });
  assert.equal(r.notes, 'child-1 引用的 orch.mjs 不算证据');
  assert.ok(seen.some((e) => e.phase === 'notes'));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

it('逐路回调：每一路回来就报一次，而不是等最慢那路', async () => {
  const seen = [];
  let done = 0;
  const fakeAsk = async (prompt) => {
    // 两路不同速度：慢的 60ms，快的 5ms —— child-done 必须各报一次
    const slow = prompt.includes('第 1/') ? 60 : 5;
    await new Promise((r) => setTimeout(r, slow));
    done += 1;
    return { ok: true, addedText: 'ANSWER: ok\nEVIDENCE: e' };
  };
  await runFanout({ task: 't', parts: 2, cwd: process.cwd(), ask: fakeAsk, onProgress: (e) => seen.push(e) });
  const dones = seen.filter((e) => e.phase === 'child-done');
  assert.equal(dones.length, 2, 'child-done 应每路一次');
  // fakeAsk 也被父审调用一次 → 共 3 次；子会话只该 2 次
  assert.equal(done, 3, '子会话调用次数不对');
  assert.ok(dones.every((d) => typeof d.elapsedMs === 'number' && typeof d.chars === 'number'));
});

for (const [name, fn] of cases) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
