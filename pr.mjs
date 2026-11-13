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
import { ROOT, isRepo, ensureRepo, hasCommit, headSha, currentBranch, branchExists, isDirty, changedFiles, commit, checkout, createBranch, mergeNoFf, deleteBranch, revertCommit, diffStat, diffText, changedBetween, logOneline } from './lib/vcs.mjs';

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

/**
 * 审计日志**不进 git**（已 gitignore）。
 *
 * 踩过的坑：每条审计都提交进历史，结果提案分支和主干各自 append 同一个文件，
 * 合并时必然 add/add 冲突，`pr approve` 直接失败。append-only 日志天生不适合
 * 跨分支合并。
 *
 * 分工：git 历史用 commit message 承载（`feat(pr-<id>): …` / `merge: PR-…` /
 * `revert: PR-…`，`git log --grep PR-2026` 就能反查）；这份文件只给人现场看。
 */
function audit(line) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    if (!fs.existsSync(AUDIT_FILE)) fs.writeFileSync(AUDIT_FILE, AUDIT_HEADER, 'utf8');
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    fs.appendFileSync(AUDIT_FILE, '- ' + stamp + '  ' + line + '\n', 'utf8');
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
  const msg = opts.message || ('feat(pr-' + pr.id + '): ' + pr.title);
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

/**
 * 合并前清理工作区。
 *
 * 为什么需要：agent 干完活会把「团队记忆/预算/流水」这类运行时文件刷新一遍，
 * 直接 throw 会让 approve 永远过不去（实测被 memory/STATE.md 拦住）。
 * 但放行一切脏文件又危险 —— 会把没走提案的代码混进合并。所以只放行元数据，
 * 并且只提交这几个路径。
 */
const META_TOLERANT = ['memory/STATE.md', 'memory/log.jsonl', 'memory/budget.json', 'memory/PR_LOG.md', 'memory/.prs.json'];

function settleWorkspace() {
  const dirty = changedFiles();
  if (!dirty.length) return [];
  const foreign = dirty.filter((f) => !META_TOLERANT.includes(f));
  if (foreign.length) {
    throw new Error('工作区有未提交改动（' + foreign.join(', ') + '），先提交再合并');
  }
  commitPaths('chore(memory): 同步运行时元数据', dirty);
  return dirty;
}

// ---------------------------------------------------------------- 审阅门（rank1/rank2 共管）
//
// 用户令：这个过程可以由总管的 AI 和副总管的 AI 监管一部分责任。
// 所以批准权不是一个人说了算，而是按「改动风险」分级：
//   docs 级（只动文档/记忆）→ rank2 审过就能合
//   code 级（动代码）        → 必须 rank1 审过
//   protected（治理文件）     → 必须 rank1 审过，且 rank2 必须知情（写进记录）
// rank1 追认规则：rank2 已审的 code 提案，rank1 一条 review 即可放行。
const POLICY_FILE = path.join(ROOT, 'collab', 'authority.json');

const DEFAULT_POLICY = {
  required_reviews: { docs: 1, code: 1, protected: 1 },
  reviewers: { docs: ['rank2', 'rank1'], code: ['rank1'], protected: ['rank1'] },
  must_be_informed: { protected: ['rank2'] },
  protected_paths: ['collab/authority.json', 'collab/SHARED.md', 'pr.mjs', 'lib/vcs.mjs', 'orchestra.mjs', 'package.json', 'cordis.patch.yml'],
  docs_prefixes: ['collab/', 'memory/', 'docs/', 'README'],
};

