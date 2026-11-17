// atwo stage：只暂存我改的那些 hunk。判据是「别人未提交的改动一个都不该进我的提交」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runStage, readEditRows, fragmentsOf, parseHunks, buildPatch } from '../lib/stage-own.mjs';
import { runEdits, logEdits } from '../lib/edit-ops.mjs';

const NL = String.fromCharCode(10);
const G = ['-c', 'user.name=test', '-c', 'user.email=test@local', '-c', 'commit.gpgsign=false'];

function git(cwd, args) {
  const r = spawnSync('git', G.concat(args), { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' 失败：' + (r.stderr || '').slice(0, 200));
  return r.stdout;
}

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-own-'));
  git(d, ['init', '-q']);
  const lines = [];
  lines.push('const keep = 1;');
  lines.push("const mineTarget = 'A_VALUE';");
  for (let i = 0; i < 12; i += 1) lines.push('const pad' + i + ' = ' + i + ';');
  lines.push("const otherTarget = 'B_VALUE';");
  fs.writeFileSync(path.join(d, 'fileA.mjs'), lines.join(NL) + NL);
  fs.writeFileSync(path.join(d, 'fileB.mjs'), 'export const b = 1;' + NL);
  git(d, ['add', '-A']);
  git(d, ['commit', '-q', '-m', 'base']);
  return d;
}

// 我做一处（走 atwo edit，会记账），别人做两处（手工改，不记账）
function withBothChanges() {
  const d = repo();
  const r = runEdits({ ops: [{ file: 'fileA.mjs', find: "'A_VALUE'", replace: "'MINE_LINE'" }] }, { cwd: d });
  assert.equal(r.ok, true);
  logEdits(d, r, { by: 'me' });
  const a = fs.readFileSync(path.join(d, 'fileA.mjs'), 'utf8').replace("'B_VALUE'", "'OTHER_LINE'");
  fs.writeFileSync(path.join(d, 'fileA.mjs'), a);
  fs.writeFileSync(path.join(d, 'fileB.mjs'), 'export const b = 1;' + NL + 'export const c = 2;' + NL);
  return d;
}

test('别人的 hunk 一个都不进暂存区，我的 hunk 全进', () => {
  const d = withBothChanges();
  const r = runStage({ cwd: d });
  assert.equal(r.ok, true);
  const a = r.files.find((f) => f.file === 'fileA.mjs');
  assert.equal(a.mine, 1);
  assert.equal(a.others, 1);
  const cached = spawnSync('git', ['diff', '--cached', '-U0'], { cwd: d, encoding: 'utf8' }).stdout;
  assert.ok(cached.includes('MINE_LINE'), '我的改动要在暂存区');
  assert.ok(!cached.includes('OTHER_LINE'), '别人的改动不许被一起签走');
  assert.ok(!cached.includes('fileB.mjs'), '我没改过的文件不该出现在暂存区');
});

test('幂等：再跑一次不会重复暂存，也不会把别人的吞进来', () => {
  const d = withBothChanges();
  runStage({ cwd: d });
  const r2 = runStage({ cwd: d });
  assert.equal(r2.ok, true);
  assert.equal(r2.stagedHunks, 0);
  const a = r2.files.find((f) => f.file === 'fileA.mjs');
  assert.equal(a ? a.mine : 0, 0, '我的那处已经在 index 里，不再出现');
});

test('dry-run 什么也不动', () => {
  const d = withBothChanges();
  const r = runStage({ cwd: d, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.stagedHunks, 0);
  const cached = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: d, encoding: 'utf8' }).stdout;
  assert.equal(cached.trim(), '');
});

test('没有记账时一处都不认领（宁可不动，也不猜）', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, 'fileB.mjs'), 'export const b = 99;' + NL);
  const r = runStage({ cwd: d });
  assert.equal(r.ok, true);
  assert.equal(r.stagedHunks, 0);
  assert.equal(r.editsLogged, 0);
  const cached = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: d, encoding: 'utf8' }).stdout;
  assert.equal(cached.trim(), '');
});

test('记账文件坏了不阻断：坏行跳过、好行照用', () => {
  const d = repo();
  fs.mkdirSync(path.join(d, '.atw'), { recursive: true });
  fs.writeFileSync(path.join(d, '.atw', 'edits.jsonl'), '{"file":"fileB.mjs","to":' + NL + '{"file":"fileA.mjs","to":"这条不存在的片段XYZ"}' + NL);
  assert.equal(readEditRows(d).length, 1);
  const f = fragmentsOf(readEditRows(d));
  assert.ok(f.get('fileA.mjs').has('这条不存在的片段XYZ'));
});

test('parseHunks 只收新增行，buildPatch 拼出可 apply 的 -U0 patch', () => {
  const diff = ['diff --git a/x.mjs b/x.mjs', '--- a/x.mjs', '+++ b/x.mjs', '@@ -3,0 +4,2 @@', '+added one', '+added two', '@@ -9 +11 @@', '-old line', '+new line'].join(NL);
  const h = parseHunks(diff);
  assert.equal(h.length, 2);
  assert.deepEqual(h[0].added, ['added one', 'added two']);
  assert.deepEqual(h[1].added, ['new line']);
  const p = buildPatch('x.mjs', [h[1]]);
  assert.ok(p.startsWith('diff --git a/x.mjs b/x.mjs'));
  assert.ok(p.includes('@@ -9 +11 @@'));
  assert.ok(!p.includes('added one'));
});

test('片段太短不用于认领（避免把别人的行认成我的）', () => {
  const f = fragmentsOf([{ file: 'a.mjs', to: 'x;' }, { file: 'a.mjs', to: "const reallyLongMarker = 'yes';" }]);
  assert.equal(f.get('a.mjs').size, 1);
});