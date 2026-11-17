import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import { test } from 'node:test';
import { preGateAll, parseRuns, runCheck } from '../lib/pregate.mjs';
import { allowCommand, runSandboxed, makeShadow } from '../lib/sandbox.mjs';

const cwd = process.cwd();

test('parseRuns 抠得出 RUN 三行', () => {
  const runs = parseRuns({ id: 'c', answer: '', evidence: 'RUN node --check lib/pregate.mjs → exit 0\nRUN: node test/pregate.test.mjs → exit 1' });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].cmd, 'node --check lib/pregate.mjs');
  assert.equal(runs[0].declared, 0);
  assert.equal(runs[1].declared, 1);
});

test('没有 RUN 声明的产物不进执行层（defer，不白跑）', () => {
  const rc = runCheck({ id: 'c', answer: 'x', evidence: 'lib/pregate.mjs:1' }, { cwd });
  assert.equal(rc.verdict, 'defer');
  assert.equal(rc.runs.length, 0);
});

test('声称 exit 0 而实跑非 0 → 判死，并带上实跑输出', () => {
  const rc = runCheck({ id: 'c', answer: 'x', evidence: 'RUN node --check lib/does-not-exist.mjs → exit 0' }, { cwd });
  assert.equal(rc.verdict, 'REVISE');
  assert.match(rc.reason, /声明与实跑不符/);
  assert.equal(rc.runs[0].declared, 0);
  assert.notEqual(rc.runs[0].actual, 0);
});

test('真跑就过的 RUN → 放行', () => {
  const rc = runCheck({ id: 'c', answer: 'x', evidence: 'RUN node --check lib/pregate.mjs → exit 0' }, { cwd });
  assert.equal(rc.verdict, 'defer');
  assert.equal(rc.runs[0].actual, 0);
});

test('白名单外的命令 → 判死（不猜、不放行）', () => {
  const rc = runCheck({ id: 'c', answer: 'x', evidence: 'RUN git status → exit 0' }, { cwd });
  assert.equal(rc.verdict, 'REVISE');
  assert.match(rc.reason, /不许跑/);
});

test('shell 元字符 → 白名单直接拒', () => {
  assert.equal(allowCommand('node test/a.test.mjs; rm -rf /').ok, false);
  assert.equal(allowCommand('node test/a.test.mjs | tee x').ok, false);
  assert.equal(allowCommand('node test/a.test.mjs').ok, true);
});

test('沙箱真跑：退出码与输出都拿得到', () => {
  const r = runSandboxed('node --check lib/pregate.mjs', { cwd });
  assert.equal(r.allowed, true);
  assert.equal(r.code, 0);
  assert.equal(r.ok, true);
});

test('影子副本：真仓库不动，副本内容与真文件一致', () => {
  const sh = makeShadow(cwd);
  try {
    assert.equal(sh.ok, true, sh.reason);
    const a = runSandboxed('node --check lib/pregate.mjs', { cwd: sh.dir });
    assert.equal(a.code, 0, '副本里也要能跑');
    const real = fsSync.readFileSync('lib/pregate.mjs', 'utf8').length;
    const copy = fsSync.readFileSync(sh.dir + '/lib/pregate.mjs', 'utf8').length;
    assert.equal(copy, real, '副本必须与工作区同字节（含未提交改动）');
  } finally { sh.cleanup(); }
});

test('preGateAll 开 runVerify：真跑过才 defer，编造的 RUN 被拦', () => {
  const kids = [
    { id: 'child-1', answer: '检查过语法', evidence: 'lib/pregate.mjs:1 注释\nRUN node --check lib/pregate.mjs → exit 0' },
    { id: 'child-2', answer: '测试全过', evidence: 'lib/pregate.mjs:1 注释\nRUN node --check lib/nope.mjs → exit 0' },
  ];
  const { reviews, deferred } = preGateAll(kids, { cwd, runVerify: { cwd } });
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].id, 'child-1');
  assert.equal(deferred[0].runs[0].actual, 0);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].id, 'child-2');
  assert.match(reviews[0].reason, /声明与实跑不符/);
});

test('preGateAll 影子副本建不起来时，全批判死而不是静默放行', () => {
  const kids = [{ id: 'child-1', answer: 'x', evidence: 'lib/pregate.mjs:1\nRUN node --check lib/pregate.mjs → exit 0' }];
  const { reviews, deferred } = preGateAll(kids, { cwd, runVerify: { cwd: '/definitely/not/a/repo/dir' } });
  // 传不存在的目录时 makeShadow 会失败 → 判死；若环境允许（复制成功）则退化为 defer
  assert.equal(deferred.length + reviews.length, 1);
  if (reviews.length) assert.match(reviews[0].reason, /影子副本/);
});
