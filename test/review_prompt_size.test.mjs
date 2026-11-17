import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildReviewPrompt } from '../lib/fanout.mjs';

// 2026-11-17 事故：3 份各 2 万字的产物拼成父审提示 → spawn ENAMETOOLONG → 三票全丢,
// 汇总成 unreviewed 却看不出是「提示太长」还是「父审不肯给票」。
test('父审提示对每份产物设上限，且写明截了多少字', () => {
  const big = 'x'.repeat(20000);
  const p = buildReviewPrompt('任务', [{ id: 'child-1', answer: big, evidence: big }]);
  assert.ok(p.length < 8000, '提示必须被压到能放进命令行的量级，实际 ' + p.length);
  assert.match(p, /此处截断，原文另有 \d+ 字没显示/);
  assert.match(p, /不要因为看不到就判 PASS/);
});

test('短产物一字不截', () => {
  const p = buildReviewPrompt('任务', [{ id: 'child-1', answer: '答', evidence: 'lib/queue.mjs:1 注释' }]);
  assert.match(p, /ANSWER: 答/);
  assert.match(p, /lib\/queue\.mjs:1/);
  assert.equal(/此处截断/.test(p), false);
});

test('codebuddy 驱动：长提示改走 stdin，短提示仍在命令行', () => {
  const src = fs.readFileSync(new URL('../agents/codebuddy.mjs', import.meta.url), 'utf8');
  assert.match(src, /const STDIN_PROMPT_THRESHOLD = 16000;/);
  assert.match(src, /const useStdin = String\(prompt\)\.length > STDIN_PROMPT_THRESHOLD;/);
  assert.match(src, /useStdin \? prompt : null/, '长提示必须从 stdin 传，不能拼进 argv');
  assert.match(src, /stdio: \[stdinData == null \? 'ignore' : 'pipe', 'pipe', 'pipe'\]/);
});
