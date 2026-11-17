// 第一刀的验收：子会话在影子副本里改代码，过了才出 patch，主仓库零改动。
// 这些断言守的是「不许越过副本」这条线 —— 11-16 那次 vm/judge.mjs 被 LLM 回答覆写成 3 行，
// 就是因为当时没有这一层，模型的输出直接落在真文件上。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runPatch, buildWritePrompt, changedFiles, diffOf, syntaxCheck, runTests, formatPatchResult, WRITE_TOOLS, MAX_WRITE_PARTS, PATCH_CONTRACT } from '../lib/writeback.mjs';
import { listWorktrees } from '../lib/worktree.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 前置快照：这条测试自己就可能跑在「另一份副本」里（atwo patch 的验收命令就是它），
// 那时 git worktree list 里天然有一个 atwo-wt- 目录，就是我自己 —— 不能判成残留。
const WT_BEFORE = new Set(listWorktrees(HERE).entries.map((e) => e.path));
let pass = 0;
let fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ✓ ' + name); },
    (e) => { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); },
  );
}

const NL2 = String.fromCharCode(10);
const fakeAskWriting = (rel, content) => async (prompt, opts) => {
  const target = path.join(opts.cwd, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return { ok: true, text: '改了 ' + rel };
};

console.log('atwo patch · 影子副本写入');

await test('提示里写死了四条禁令（不许 git 写操作 / 只改必要文件 / 自己验 / 说清改了啥）', () => {
  const p = buildWritePrompt('把 a 改成 b', 1, 2);
  assert.match(p, /第 1\/2 路/);
  assert.match(p, /不要执行任何 git 写操作/);
  assert.match(p, /只改完成任务必需的文件/);
  assert.match(p, /node --check/);
  assert.match(p, /改了哪几个文件/);
  assert.match(p, /做不到就直说/);
});

await test('写权限是显式给的，不是默认（WRITE_TOOLS 含 Write/Edit/Bash）', () => {
  assert.match(WRITE_TOOLS, /Write/);
  assert.match(WRITE_TOOLS, /Edit/);
  assert.match(WRITE_TOOLS, /Bash/);
  assert.ok(MAX_WRITE_PARTS >= 1 && MAX_WRITE_PARTS <= 3);
  assert.equal(PATCH_CONTRACT, 'atwo-patch/1');
});

await test('假会话写一个文件 → 出 patch，且主仓库里没有这个文件', async () => {
  const rel = 'lib/__patch_probe_ok.mjs';
  assert.equal(fs.existsSync(path.join(HERE, rel)), false, '前置：主仓库本来不该有这个文件');
  const r = await runPatch({
    cwd: HERE,
    task: '新建一个占位模块',
    ask: fakeAskWriting(rel, 'export const probe = 1;' + NL2),
  });
  assert.equal(r.ok, true, '应该出了 patch：' + JSON.stringify(r.parts && r.parts[0] && r.parts[0].reason));
  assert.equal(r.patchPaths.length, 1);
  const diff = fs.readFileSync(r.patchPaths[0], 'utf8');
  assert.match(diff, /__patch_probe_ok\.mjs/, '未跟踪的新文件必须进 patch（add -N 那一步）');
  assert.match(diff, /export const probe = 1/);
  assert.equal(fs.existsSync(path.join(HERE, rel)), false, '主仓库绝不能被动过');
  fs.rmSync(r.patchPaths[0], { force: true });
});

await test('假会话什么都不改 → 判 no-change，不出 patch', async () => {
  const r = await runPatch({ cwd: HERE, task: '装死', ask: async () => ({ ok: true, text: '我想了想，不用改' }) });
  assert.equal(r.ok, false);
  assert.match(r.parts[0].reason, /no-change/);
  assert.equal(r.patchPaths.length, 0);
});

await test('写出的文件语法错 → 判 syntax，整份丢（不出 patch）', async () => {
  const r = await runPatch({
    cwd: HERE,
    task: '写坏一个文件',
    ask: fakeAskWriting('lib/__patch_probe_bad.mjs', 'export const x = {;' + NL2),
  });
  assert.equal(r.ok, false);
  assert.match(r.parts[0].reason, /syntax/);
  assert.equal(r.patchPaths.length, 0);
});

await test('验收命令红 → 整份丢（测试没过就不是产物）', async () => {
  const r = await runPatch({
    cwd: HERE,
    task: '改对了但测试不过',
    ask: fakeAskWriting('lib/__patch_probe_test.mjs', 'export const probe = 2;' + NL2),
    testCmd: 'node -e "process.exit(1)"',
  });
  assert.equal(r.ok, false);
  assert.match(r.parts[0].reason, /tests/);
  assert.ok(r.parts[0].rejectedPath, '没过的改动也要留一份，否则只能重跑猜原因');
  assert.ok(fs.existsSync(r.parts[0].rejectedPath));
  assert.match(path.basename(r.parts[0].rejectedPath), /rejected/);
  fs.rmSync(r.parts[0].rejectedPath, { force: true });
});

await test('验收命令绿 → 出 patch', async () => {
  const r = await runPatch({
    cwd: HERE,
    task: '改对了且测试过',
    ask: fakeAskWriting('lib/__patch_probe_green.mjs', 'export const probe = 3;' + NL2),
    testCmd: 'node -e "process.exit(0)"',
  });
  assert.equal(r.ok, true);
  assert.equal(r.parts[0].tests.ok, true);
  fs.rmSync(r.patchPaths[0], { force: true });
});

await test('副本用完即销毁（本次测试没有留下新副本）', async () => {
  const after = listWorktrees(HERE).entries.map((e) => e.path);
  // 只认本进程建的副本：worktree 名是 atwo-wt-<pid>-<seq>-<hash>。
  // 按「全仓库没有新副本」判会在并发跑测试时必红（另一个测试也在建），那是假红。
  const leaks = after.filter((p) => !WT_BEFORE.has(p) && p.includes('atwo-wt-' + process.pid + '-'));
  assert.deepEqual(leaks, [], '残留副本：' + leaks.join(','));
});

await test('changedFiles / diffOf / syntaxCheck / runTests 各自对得上', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-unit-'));
  const wt = spawnSync('git', ['init', '-q', '.'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(wt.status, 0);
  fs.writeFileSync(path.join(tmp, 'a.mjs'), 'export const a = 1;' + NL2);
  const ch = changedFiles(tmp);
  assert.equal(ch.ok, true);
  assert.ok(ch.files.some((f) => f.path === 'a.mjs'), '未跟踪文件要能看到');
  const syn = syntaxCheck(tmp, [{ path: 'a.mjs', code: '??' }]);
  assert.equal(syn.ok, true);
  fs.writeFileSync(path.join(tmp, 'b.mjs'), 'export const b = {;' + NL2);
  assert.equal(syntaxCheck(tmp, [{ path: 'b.mjs', code: '??' }]).ok, false);
  assert.equal(runTests(tmp, 'node -e "process.exit(0)"').ok, true);
  assert.equal(runTests(tmp, 'node -e "process.exit(2)"').ok, false);
  assert.equal(runTests(tmp, null).skipped, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('formatPatchResult 只印结论与红行，不印整份 diff', () => {  const txt = formatPatchResult({
    contract: PATCH_CONTRACT, ok: true, allOk: true, stamp: 'x', patchPaths: ['/tmp/a.patch'],
    elapsedMs: 1234,
    parts: [{ index: 1, ok: true, changed: [{ path: 'lib/a.mjs' }], diffStat: ' lib/a.mjs | 2 +-', tests: { cmd: 'node test/a.test.mjs', code: 0, ok: true }, patchPath: '/tmp/a.patch' }],
  });
  assert.match(txt, /第 1 路：✓ 出了 patch/);
  assert.match(txt, /git apply/);
  assert.match(txt, /主仓库未改动/);
  assert.ok(txt.length < 600, '报告要短：实际 ' + txt.length);
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);