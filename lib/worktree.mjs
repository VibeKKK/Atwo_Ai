import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const WORKTREE_PREFIX = 'atwo-wt-';

const GIT_TIMEOUT_MS = 30000;

// 序号只在同步段自增：取名到 spawnSync 之间没有 await，单线程事件循环下不会有两次调用读到同一个值。
let seqCounter = 0;

function nextSeq() {
  seqCounter = (seqCounter + 1) % 1000000;
  return seqCounter;
}

function randomSuffix() {
  // 单靠 pid 会重复：进程退出后 pid 会被系统重新分配，序号也跟着归零。
  return crypto.randomBytes(4).toString('hex').slice(0, 6);
}

function runGit(cwd, args) {
  // windowsHide 避免 Windows 上弹黑框；超时兜底防止 git 卡在 index.lock 上不返回。
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
}

// git 的 stderr 可能很长，只留尾部才看得见真正的原因。
function tail(text, max = 400) {
  const raw = String(text == null ? '' : text).trim();
  return raw.length > max ? raw.slice(-max) : raw;
}

function reasonOf(res, fallback) {
  const raw = res.stderr || res.stdout || (res.error && res.error.message) || '';
  return tail(raw) || fallback;
}

// Windows 的路径大小写不敏感，比较前统一小写，否则同一个目录会被判成两个。
function normCase(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const TMP_ROOT = normCase(os.tmpdir());

// 兜底删除只对临时目录生效：路径传错时不能把用户真正的仓库删掉。
function isInsideTmp(target) {
  const rel = path.relative(TMP_ROOT, normCase(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function noopCleanup() {
  return { ok: true, removed: false, reason: 'nothing-to-release' };
}

// 摘掉 worktree 后目录就没了，prune 只能靠事先记下的 common dir 才跑得起来。
function resolveCommonDir(dir) {
  const res = runGit(dir, ['rev-parse', '--git-common-dir']);
  if (res.status !== 0) return null;
  const rel = String(res.stdout || '').trim();
  return rel ? path.resolve(dir, rel) : null;
}

// 复制整仓的成本随仓库体积涨，worktree 只往 .git 写管理信息，代价和体积无关。
// 同步版本：sandbox 的 makeShadow 是同步调用（fanout-run 里当场用），不能等 Promise。
export async function createWorktree(srcDir, opts = {}) {
  return createWorktreeSync(srcDir, opts);
}

export function createWorktreeSync(srcDir, opts = {}) {
  const started = Date.now();
  const ref = opts.ref || 'HEAD';
  const fail = (reason) => ({ ok: false, dir: null, ref, reason, ms: Date.now() - started, cleanup: noopCleanup });

  try {
    const root = path.resolve(srcDir || '.');
    if (!fs.existsSync(root)) return fail(`src-not-found: ${root}`);
    const probe = runGit(root, ['rev-parse', '--git-dir']);
    if (probe.status !== 0) return fail(`not-a-git-repo: ${reasonOf(probe, root)}`);

    const base = TMP_ROOT;
    let dir = null;
    let reason = '';
    for (let attempt = 0; attempt < 5 && dir === null; attempt++) {
      const candidate = path.join(base, `${WORKTREE_PREFIX}${process.pid}-${nextSeq()}-${randomSuffix()}`);
      if (fs.existsSync(candidate)) continue; // 撞名就换一个，绝不复用别人的目录
      // 行尾必须钉死：Windows 上 core.autocrlf 默认 true，检出会写 CRLF，
      // 而工作区里我自己写的文件是 LF —— 副本与工作区字节不一致，校验 RUN 时看不出问题，
      // 但按字节比对的断言会红，且「副本和真文件一样」这句话就不成立了。
      const add = runGit(root, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'worktree', 'add', '--detach', candidate, ref]);
      if (add.status === 0) {
        dir = candidate;
        break;
      }
      reason = reasonOf(add, 'git worktree add failed');
      // add 失败时 git 可能留下半个目录，不清掉下次 add 会直接撞名。
      try { fs.rmSync(candidate, { recursive: true, force: true }); } catch { /* 目录不存在是常态 */ }
      break; // 不是撞名引起的失败，重试没有意义
    }

    if (!dir) return fail(reason || 'worktree-name-collision');
    return { ok: true, dir, ref, reason: null, ms: Date.now() - started, cleanup: () => releaseWorktree(dir) };
  } catch (err) {
    // 磁盘满、权限、路径非法都会从这里漏出来；调用方只看返回值，所以这里吞掉。
    return fail(`exception: ${err && err.message}`);
  }
}

// cleanup 常被 finally 再调一次，所以重复调用必须安全。
export async function releaseWorktree(dir, opts = {}) {
  if (!dir) return { ok: true, removed: false, reason: 'no-dir' };
  const target = path.resolve(String(dir));

  if (!fs.existsSync(target)) {
    // 目录先被删掉时仍要 prune，否则 .git/worktrees 里留着指向空路径的记录。
    const repo = opts.repo || opts.srcDir;
    if (repo && fs.existsSync(repo)) runGit(path.resolve(repo), ['worktree', 'prune']);
    return { ok: true, removed: false, reason: 'absent' };
  }

  try {
    const common = resolveCommonDir(target);
    // 用 --git-dir 指定仓库、cwd 放在父目录：git 若以自己的 cwd 为待删目录，Windows 会拒绝。
    const repoArgs = common ? [`--git-dir=${common}`] : [];
    const remove = runGit(path.dirname(target), [...repoArgs, 'worktree', 'remove', '--force', target]);
    if (remove.status !== 0 && isInsideTmp(target)) {
      // git 不认这个目录（被手工删过一半，或根本不是 worktree）时用 rm 兜底。
      fs.rmSync(target, { recursive: true, force: true });
    }
    // prune 清掉 .git/worktrees 下的管理目录，不然 list 仍会列出已消失的目录。
    if (common) runGit(path.dirname(target), [`--git-dir=${common}`, 'worktree', 'prune']);
    if (fs.existsSync(target)) {
      return { ok: false, removed: false, reason: `remove-failed: ${reasonOf(remove, target)}` };
    }
    return { ok: true, removed: true, reason: null };
  } catch (err) {
    return { ok: false, removed: false, reason: `exception: ${err && err.message}` };
  }
}

// porcelain 输出是空行分隔的键值块，只能按块攒，不能逐行当独立记录。
export function listWorktrees(srcDir) {
  try {
    const root = path.resolve(srcDir || '.');
    const res = runGit(root, ['worktree', 'list', '--porcelain']);
    if (res.status !== 0) return { ok: false, entries: [], reason: `not-a-git-repo: ${reasonOf(res, root)}` };

    const entries = [];
    let cur = null;
    const flush = () => {
      if (cur) entries.push(cur);
      cur = null;
    };

    for (const line of String(res.stdout || '').split(/\r?\n/)) {
      if (line === '') {
        flush();
        continue;
      }
      const sp = line.indexOf(' ');
      const key = sp === -1 ? line : line.slice(0, sp);
      const value = sp === -1 ? '' : line.slice(sp + 1);
      if (key === 'worktree') {
        flush();
        cur = { path: value, ref: null, detached: false, head: null };
      } else if (!cur) {
        continue;
      } else if (key === 'HEAD') {
        cur.head = value;
      } else if (key === 'branch') {
        cur.ref = value;
      } else if (key === 'detached') {
        // porcelain 里 detached 独占一行，有它就说明 HEAD 没挂分支。
        cur.detached = true;
      }
    }
    flush();

    // detached 条目没有 branch，用 HEAD 那次提交当 ref，调用方才分得清是哪一次。
    for (const entry of entries) if (!entry.ref && entry.detached) entry.ref = entry.head;
    return {
      ok: true,
      entries: entries.map((entry) => ({ path: entry.path, ref: entry.ref, detached: entry.detached })),
      reason: null,
    };
  } catch (err) {
    return { ok: false, entries: [], reason: `exception: ${err && err.message}` };
  }
}

// worktree 检出的是 ref 的字节，不是当前工作区：改了没提交、以及未跟踪的新文件都不在里面。
// 校验 RUN 时这会让「刚改过的文件」在副本里是旧版，退出码与真实不符 —— 所以要把脏文件叠上去。
// 只搬 git status 认的项（标记已忽略的运行时目录不在内），通常几十个文件、几十毫秒。
export function overlayWorkingTree(srcDir, dir) {
  const root = path.resolve(srcDir || '.');
  const target = path.resolve(dir || '.');
  // paths 是「这一轮叠进来的相对路径」。调用方要靠它做增量基线固化：
  // 副本是从 HEAD 检出的，index 与工作区本来就一致，只有这些路径与 HEAD 不同。
  const out = { ok: false, copied: 0, removed: 0, paths: [], reason: null };
  if (!fs.existsSync(root) || !fs.existsSync(target)) {
    out.reason = 'src-or-target-missing';
    return out;
  }
  const st = runGit(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (st.status !== 0) {
    out.reason = 'status-failed: ' + reasonOf(st, '');
    return out;
  }
  const entries = String(st.stdout || '').split('\0').filter(Boolean);
  for (const entry of entries) {
    const code = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (!rel) continue;
    const from = path.join(root, rel);
    const to = path.join(target, rel);
    // 只处理落在仓库内的路径：.. 或绝对路径一律跳过，避免把仓库外的东西搬进副本。
    const inside = path.relative(root, from);
    if (inside.startsWith('..') || path.isAbsolute(inside)) continue;
    if (code.includes('D')) {
      out.paths.push(rel);
      try { fs.rmSync(to, { recursive: true, force: true }); out.removed++; } catch { /* 目录不存在是常态 */ }
      continue;
    }
    try {
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // 不搬嵌套仓库的 .git：搬过去副本里就多一个子仓库，`git add` 会把它记成 gitlink，
      // 于是基线怎么也固化不住（实测：主仓库有个未跟踪的 graft/ 自带 .git，
      // 副本 diff 永远剩一条 `graft`，patch 判成「子会话改了文件」）。
      fs.cpSync(from, to, { recursive: true, dereference: false, filter: (src) => path.basename(src) !== '.git' });
      out.paths.push(rel);
      out.copied++;
    } catch (err) {
      out.reason = (out.reason ? out.reason + '; ' : '') + rel + ': ' + (err && err.message);
    }
  }
  out.ok = out.reason === null;
  return out;
}