function loadPolicy() {
  try {
    const a = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
    const p = a && a.pr_policy;
    if (!p) return DEFAULT_POLICY;
    return {
      required_reviews: { ...DEFAULT_POLICY.required_reviews, ...(p.required_reviews || {}) },
      reviewers: { ...DEFAULT_POLICY.reviewers, ...(p.reviewers || {}) },
      must_be_informed: { ...DEFAULT_POLICY.must_be_informed, ...(p.must_be_informed || {}) },
      protected_paths: p.protected_paths || DEFAULT_POLICY.protected_paths,
      docs_prefixes: p.docs_prefixes || DEFAULT_POLICY.docs_prefixes,
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

const normWho = (w) => String(w || '').trim().toLowerCase();
const asRank = (w) => {
  const v = normWho(w);
  if (['rank1', 'dsh-lead', 'lead', '总管', '1'].includes(v)) return 'rank1';
  if (['rank2', 'dsh-work-replace', 'work-replace', '副总管', '2'].includes(v)) return 'rank2';
  return v;
};

/** 按改动文件判风险等级 */
function classify(files) {
  const pol = loadPolicy();
  const list = (files || []).map((f) => (typeof f === 'string' ? f : f.file));
  if (!list.length) return 'docs';
  if (list.some((f) => pol.protected_paths.includes(f))) return 'protected';
  const allDocs = list.every((f) => pol.docs_prefixes.some((p) => f.startsWith(p)));
  return allDocs ? 'docs' : 'code';
}

/** 该提案还需要谁审 */
function reviewGate(pr) {
  const pol = loadPolicy();
  const risk = classify(pr.files);
  const allowed = pol.reviewers[risk] || pol.reviewers.code;
  const reviews = (pr.reviews || []).filter((r) => r.verdict === 'approve');
  const done = reviews.map((r) => asRank(r.by));
  const satisfiedBy = done.find((r) => allowed.includes(r));
  const informed = pol.must_be_informed[risk] || [];
  const informedBy = (pr.reviews || []).map((r) => asRank(r.by));
  const missingInformed = informed.filter((w) => !informedBy.includes(w));
  return {
    risk,
    allowed,
    satisfied: !!satisfiedBy,
    satisfiedBy: satisfiedBy || null,
    needInformed: informed,
    missingInformed,
  };
}

/** 记一条审阅意见（只记，不做决定） */
export function review(id, opts = {}) {
  const s = loadState();
  const pr = mustGet(s, id);
  if (pr.status === 'merged' || pr.status === 'reverted') {
    throw new Error(pr.id + ' 已经是 ' + pr.status + ' 状态，不能再审');
  }
  const by = asRank(opts.by);
  if (!by) throw new Error('review 需要说明是谁审的：--by rank1 | rank2');
  const verdict = opts.verdict === 'reject' ? 'reject' : 'approve';
  const pol = loadPolicy();
  const risk = classify(pr.files);
  const allowed = pol.reviewers[risk] || [];
  if (!allowed.includes(by)) {
    throw new Error(risk + ' 级提案的审阅人应是 ' + allowed.join(' / ') + '，你是 ' + by
      + '。要么找对的人审，要么先升级策略（collab/authority.json 的 pr_policy）');
  }
  pr.reviews = pr.reviews || [];
  pr.reviews.push({
    by,
    verdict,
    note: String(opts.note || ''),
    risk,
    at: new Date().toISOString(),
  });
  saveState(s);
  audit('`' + pr.id + '` review    ' + by + ' ' + verdict + (opts.note ? '  ' + opts.note : ''));
  return { ...pr, gate: reviewGate(pr) };
}

/** 待审队列（给两位总管看） */
export function pending() {
  const s = loadState();
  return Object.values(s.prs)
    .filter((p) => p.status === 'ready')
    .map((p) => ({ ...p, gate: reviewGate(p) }));
}


/** 合并回主干（受审阅门约束） */
export function approve(id, opts = {}) {
  const s = loadState();
  const pr = mustGet(s, id);
  if (pr.status === 'merged') return pr;
  if (!['ready', 'open'].includes(pr.status)) throw new Error('提案 ' + id + ' 状态是 ' + pr.status + '，不能合并');

  // 审阅门：先看风险等级、再看谁签过字
  const gate = reviewGate(pr);
  if (!gate.satisfied) {
    throw new Error(
      '提案 ' + pr.id + ' 是 ' + gate.risk + ' 级，需要 ' + gate.allowed.join(' 或 ') + ' 审阅后才能合并。\n'
      + '  当前已有审阅：' + ((pr.reviews || []).map((r) => asRank(r.by) + ':' + r.verdict).join(', ') || '无') + '\n'
      + '  先跑：node pr.mjs review ' + pr.id + ' --by ' + gate.allowed[0] + ' --note "审阅意见"'
    );
  }
  settleWorkspace();
  // protected 级要求另一位总管知情：不阻塞合并（否则对方离线就永远合不了），
  // 但必须留痕，事后能看出"这次谁不知道"。
  if (gate.missingInformed.length) {
    console.error('[审阅] 注意：' + gate.risk + ' 级改动，' + gate.missingInformed.join(', ') + ' 尚无知情记录（已记入审计）');
    audit('`' + pr.id + '` warn      ' + gate.risk + ' 改动，' + gate.missingInformed.join(', ') + ' 未留知情记录');
  }
  checkout(MAIN);
  const mergeSha = mergeNoFf(pr.branch, 'merge: ' + pr.id + ' ' + pr.title);
  pr.status = 'merged';
  pr.mergeSha = mergeSha;
  pr.approvedAt = new Date().toISOString();
  pr.approvedBy = gate.satisfiedBy || opts.by || 'rank1';
  saveState(s);
  audit('`' + pr.id + '` merged    ' + (mergeSha ? mergeSha.slice(0, 8) : ''));
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
  pr review <id> --by rank1|rank2 [--note "意见"] [--reject]
                               记一条审阅（docs 级 rank2 可放行；code/protected 需 rank1）
  pr pending                   待审队列：风险等级 + 还缺谁签字
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
  if (cmd === 'review') {
    const id = rest[0];
    if (!id) { console.error('要给提案号'); process.exit(2); }
    const opt = { by: '', verdict: 'approve', note: '' };
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--by') opt.by = rest[++i] || '';
      else if (a === '--reject') opt.verdict = 'reject';
      else if (a === '--note') opt.note = rest[++i] || '';
      else if (!opt.note) opt.note = a;
    }
    const r = review(id, opt);
    const g = r.gate;
    console.log(`${r.id} 已记录审阅：${asRank(opt.by)} ${opt.verdict}  风险=${g.risk}`);
    console.log(g.satisfied
      ? `  可以合并（${g.satisfiedBy} 已放行）`
      : `  还不能合并，需要 ${g.allowed.join(' 或 ')}`);
    if (g.missingInformed.length) console.log(`  还需知情：${g.missingInformed.join(', ')}`);
    return;
  }
  if (cmd === 'pending') {
    const rows = pending();
    if (!rows.length) { console.log('没有待审提案'); return; }
    console.log('待审提案：');
    rows.forEach((p) => {
      const g = p.gate;
      const who = g.satisfied ? `已满足（${g.satisfiedBy}）` : `需 ${g.allowed.join('/')}`;
      const rv = (p.reviews || []).map((r) => asRank(r.by) + ':' + r.verdict).join(', ') || '无';
      console.log(`  ${p.id}  ${g.risk.padEnd(9)}  ${who.padEnd(18)}  审阅:${rv}`);
      console.log(`      ${p.title}`);
      if (p.files.length) console.log('      ' + p.files.slice(0, 6).map((f) => f.file).join(', ') + (p.files.length > 6 ? ` …共 ${p.files.length} 个` : ''));
    });
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
