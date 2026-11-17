
// 挑「该被五层验收」的文件 —— done 的验收对象不能再靠「任务自己声明的 relatedFiles」，
// 而 task.json 的 relatedFiles 常年为空（于是收工时验收从来没跑过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acceptTargets, ACCEPT_MAX, formatGateBrief } from '../lib/gate.mjs';

const NL = String.fromCharCode(10);
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-targets-'));
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'base.mjs'), 'export const a = 1;' + NL);
  fs.writeFileSync(path.join(dir, 'test', 'base.test.mjs'), '// t' + NL);
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  return dir;
}

test('任务声明的 relatedFiles 排最前，且只收存在的文件', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'lib', 'declared.mjs'), 'export const b = 2;' + NL);
  const got = acceptTargets({ cwd: dir, relatedFiles: ['lib/declared.mjs', 'lib/missing.mjs'] });
  assert.equal(got[0], 'lib/declared.mjs');
  assert.ok(!got.includes('lib/missing.mjs'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('test/ docs/ _probe/ 这些不占验收名额', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'test', 'x.test.mjs'), '// x' + NL);
  fs.mkdirSync(path.join(dir, '_probe'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_probe', 'y.mjs'), '// y' + NL);
  const got = acceptTargets({ cwd: dir, relatedFiles: ['test/x.test.mjs', '_probe/y.mjs'] });
  assert.deepEqual(got, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('未提交改动与未跟踪源文件都会被收进来', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'lib', 'base.mjs'), 'export const a = 99;' + NL);
  fs.writeFileSync(path.join(dir, 'lib', 'fresh.mjs'), 'export const c = 3;' + NL);
  const got = acceptTargets({ cwd: dir });
  assert.ok(got.includes('lib/base.mjs'), '改过的已跟踪文件');
  assert.ok(got.includes('lib/fresh.mjs'), '未跟踪的新文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('绝对路径与越界路径一律不收', () => {
  const dir = tmpRepo();
  const got = acceptTargets({ cwd: dir, relatedFiles: [path.join(dir, 'lib', 'base.mjs'), '../escape.mjs'] });
  assert.deepEqual(got, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('非 js 文件不进验收（五层验收对 .md 无意义）', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'lib', 'notes.md'), '# n' + NL);
  const got = acceptTargets({ cwd: dir, relatedFiles: ['lib/notes.md'] });
  assert.deepEqual(got, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('上限截断，默认 ACCEPT_MAX', () => {
  const dir = tmpRepo();
  const many = [];
  for (let i = 0; i < 12; i += 1) {
    const f = 'lib/m' + i + '.mjs';
    fs.writeFileSync(path.join(dir, f), 'export const v' + i + ' = ' + i + ';' + NL);
    many.push(f);
  }
  assert.equal(acceptTargets({ cwd: dir, relatedFiles: many }).length, ACCEPT_MAX);
  assert.equal(acceptTargets({ cwd: dir, relatedFiles: many, max: 3 }).length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formatGateBrief 全绿只出两行，红只列红步', () => {
  const ok = formatGateBrief({ ok: true, elapsedMs: 5, failed: [], steps: [{ name: 'closure', ok: true, detail: 'x' }] });
  assert.equal(ok.split(NL).length, 1);
  assert.ok(ok.includes('九步全绿'));
  const bad = formatGateBrief({ ok: false, elapsedMs: 7, failed: ['accept'], steps: [{ name: 'accept', ok: false, detail: '验收未过：lib/x.mjs' }] });
  const lines = bad.split(NL);
  assert.ok(lines[0].includes('accept'));
  assert.ok(lines.some((l) => l.includes('lib/x.mjs')));
  assert.ok(!bad.includes('closure'), '绿步不印');
});
