// 第一刀：让子会话能动手，但动在影子里。
// 硬约束（实测得出，别改）：
// 1) 主仓库一个字节都不许被子会话直接写 —— 全部写到 git worktree 影子副本里；
// 2) 产出的唯一形态是 patch，不是「已经改好了」；合不合由人/闸门决定；
// 3) 验收不过整份丢，不保留半成品（11-16 那次 vm/judge.mjs 被 LLM 回答覆写成 3 行就是没有这一层）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWorktreeSync, releaseWorktree, overlayWorkingTree } from './worktree.mjs';

export const PATCH_CONTRACT = 'atwo-patch/1';
// Bash 是必需的：不跑 `node --check`、不跑测试，它自己不知道写对了没有。
export const WRITE_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash';
export const MAX_WRITE_PARTS = 3;
// 连续失败后的降级形态：不给写权限，只要它说清卡在哪。
export const REPORT_TOOLS = 'Read,Grep,Glob';
export const CODE_EXT = /\.(mjs|js|cjs)$/i;

// 行尾必须和 worktree 检出时一致：createWorktreeSync 用 `-c core.autocrlf=false -c core.eol=lf` 建的副本，
// 后续 git 调用若走默认 autocrlf，`status` 会说文件变了而 `diff` 规范化后是空的 ——
// 现象就是「子会话没改却报 empty-diff」，2026-11-17 实测卡在这一步。
const GIT_CONF = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];
function runGit(cwd, args) {
  return spawnSync('git', [...GIT_CONF, ...args], { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true });
}

export function buildWritePrompt(task, index = 1, total = 1) {
  const seg = total > 1 ? `（第 ${index}/${total} 路：只看你这一路要改的文件，别碰别路）` : '';
  return [
    '# 任务' + seg,
    String(task || '').trim(),
    '',
    '## 硬约束（违反就整份作废）',
    '1. 你在一份**副本**里工作，改完会以 patch 形式交上去；不要执行任何 git 写操作（commit / push / checkout / reset / add 都不许）。',
    '2. 只改完成任务必需的文件。不要顺手重构、不要补注释、不要新建与本任务无关的文件。',
    '3. 改完自己验：`node --check <你改的每个 .mjs>`；如果仓库里有对应测试，跑它（`node test/<名字>.test.mjs`）。',
    '4. 回答里必须写清：改了哪几个文件、每个文件为什么必须改、验收命令与真实输出。',
    '5. 做不到就直说做不到，不要为了交差写一半。',
  ].join('\n');
}

// 副本里叠了主仓库未提交的改动 —— 不先固化基线，`git status` 会把「别人改了没提交」
// 当成「子会话改了」，patch 里就会混进不是它写的东西。
// 2026-11-17 实测踩到：主仓库当时有 6 项未提交，假会话什么都没干，patch 却非空。
// paths 给了就只固化这些路径（overlay 叠进来的那些）。
// 为什么：副本从 HEAD 检出、index 与工作区本来就一致，与 HEAD 不同的只有 overlay 的那十几个文件；
// 全仓库 `add -A` 要把 474 个文件逐个 stat+hash，实测 1.5–3.3s，而只 add 这十几个是毫秒级。
// 不传 paths 时退回全仓库 add -A（保守路径，行为与以前完全一致）。
export function baselineStage(dir, paths) {
  const only = Array.isArray(paths) ? paths.filter((p) => String(p || '').trim()) : [];
  const args = only.length ? ['add', '-A', '--', ...only] : ['add', '-A'];
  const r = runGit(dir, args);
  return { ok: r.status === 0, reason: r.status === 0 ? null : String(r.stderr || '').slice(0, 200), staged: only.length };
}

