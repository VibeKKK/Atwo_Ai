import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WORKTREE_PREFIX, createWorktree, releaseWorktree, listWorktrees } from '../lib/worktree.mjs';

const GIT_OPTS = { encoding: 'utf8', timeout: 30000, windowsHide: true };

function git(cwd, args) {
  const res = spawnSync('git', args, { ...GIT_OPTS, cwd });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${res.stderr || res.stdout}`);
  return res;
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

// worktree 只能从已有提交长出来，夹具仓库必须先 commit 一次。
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-src-'));
  git(dir, ['init', '-q']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=atwo', '-c', 'user.email=atwo@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);
  return dir;
}

// Windows 上 tmpdir 与 git 回报的路径大小写可能不同，比较前先压平。
function norm(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

test('createWorktree 建出的目录里有文件，cleanup 后目录消失', async () => {
  const src = makeRepo();
  let made;
  try {
    made = await createWorktree(src);
    assert.equal(made.ok, true, made.reason || '应当成功');
    assert.equal(made.ref, 'HEAD');
    assert.equal(typeof made.ms, 'number');
    assert.ok(made.ms >= 0);
    assert.ok(path.basename(made.dir).startsWith(`${WORKTREE_PREFIX}${process.pid}-`));
    assert.equal(fs.existsSync(path.join(made.dir, 'README.md')), true);

    const rel = await made.cleanup();
    assert.equal(rel.ok, true);
    assert.equal(rel.removed, true);
    assert.equal(fs.existsSync(made.dir), false);

    // cleanup 会被 finally 再调一次，重复调用不能炸。
    const again = await made.cleanup();
    assert.equal(again.ok, true);
    assert.equal(again.removed, false);
  } finally {
    rmrf(src);
  }
});

test('并发 6 次建出的目录两两不同', async () => {
  const src = makeRepo();
  const made = [];
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => createWorktree(src)));
    made.push(...results); // 先登记，后面断言失败也能在 finally 里清干净
    for (const result of results) assert.equal(result.ok, true, result.reason || '应当成功');
    const dirs = results.map((result) => norm(result.dir));
    assert.equal(new Set(dirs).size, 6);
    for (const dir of dirs) assert.equal(fs.existsSync(dir), true, dir);
  } finally {
    for (const result of made) await result.cleanup();
    rmrf(src);
  }
});

test('cleanup 之后 git worktree list 里没有残留条目', async () => {
  const src = makeRepo();
  let made;
  try {
    made = await createWorktree(src);
    assert.equal(made.ok, true, made.reason || '应当成功');
    await made.cleanup();
    assert.equal(fs.existsSync(made.dir), false);

    const listed = listWorktrees(src);
    assert.equal(listed.ok, true);
    assert.equal(listed.entries.some((entry) => norm(entry.path) === norm(made.dir)), false);
    assert.equal(listed.entries.length, 1); // 清干净后只剩主工作树
  } finally {
    if (made) await made.cleanup();
    rmrf(src);
  }
});

test('非 git 仓库返回 not-a-git-repo，cleanup 仍可安全调用', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-plain-'));
  try {
    const made = await createWorktree(plain);
    assert.equal(made.ok, false);
    assert.ok(String(made.reason).startsWith('not-a-git-repo'), made.reason);
    assert.equal(typeof made.cleanup, 'function');
    await made.cleanup();
    assert.equal(fs.existsSync(plain), true); // 失败路径不许动源目录
  } finally {
    rmrf(plain);
  }
});

test('releaseWorktree 对不存在的目录返回 ok:true removed:false', async () => {
  const ghost = path.join(os.tmpdir(), `${WORKTREE_PREFIX}ghost-${process.pid}-${Date.now()}`);
  assert.equal(fs.existsSync(ghost), false);
  const res = await releaseWorktree(ghost);
  assert.equal(res.ok, true);
  assert.equal(res.removed, false);
});

test('listWorktrees 能列出刚建的那个 worktree', async () => {
  const src = makeRepo();
  let made;
  try {
    made = await createWorktree(src);
    assert.equal(made.ok, true, made.reason || '应当成功');
    const listed = listWorktrees(src);
    assert.equal(listed.ok, true);
    const hit = listed.entries.find((entry) => norm(entry.path) === norm(made.dir));
    assert.ok(hit, '新 worktree 应当出现在 listWorktrees 里');
    assert.equal(hit.detached, true);
    assert.equal(listed.entries.some((entry) => entry.detached === false), true);
    assert.equal(listed.entries.length, 2);
  } finally {
    if (made) await made.cleanup();
    rmrf(src);
  }
});
