/**
 * pr.mjs —— 把「一次任务的改动」当成一个 Pull Request 来管
 *
 * 想法很简单：agent 干活不该直接改主干。每次派活开一个分支，干完形成一个提案，
 * 看 diff、决定合并还是丢掉、合并错了还能 revert。这就是 PR 的全部精神，
 * 只是这里没有远端、没有 reviewer 机器人，审的人是你和我。
 *
 * 生命周期：
 *   start  → open      在 orch/pr-<id> 分支上干活
 *   finish → ready     提交成型，等审
 *   approve→ merged    合回 main（--no-ff，保留一条合并记录）
 *   reject → rejected  丢掉分支，主干不受影响
 *   undo   → reverted  已经合进来的，反向提交撤掉（历史仍可查）
 *
 * 数据落 memory/prs.json，与 git 历史互为索引：
 * git 记「改了什么」，prs.json 记「为什么改、谁提的、有没有过审」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, isRepo, ensureRepo, hasCommit, headSha, currentBranch, branchExists, isDirty, changedFiles, commit, commitPaths, checkout, createBranch, mergeNoFf, deleteBranch, revertCommit, diffStat, diffText, changedBetween, logOneline } from './lib/vcs.mjs';

// 账本放 gitignore 的隐藏文件：PR 流程自己反复改写它，一旦被跟踪就会在每次操作后
// 把工作区弄脏，进而被自己的写入拦住（踩过一次）。对外可读审计写 memory/PR_LOG.md。
const STATE_FILE = path.join(ROOT, 'memory', '.prs.json');
const AUDIT_FILE = path.join(ROOT, 'memory', 'PR_LOG.md');
const META_RE = /^memory\/(\.prs\.json|PR_LOG\.md)$/;
const MAIN = 'main';

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s.prs) s.prs = {};
    if (!s.counter) s.counter = {};
    return s;
  } catch {
    return { version: 1, counter: {}, prs: {} };
  }
}

function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n', 'utf8');
}

const AUDIT_HEADER = ['# PR 审计日志', '', '每次状态变化追加一行。反查：git log -- memory/PR_LOG.md', '', ''].join('\n');

function audit(line) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    if (!fs.existsSync(AUDIT_FILE)) fs.writeFileSync(AUDIT_FILE, AUDIT_HEADER, 'utf8');
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    fs.appendFileSync(AUDIT_FILE, '- ' + stamp + '  ' + line + '\n', 'utf8');
    // 审计本身也要进历史，但绝不能把工作区留脏——否则下一次 approve/undo
    // 会被自己的写入拦住（踩过一次）。这里只提交这一个文件。
    try { commitPaths('docs(pr): 审计 ' + (line.split('`')[1] || '状态变化'), ['memory/PR_LOG.md']); } catch { }
  } catch { /* 审计写失败不影响主流程 */ }
}

function today() {
  const d = new Date();
  return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

function nextId(s) {
  const day = today();
  s.counter[day] = (s.counter[day] || 0) + 1;
  return 'PR-' + day + '-' + String(s.counter[day]).padStart(3, '0');
}

function branchOf(id) {
  return 'orch/' + id.toLowerCase();
}

function mustGet(s, id) {
  const pr = s.prs[id];
  if (!pr) throw new Error('没有这个提案: ' + id + '（用 pr list 看现有的）');
  return pr;
}

/** 首次接管：建仓库、忽略噪声、把当前状态作为主干基线 */
export function init() {
  const created = ensureRepo();
  const ignore = path.join(ROOT, '.gitignore');
  const want = ['node_modules/', '*.log', '_probe*.mjs', '_yamlcheck*', '.DS_Store', 'memory/.lock/', 'memory/.prs.json'];
  let added = [];
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, want.join('\n') + '\n', 'utf8');
    added = want;
  } else {
    const cur = fs.readFileSync(ignore, 'utf8');
    const miss = want.filter((w) => !cur.split('\n').map((x) => x.trim()).includes(w));
    if (miss.length) {
      fs.writeFileSync(ignore, cur.replace(/\s*$/, '\n') + miss.join('\n') + '\n', 'utf8');
      added = miss;
    }
  }
  let baseCommit = null;
  if (!hasCommit()) {
    baseCommit = commit('chore: 仓库基线（PR 流程接管前的状态）').sha;
  }
  return { created, ignoreAdded: added, baseCommit, branch: currentBranch() };
}