// 不能用 git status 判「子会话改了什么」：基线固化（add -A）之后，status 的前两位是相对 HEAD 的，
// 而 HEAD 里本来就没有 overlay 进来的未提交改动 —— 于是永远非空，patch 会混进不是它写的东西。
// 只看「index 与工作区的差」+「未跟踪文件」，才等于「子会话这一轮动了什么」。
export function changedFiles(dir) {
  const mod = runGit(dir, ['diff', '--name-only', '-z']);
  const unt = runGit(dir, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (mod.status !== 0 || unt.status !== 0) {
    const why = String((mod.status !== 0 ? mod.stderr : unt.stderr) || '').slice(0, 200);
    return { ok: false, files: [], reason: 'status-failed: ' + why };
  }
  const files = [];
  for (const rel of String(mod.stdout || '').split('\0')) {
    if (rel) files.push({ path: rel.split(path.sep).join('/'), code: 'M' });
  }
  for (const rel of String(unt.stdout || '').split('\0')) {
    if (rel) files.push({ path: rel.split(path.sep).join('/'), code: '??' });
  }
  return { ok: true, files, reason: null };
}

// 新文件不在 git diff 里 —— 先 add -N 打成「意图新增」，否则子会话新建的文件会从 patch 里消失。
// 这一步只发生在这份一次性副本里，不影响主仓库。
export function diffOf(dir) {
  runGit(dir, ['add', '-N', '.']);
  const d = runGit(dir, ['diff', '--binary', '--no-color']);
  return { ok: d.status === 0, diff: String(d.stdout || ''), reason: d.status === 0 ? null : String(d.stderr || '').slice(0, 200) };
}

export function diffStatOf(dir) {
  runGit(dir, ['add', '-N', '.']);
  const d = runGit(dir, ['diff', '--stat', '--no-color']);
  return String(d.stdout || '').trim();
}

// 只对改动的代码文件跑 node --check：不碰 md/json，也不对整仓跑（那要 20 秒）。
export function syntaxCheck(dir, files, { nodeExe = process.execPath } = {}) {
  const targets = files.filter((f) => CODE_EXT.test(f.path) && f.code !== 'D');
  const results = [];
  for (const f of targets) {
    const r = spawnSync(nodeExe, ['--check', f.path], { cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true });
    results.push({ path: f.path, ok: r.status === 0, code: r.status, err: r.status === 0 ? null : String(r.stderr || '').trim().split(/\r?\n/).slice(0, 4).join(' ') });
  }
  return { ok: results.every((x) => x.ok), checked: results.length, results };
}

export function runTests(dir, cmd, { timeoutMs = 600000 } = {}) {
  if (!cmd) return { ok: true, skipped: true, cmd: null, code: null, out: '' };
  const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  const out = (String(r.stdout || '') + String(r.stderr || '')).trim();
  const tail = out.split(/\r?\n/).slice(-12).join('\n');
  return { ok: r.status === 0, skipped: false, cmd, code: r.status, timedOut: r.signal === 'SIGTERM', out: tail };
}

export function savePatch(root, diff, stamp) {
  const dir = path.join(root, '.atw', 'patches');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}.patch`);
  fs.writeFileSync(file, diff, 'utf8');
  return file;
}

function stampOf() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function runOnePart(opts, index, total, stamp) {
  const { cwd, task, ask, timeoutMs, maxTurns, testCmd, model, onProgress, readOnly } = opts;
  const made = createWorktreeSync(cwd, {});
  if (!made.ok) return { index, ok: false, reason: 'worktree: ' + (made.reason || 'unknown'), dir: null };
  const dir = made.dir;
  const started = Date.now();
  const out = { index, ok: false, dir, changed: [], diffStat: '', diff: '', syntax: null, tests: null, answer: '', reason: null, elapsedMs: 0, patchPath: null };
  try {
    const ov = overlayWorkingTree(cwd, dir);
    if (!ov.ok && ov.reason) out.overlayReason = ov.reason;
    const base = baselineStage(dir, ov.paths || []);
    if (!base.ok) out.overlayReason = (out.overlayReason || '') + ' baseline: ' + base.reason;
    if (typeof onProgress === 'function') onProgress({ phase: 'worktree', index, dir, overlay: ov });
    const r = await ask(buildWritePrompt(task, index, total), {
      cwd: dir,
      timeoutMs,
      model,
      tools: readOnly ? REPORT_TOOLS : WRITE_TOOLS,
      permissionMode: readOnly ? undefined : 'bypassPermissions',
      maxTurns,
    });
    out.answer = String((r && r.text) || '');
    if (readOnly) {
      // 降级模式：不改文件，只交诊断。改不出能过验收的代码时，硬写只会重复失败。
      out.ok = out.answer.trim().length > 0;
      out.report = out.answer;
      if (!out.ok) out.reason = 'empty-report: 降级模式也要给出卡在哪';
      return out;
    }
    const ch = changedFiles(dir);
    out.changed = ch.files;
    if (ch.files.length === 0) {
      out.reason = 'no-change: 子会话一个文件都没改';
      return out;
    }
    out.diffStat = diffStatOf(dir);
    // 失败也要留下它写了什么 —— 只存通过的 patch，出了红就只能重跑一遍去猜原因（2026-11-17 实测踩到）。
    const early = diffOf(dir);
    if (early.ok) out.diff = early.diff;
    out.syntax = syntaxCheck(dir, ch.files);
    if (!out.syntax.ok) {
      const bad = out.syntax.results.filter((x) => !x.ok).map((x) => x.path);
      out.reason = `syntax: ${bad.join(', ')}`;
      out.rejectedPath = out.diff ? savePatch(cwd, out.diff, stamp + '-rejected-' + index) : null;
      return out;
    }
    out.tests = runTests(dir, testCmd, { timeoutMs });
    if (!out.tests.ok) {
      out.reason = `tests: ${out.tests.cmd} → exit ${out.tests.code}`;
      out.rejectedPath = out.diff ? savePatch(cwd, out.diff, stamp + '-rejected-' + index) : null;
      return out;
    }
    const d = early.ok ? early : diffOf(dir);
    if (!d.ok || !d.diff.trim()) {
      out.reason = 'empty-diff: 改动读不出版本差异';
      return out;
    }
    out.diff = d.diff;
    out.patchPath = savePatch(cwd, d.diff, total > 1 ? `${stamp}-${index}` : stamp);
    out.ok = true;
    return out;
  } catch (err) {
    out.reason = 'exception: ' + (err && err.message);
    return out;
  } finally {
    out.elapsedMs = Date.now() - started;
    // 副本必须销毁：留着会占磁盘，也会让下次 listWorktrees 分不清谁是活的。
    await releaseWorktree(dir, { repo: cwd });
  }
}

export async function runPatch(opts = {}) {
  const started = Date.now();
  const cwd = path.resolve(opts.cwd || process.cwd());
  const total = Math.max(1, Math.min(MAX_WRITE_PARTS, Math.floor(Number(opts.parts) || 1)));
  const base = {
    cwd,
    task: opts.task,
    ask: opts.ask || opts.writeAsk,
    timeoutMs: Number(opts.timeoutMs) || 600000,
    maxTurns: Number(opts.maxTurns) || 24,
    testCmd: opts.testCmd || null,
    model: opts.model || null,
    onProgress: opts.onProgress,
    // 这个字段漏过一次：runPatch({readOnly:true}) 传了、base 没复制，
    // 于是降级模式照样给写权限，report 永远是空的（2026-11-17 真跑抓到）。
    readOnly: !!opts.readOnly,
  };
  if (typeof base.ask !== 'function') {
    return { contract: PATCH_CONTRACT, ok: false, error: '没有可用的写入通道（ask 未注入）', parts: [], elapsedMs: 0 };
  }
  const stamp = stampOf() + '-' + String(process.pid);
  const parts = [];
  for (let i = 1; i <= total; i++) {
    // 串行：同一仓库多 worktree 并行写会让 CPU 打满、且我一次也只验得动一份。
    parts.push(await runOnePart(base, i, total, stamp));
  }
  const okParts = parts.filter((p) => p.ok);
  return {
    contract: PATCH_CONTRACT,
    ok: okParts.length > 0,
    allOk: parts.length > 0 && okParts.length === parts.length,
    stamp,
    parts,
    // 降级模式也会 ok，但没有 patch —— 别把 null 当路径交出去（测试当场抓到 [null]。length===1）。
    patchPaths: okParts.map((p) => p.patchPath).filter(Boolean),
    elapsedMs: Date.now() - started,
  };
}

export function formatPatchResult(r) {
  if (!r) return '（没有结果）';
  const L = [];
  if (r.error) return '✗ ' + r.error;
  for (const p of r.parts || []) {
    const head = `第 ${p.index} 路：${p.ok ? (p.report ? '✓ 出了报告（降级，未改代码）' : '✓ 出了 patch') : '✗ ' + (p.reason || '未通过')}`;
    L.push(head);
    if (p.changed && p.changed.length) L.push('  改了：' + p.changed.map((f) => f.path).join(', '));
    if (p.diffStat) L.push('  ' + p.diffStat.split(/\r?\n/).join('\n  '));
    if (p.tests && !p.tests.skipped) L.push(`  验收：${p.tests.cmd} → exit ${p.tests.code}${p.tests.ok ? '（过）' : '（红）'}`);
    if (p.ok && p.patchPath) L.push(`  patch：${p.patchPath}`);
    if (p.ok && p.patchPath) L.push(`  合：git apply ${p.patchPath}`);
    if (!p.ok && p.rejectedPath) L.push(`  它写了什么（已丢弃，仅供复盘）：${p.rejectedPath}`);
  }
  L.push(`合计 ${(r.elapsedMs / 1000).toFixed(1)}s · ${r.patchPaths.length} 份 patch（主仓库未改动）`);
  return L.join('\n');
}
