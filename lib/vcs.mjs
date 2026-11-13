/**
 * vcs.mjs —— git 薄封装
 *
 * 为什么不用 simple-git 之类：这个项目一直是零依赖，多一个包就多一份升级和供应链风险。
 * 这里只包了 PR 流程真正需要的那十几个操作，全部走 execFileSync，参数数组传参不拼字符串。
 *
 * 设计约束：
 * 1) 任何写操作失败都要抛，不静默 —— 回退功能最怕"以为成功了其实没做"。
 * 2) 查询类操作（isDirty / branch 是否存在 / commit 是否存在）返回布尔或 null，不抛。
 * 3) 全部以 ROOT 为工作目录，不接受外部路径，避免误操作别的仓库。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(args, { allowFail = false } = {}) {
  try {
    const out = execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, out: out.replace(/\s+$/, '') };
  } catch (e) {
    const err = String((e.stderr || '') + (e.stdout || '') + (e.message || '')).trim();
    if (allowFail) return { ok: false, out: '', err };
    throw new Error('git ' + args.join(' ') + ' 失败：' + err);
  }
}

export function isRepo() {
  return run(['rev-parse', '--is-inside-work-tree'], { allowFail: true }).out === 'true';
}

export function ensureRepo() {
  if (isRepo()) return false;
  run(['init', '-b', 'main']);
  return true;
}

export function hasCommit(ref = 'HEAD') {
  return run(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { allowFail: true }).ok;
}

export function headSha() {
  return hasCommit() ? run(['rev-parse', 'HEAD']).out : null;
}

export function currentBranch() {
  const r = run(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  return r.ok ? r.out : null;
}

export function branchExists(name) {
  return run(['rev-parse', '--verify', '--quiet', 'refs/heads/' + name], { allowFail: true }).ok;
}

export function isDirty() {
  const r = run(['status', '--porcelain'], { allowFail: true });
  return r.ok && r.out.trim().length > 0;
}

export function changedFiles() {
  const r = run(['status', '--porcelain'], { allowFail: true });
  if (!r.ok || !r.out.trim()) return [];
  return r.out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
}

export function addAll() {
  run(['add', '-A']);
}

export function commit(message) {
  addAll();
  if (!isDirty() && !run(['diff', '--cached', '--name-only']).out.trim()) {
    return { committed: false, sha: headSha() };
  }
  run(['commit', '-m', message, '--no-verify']);
  return { committed: true, sha: headSha() };
}

/**
 * 只提交指定路径。审计日志用它——否则每写一行审计都会把工作区弄脏，
 * 下一次 approve/undo 就被自己的写入拦住（踩过）。
 */
export function commitPaths(message, paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return { committed: false, sha: headSha() };
  const changed = run(['status', '--porcelain', '--', ...list], { allowFail: true });
  if (!changed.ok || !changed.out.trim()) return { committed: false, sha: headSha() };
  run(['add', '--', ...list]);
  run(['commit', '-m', message, '--no-verify', '--', ...list]);
  return { committed: true, sha: headSha() };
}

export function checkout(name) {
  if (isDirty()) {
    throw new Error('工作区有未提交改动，先 pr finish 或 commit 再切换分支（当前分支 ' + currentBranch() + '）');
  }
  run(['checkout', name]);
}

export function createBranch(name) {
  run(['checkout', '-b', name]);
}

export function mergeNoFf(branch, message) {
  run(['merge', '--no-ff', '--no-edit', '-m', message, branch]);
  return headSha();
}

export function deleteBranch(name) {
  run(['branch', '-D', name]);
}

export function revertCommit(sha, message) {
  // PR 合并产生的是 merge commit；git revert 对 merge 必须指明主干侧（-m 1），
  // 否则报 "is a merge but no -m option was given"（踩过）。
  const parents = run(['rev-list', '--parents', '-n', '1', sha]).out.trim().split(/\s+/);
  const isMerge = parents.length > 2;
  const args = ['revert', '--no-edit', '--no-commit'];
  if (isMerge) args.push('-m', '1');
  args.push(sha);
  run(args);
  const r = commit(message || ('revert ' + sha));
  return r.sha;
}

export function diffStat(range) {
  return run(['diff', '--stat', range], { allowFail: true }).out || '';
}

export function diffText(range, maxLen = 4000) {
  const out = run(['diff', range], { allowFail: true }).out || '';
  return out.length > maxLen ? out.slice(0, maxLen) + '\n…（已截断，完整内容用 git diff ' + range + '）' : out;
}

export function logOneline(ref = 'HEAD', n = 20) {
  const r = run(['log', '--oneline', '-n', String(n), ref], { allowFail: true });
  return r.ok && r.out ? r.out.split('\n') : [];
}

export function firstParentCount(ref) {
  const r = run(['rev-list', '--count', ref], { allowFail: true });
  return r.ok ? Number(r.out) : 0;
}

/** 把这个分支相对 base 的改动文件列表拿出来（供 PR 摘要用） */
export function changedBetween(base, branch) {
  const r = run(['diff', '--name-status', base + '..' + branch], { allowFail: true });
  if (!r.ok || !r.out.trim()) return [];
  return r.out.split('\n').map((l) => {
    const [status, ...rest] = l.split('\t');
    return { status, file: rest.join('\t') };
  }).filter((x) => x.file);
}