/** 开一个提案分支 */
export function start(title, opts = {}) {
  if (!isRepo()) init();
  if (!hasCommit()) commit('chore: 仓库基线');
  const s = loadState();
  const id = nextId(s);

  // 主干上还有没提交的改动？先落一个基线提交，否则分支会带着脏状态出生，
  // 之后 pr show 的 diff 就分不清哪些是这次提案的。
  let baseline = null;
  if (isDirty()) {
    baseline = commit('chore: 提案 ' + id + ' 前的基线（自动）').sha;
  }
  const baseSha = headSha();

  // 不强制回 main：允许在 main 上开；如果在别的提案分支上，回到 main 再开
  const cur = currentBranch();
  if (cur && cur !== MAIN && branchExists(MAIN)) {
    try { checkout(MAIN); } catch (e) { throw new Error('切不回 ' + MAIN + '：' + e.message); }
  }
  const branch = branchOf(id);
  if (branchExists(branch)) deleteBranch(branch);
  createBranch(branch);

  const pr = {
    id,
    title: String(title || '(未命名提案)').slice(0, 200),
    agent: opts.agent || '',
    branch,
    base: MAIN,
    baseSha,
    autoBaselineCommit: baseline,
    status: 'open',
    startedAt: new Date().toISOString(),
    files: [],
    diffStat: '',
  };
  s.prs[id] = pr;
  saveState(s);
  audit('`' + id + '` open      ' + pr.title + '  branch=' + pr.branch);
  return pr;
}

/** 干活完成：在提案分支上提交 */
export function finish(id, opts = {}) {
  const s = loadState();
  const pr = id ? mustGet(s, id) : findOpen(s);
  const cur = currentBranch();
  if (cur !== pr.branch) {
    throw new Error('当前在 ' + cur + '，但提案 ' + pr.id + ' 的分支是 ' + pr.branch + '。先切过去：git checkout ' + pr.branch);
  }
  const msg = opts.message || ('feat(' + (pr.agent || 'agent') + '): ' + pr.title);
  const r = commit(msg);
  pr.headSha = r.sha;
  pr.files = changedBetween(pr.baseSha, pr.branch).filter((f) => !META_RE.test(f.file));
  pr.diffStat = diffStat(pr.baseSha + '..' + pr.branch);
  pr.status = pr.files.length ? 'ready' : 'empty';
  pr.finishedAt = new Date().toISOString();
  saveState(s);
  audit('`' + pr.id + '` finish    ' + pr.status + '  files=' + pr.files.length);
  return pr;
}

function findOpen(s) {
  const open = Object.values(s.prs).filter((p) => p.status === 'open');
  if (!open.length) throw new Error('没有进行中的提案');
  return open[open.length - 1];
}

/** 合并回主干 */
export function approve(id, opts = {}) {
  const s = loadState();
  const pr = mustGet(s, id);
  if (pr.status === 'merged') return pr;
  if (!['ready', 'open'].includes(pr.status)) throw new Error('提案 ' + id + ' 状态是 ' + pr.status + '，不能合并');
  if (isDirty()) throw new Error('工作区有未提交改动（' + changedFiles().join(', ') + '），先提交再合并');
  checkout(MAIN);
  const mergeSha = mergeNoFf(pr.branch, 'merge: ' + pr.id + ' ' + pr.title);
  pr.status = 'merged';
  pr.mergeSha = mergeSha;
  pr.approvedAt = new Date().toISOString();
  pr.approvedBy = opts.by || 'rank1';
  saveState(s);
  audit('`' + pr.id + '` merged    ' + (mergeSha ? mergeSha.slice(0, 8) : ''));
  try { commit('docs(pr): 记录 ' + pr.id + ' 合并'); } catch { }
  return pr;
}

/** 丢弃提案 */
export function reject(id, reason = '') {
  const s = loadState();
  const pr = mustGet(s, id);
  if (pr.status === 'merged') throw new Error(pr.id + ' 已经合并了，要撤请用 pr undo ' + id);
  if (currentBranch() === pr.branch) checkout(MAIN);
  if (branchExists(pr.branch)) deleteBranch(pr.branch);
  pr.status = 'rejected';
  pr.rejectedAt = new Date().toISOString();
  pr.rejectReason = reason;
  saveState(s);
  audit('`' + pr.id + '` rejected  ' + (reason || '(无原因)'));
  return pr;
}

/** 撤回已合并的提案（反向提交，历史保留） */
export function undo(id) {
  const s = loadState();
  const pr = mustGet(s, id);
  if (pr.status !== 'merged') {
    // 没合并过：等于拒绝
    return reject(id, 'undo（未合并，按丢弃处理）');
  }
  if (isDirty()) throw new Error('工作区有未提交改动，先提交再撤回');
  checkout(MAIN);
  const sha = revertCommit(pr.mergeSha, 'revert: 撤回 ' + pr.id + ' ' + pr.title);
  pr.status = 'reverted';
  pr.revertSha = sha;
  pr.revertedAt = new Date().toISOString();
  saveState(s);
  audit('`' + pr.id + '` reverted  ' + (sha ? sha.slice(0, 8) : ''));
  try { commit('docs(pr): 记录 ' + pr.id + ' 撤回'); } catch { }
  return pr;
}

