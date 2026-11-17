import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readChildren, reviewDir, makeReviewVerb } from '../lib/review-cli.mjs';

function mkDir(n) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-rev-'));
  for (let i = 1; i <= n; i++) {
    fs.writeFileSync(path.join(d, 'child-' + i + '.md'), 'ANSWER: 第 ' + i + ' 份的答案\nEVIDENCE: lib/sandbox.mjs:12 —— 原文\n', 'utf8');
  }
  return d;
}

test('readChildren 读回 child-N 并按编号排序', () => {
  const d = mkDir(3);
  const r = readChildren(d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.children.map((c) => c.id), ['child-1', 'child-2', 'child-3']);
  assert.match(r.children[0].answer, /第 1 份/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('readChildren 目录不存在 / 没有产物都给明确理由', () => {
  assert.equal(readChildren(path.join(os.tmpdir(), 'nope-' + Date.now())).reason.startsWith('no-dir'), true);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-rev-empty-'));
  assert.equal(readChildren(empty).reason, 'no-child-artifacts');
  fs.rmSync(empty, { recursive: true, force: true });
});

test('reviewDir 把产物送父审并出 markdown', async () => {
  const d = mkDir(2);
  let seen = '';
  const ask = async (prompt) => {
    seen = prompt;
    return { text: JSON.stringify({ votes: [{ id: 'child-1', verdict: 'PASS' }, { id: 'child-2', verdict: 'REVISE', reason: 'lib/sandbox.mjs:12 与原文不符' }] }) };
  };
  const r = await reviewDir(d, { ask, cwd: process.cwd(), task: '测试任务' });
  assert.equal(r.ok, true);
  assert.match(seen, /测试任务/);
  assert.equal(r.votes.length, 2);
  assert.match(r.markdown, /异步父审/);
  assert.match(r.markdown, /child-2  REVISE/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('reviewDir 没给 ask 不许假装审过', async () => {
  const d = mkDir(1);
  const r = await reviewDir(d, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-ask');
  assert.deepEqual(r.votes, []);
  fs.rmSync(d, { recursive: true, force: true });
});

test('makeReviewVerb 落 REVIEW-ASYNC.md/.json，REVISE 时 exit 4', async () => {
  const d = mkDir(1);
  const EXIT = { ok: 0, usage: 2, precondition: 3, accept: 4, channel: 5 };
  const lines = [];
  const RESULT = { data: null };
  const cmd = makeReviewVerb({
    EXIT, RESULT, HERE: process.cwd(), die: (m, code) => { const e = new Error(m); e.code = code; throw e; },
    resolveAsk: () => async () => ({ text: JSON.stringify({ votes: [{ id: 'child-1', verdict: 'REVISE', reason: 'x.mjs:1 编造' }] }) }),
  });
  const rc = await cmd(['--dir', d, '--lane', 'fake']);
  assert.equal(rc, EXIT.accept);
  assert.equal(fs.existsSync(path.join(d, 'REVIEW-ASYNC.md')), true);
  const j = JSON.parse(fs.readFileSync(path.join(d, 'REVIEW-ASYNC.json'), 'utf8'));
  assert.equal(j.lane, 'fake');
  assert.equal(j.digest.length, 16);
  assert.equal(RESULT.data.lane, 'fake');
  fs.rmSync(d, { recursive: true, force: true });
});

test('makeReviewVerb 缺 --dir 走 usage，通道不可用走 channel', async () => {
  const EXIT = { ok: 0, usage: 2, precondition: 3, accept: 4, channel: 5 };
  const die = (m, code) => { const e = new Error(m); e.code = code; throw e; };
  const A = makeReviewVerb({ EXIT, RESULT: { data: null }, HERE: process.cwd(), die, resolveAsk: () => async () => ({ text: '' }) });
  await assert.rejects(() => A([]), (e) => e.code === EXIT.usage);
  const B = makeReviewVerb({ EXIT, RESULT: { data: null }, HERE: process.cwd(), die, resolveAsk: () => { throw new Error('这个通道没有'); } });
  await assert.rejects(() => B(['--dir', 'x']), (e) => e.code === EXIT.channel);
});
test('perCall：GUI 通道一份一送（workbuddy 送两份时 303 秒零回答）', async () => {
  const d = mkDir(2);
  let calls = 0;
  const ask = async (prompt) => {
    calls++;
    const ids = (prompt.match(/child-\d+/g) || []).filter((v, i, a) => a.indexOf(v) === i);
    assert.equal(ids.length, 1, 'perCall=1 时每次只该出现一份产物，实际 ' + ids.join(','));
    return { text: JSON.stringify({ votes: [{ id: ids[0], verdict: 'PASS' }] }) };
  };
  const r = await reviewDir(d, { ask, cwd: process.cwd(), task: 't', perCall: 1 });
  assert.equal(calls, 2);
  assert.equal(r.votes.length, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

test('宽松解析：父审回散文不按 JSON 契约，也能捞到票', async () => {
  const d = mkDir(2);
  const ask = async () => ({ text: 'child-1：可以收，证据对得上。\nchild-2 退回，引用的行不存在。' });
  const r = await reviewDir(d, { ask, cwd: process.cwd(), task: 't' });
  const byId = Object.fromEntries(r.votes.map((v) => [v.id, v.verdict]));
  assert.equal(byId['child-1'], 'PASS');
  assert.equal(byId['child-2'], 'REVISE');
  assert.equal(r.votes.every((v) => v.loose), true);
  assert.match(r.rawText, /可以收/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('机械闸门已全判时不调父审，并且说清楚（不许伪装成「父审没回」）', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-rev-skip-'));
  fs.writeFileSync(path.join(d, 'child-1.md'), 'ANSWER: 结论\nEVIDENCE:\n(空)\n', 'utf8');
  let asked = 0;
  const ask = async () => { asked++; return { text: '' }; };
  const r = await reviewDir(d, { ask, cwd: process.cwd(), task: 't' });
  assert.equal(r.skippedLlm, true);
  assert.equal(asked, 0);
  assert.equal(r.llmCount, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('父审抛错时把错误写进原文，不吞成空', async () => {
  const d = mkDir(1);
  const ask = async () => { throw new Error('等了 303 秒没拿到回答'); };
  const r = await reviewDir(d, { ask, cwd: process.cwd(), task: 't' });
  assert.match(r.rawText, /调用失败/);
  assert.match(r.rawText, /303 秒/);
  fs.rmSync(d, { recursive: true, force: true });
});