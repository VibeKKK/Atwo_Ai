import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeShadow } from '../lib/sandbox.mjs';

const cwd = process.cwd();
const git = (args, c) => spawnSync('git', args, { cwd: c, encoding: 'utf8', windowsHide: true });

test('makeShadow 在 git 仓库里用 worktree 隔离，且把未提交改动叠上去', () => {
  // 必须用未被 .gitignore 覆盖的路径：_probe/ 是忽略目录，git status 看不见它，叠不进副本。
  const marker = path.join(cwd, 'test/shadow-marker-' + process.pid + '.txt');
  const body = 'uncommitted-' + Date.now();
  fs.writeFileSync(marker, body, 'utf8');
  const sh = makeShadow(cwd);
  try {
    assert.equal(sh.ok, true, sh.reason);
    assert.equal(sh.isolation, 'worktree', 'git 仓库里必须走 worktree');
    assert.ok(sh.ms < 4000, 'worktree 建副本要明显快于 cpSync（实测 0.25-0.5s）');
    const copied = path.join(sh.dir, path.relative(cwd, marker));
    assert.equal(fs.existsSync(copied), true, '未跟踪文件没被叠进副本');
    assert.equal(fs.readFileSync(copied, 'utf8'), body);
    assert.equal(fs.existsSync(path.join(sh.dir, '.git')), true, 'worktree 副本应有 .git');
    assert.equal(sh.overlaid > 0, true, 'overlaid 计数应大于 0');
  } finally {
    sh.cleanup();
    try { fs.rmSync(marker, { force: true }); } catch {}
  }
});

test('cleanup 之后临时目录与 worktree 记录都不留', () => {
  const sh = makeShadow(cwd);
  assert.equal(sh.ok, true, sh.reason);
  const dir = sh.dir;
  sh.cleanup();
  assert.equal(fs.existsSync(dir), false, '临时目录没删掉');
  const list = git(['worktree', 'list', '--porcelain'], cwd).stdout || '';
  assert.equal(list.includes('atwo-wt-'), false, 'git worktree list 里还有残留');
});

test('非 git 仓库退回 cpSync，行为与以前一致（且标明来源）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-nogit-'));
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
  try {
    const sh = makeShadow(tmp);
    assert.equal(sh.ok, true, sh.reason);
    assert.equal(sh.isolation, 'copy');
    assert.ok(String(sh.fallbackFrom || '').startsWith('not-a-git-repo'), '要写明为什么退回：' + sh.fallbackFrom);
    assert.equal(fs.readFileSync(path.join(sh.dir, 'a.txt'), 'utf8'), 'x');
    sh.cleanup();
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('空目录不静默通过（cpSync 在 Windows 上会「成功」造空目录）', () => {
  const missing = path.join(os.tmpdir(), 'atwo-does-not-exist-' + Date.now());
  const sh = makeShadow(missing);
  assert.equal(sh.ok, false);
  assert.match(String(sh.reason), /空|不存在/);
});