export function list() {
  const s = loadState();
  return Object.values(s.prs).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function show(id) {
  const s = loadState();
  const pr = mustGet(s, id);
  const range = pr.status === 'merged' && pr.mergeSha
    ? (pr.baseSha + '..' + pr.mergeSha)
    : (pr.baseSha + '..' + (pr.branch && branchExists(pr.branch) ? pr.branch : (pr.headSha || pr.baseSha)));
  return { pr, diff: diffText(range), stat: pr.diffStat || diffStat(range), log: logOneline(pr.branch || MAIN, 10) };
}

export function status() {
  const s = loadState();
  return {
    repo: isRepo(),
    branch: currentBranch(),
    dirty: isDirty(),
    dirtyFiles: changedFiles(),
    head: headSha(),
    counts: Object.values(s.prs).reduce((acc, p) => { acc[p.status] = (acc[p.status] || 0) + 1; return acc; }, {}),
    open: Object.values(s.prs).filter((p) => ['open', 'ready'].includes(p.status)),
  };
}

// ---------------- CLI ----------------
function fmtPr(p) {
  const day = p.startedAt ? p.startedAt.slice(0, 16).replace('T', ' ') : '';
  return `${p.id}  ${p.status.padEnd(8)}  ${(p.agent || '-').padEnd(9)}  ${day}  ${p.title}`;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help') {
    console.log(`PR 用法（提案式改动管理）：
  pr init                      建仓库 + .gitignore + 主干基线
  pr start "<标题>" [agent]     开提案分支 orch/pr-xxx
  pr finish [id]               在提案分支上提交，形成提案
  pr list                      列出所有提案
  pr show <id>                 看这个提案的 diff
  pr approve <id>              合并回 main
  pr reject <id> [原因]         丢弃提案
  pr undo <id>                 撤回已合并的提案（反向提交）
  pr status                    仓库状态 / 未决提案`);
    process.exit(0);
  }
  if (cmd === 'init') {
    const r = init();
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === 'start') {
    const title = rest.join(' ').trim();
    if (!title) { console.error('要给个标题'); process.exit(2); }
    const pr = start(title);
    console.log(`已开提案 ${pr.id}  分支 ${pr.branch}\n  ${pr.title}`);
    return;
  }
  if (cmd === 'finish') {
    const pr = finish(rest[0]);
    console.log(`${pr.id}  ${pr.status}  文件 ${pr.files.length} 个`);
    if (pr.diffStat) console.log(pr.diffStat);
    return;
  }
  if (cmd === 'list') {
    const all = list();
    if (!all.length) { console.log('(还没有提案)'); return; }
    all.forEach((p) => console.log(fmtPr(p)));
    return;
  }
  if (cmd === 'show') {
    const { pr, diff, log } = show(rest[0]);
    console.log(`${pr.id}  ${pr.status}  ${pr.title}\n分支 ${pr.branch}  base ${pr.baseSha ? pr.baseSha.slice(0, 8) : '-'}`);
    if (pr.files && pr.files.length) console.log('文件：' + pr.files.map((f) => f.status + ' ' + f.file).join(', '));
    if (log.length) console.log('提交：\n  ' + log.join('\n  '));
    console.log('\n' + (diff || '(无 diff)'));
    return;
  }
  if (cmd === 'approve') {
    const pr = approve(rest[0]);
    console.log(`${pr.id} 已合并  ${pr.mergeSha ? pr.mergeSha.slice(0, 8) : ''}`);
    return;
  }
  if (cmd === 'reject') {
    const pr = reject(rest[0], rest.slice(1).join(' '));
    console.log(`${pr.id} 已丢弃（分支 ${pr.branch} 已删）`);
    return;
  }
  if (cmd === 'undo') {
    const pr = undo(rest[0]);
    console.log(`${pr.id} 状态 ${pr.status}` + (pr.revertSha ? '  反向提交 ' + pr.revertSha.slice(0, 8) : ''));
    return;
  }
  if (cmd === 'status') {
    const st = status();
    console.log(`分支 ${st.branch}  HEAD ${st.head ? st.head.slice(0, 8) : '(无)'}  工作区${st.dirty ? '有未提交改动: ' + st.dirtyFiles.join(', ') : '干净'}`);
    const c = st.counts;
    console.log('提案统计：' + (Object.keys(c).length ? Object.entries(c).map(([k, v]) => k + ' ' + v).join(' / ') : '无'));
    if (st.open.length) {
      console.log('未决：');
      st.open.forEach((p) => console.log('  ' + fmtPr(p)));
    }
    return;
  }
  console.error('未知命令: ' + cmd);
  process.exit(2);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/pr.mjs')) main();
