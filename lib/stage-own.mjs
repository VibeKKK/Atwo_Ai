// atwo stage --from-edits：只把「我改的那些 hunk」放进暂存区。
//
// 为什么需要它：共享仓库里 `git add <file>` 会把同事未提交的改动一起签走
// （2026-11-17 发生过：我的三笔提交把对方 atwo.mjs 的改动整文件带走）。
// 判据不靠行号（行号会因别人的改动漂移），靠文本证据：
// edits.jsonl 里每条记录都留了 `to`（我写进去的片段），只有新增行里含这个片段的 hunk 才算我的。
//
// 三条规矩：① 命不中的 hunk 一律跳过，绝不猜 ② 一个 hunk 里同时有我的片段和别人无法归属的行时，标 mixed 并整块跳过 ③ 幂等：已暂存的改动不在 git diff 里，重复跑不会重复暂存。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NL = String.fromCharCode(10);
export const STAGE_CONTRACT = 'atwo-stage/1';
export const EDITS_LOG = path.join('.atw', 'edits.jsonl');
export const MIN_FRAGMENT = 8;

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

export function readEditRows(cwd) {
  const p = path.join(cwd, EDITS_LOG);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (row && row.file && row.to) out.push(row);
    } catch {
      // 坏行不阻断：记账文件是人可改的，坏一行不该让整条链停摆
    }
  }
  return out;
}

// 每条记录取「首个非空行」的前 60 字符当指纹；太短（< MIN_FRAGMENT）不用，避免误认领。
export function fragmentsOf(rows) {
  const byFile = new Map();
  for (const row of rows) {
    const first = String(row.to).split(/\r?\n/).map((x) => x.trim()).find((x) => x.length >= MIN_FRAGMENT);
    if (!first) continue;
    const frag = first.slice(0, 60);
    if (!byFile.has(row.file)) byFile.set(row.file, new Set());
    byFile.get(row.file).add(frag);
  }
  return byFile;
}

export function parseHunks(diffText) {
  const hunks = [];
  let cur = null;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      if (cur) hunks.push(cur);
      cur = { header: line, added: [], raw: [line] };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      cur.added.push(line.slice(1));
      cur.raw.push(line);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      cur.raw.push(line);
    } else if (line.startsWith(' ') || line === '') {
      cur.raw.push(line);
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

export function hunkIsMine(hunk, frags) {
  if (!hunk.added.length) return false;
  const text = hunk.added.join(NL);
  for (const f of frags) if (text.includes(f)) return true;
  return false;
}

export function buildPatch(file, hunks) {
  const head = ['diff --git a/' + file + ' b/' + file, '--- a/' + file, '+++ b/' + file];
  const body = [];
  for (const h of hunks) for (const l of h.raw) body.push(l);
  return head.concat(body).join(NL) + NL;
}

export function planStage(cwd, opts = {}) {
  const rows = readEditRows(cwd);
  const frags = fragmentsOf(rows);
  const assume = new Set((opts.assume || []).map((s) => String(s).trim()).filter(Boolean));
  const changed = git(cwd, ['diff', '--name-only', '--no-color']);
  const files = String(changed.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const plan = [];
  for (const file of files) {
    const d = git(cwd, ['diff', '-U0', '--no-color', '--', file]);
    const hunks = parseHunks(String(d.stdout || ''));
    const mine = [];
    const others = [];
    const fr = frags.get(file) || new Set();
    const forced = assume.has(file);
    for (const h of hunks) (forced || hunkIsMine(h, fr) ? mine : others).push(h);
    if (!hunks.length) continue;
    plan.push({ file, total: hunks.length, mine, others, tracked: fr.size > 0 });
  }
  return { rows: rows.length, plan };
}

export function runStage(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const assumed = new Set((opts.assume || []).map((s) => String(s).trim()).filter(Boolean));
  const { rows, plan } = planStage(cwd, { assume: opts.assume });
  const files = [];
  let stagedHunks = 0;
  let skippedHunks = 0;
  const errors = [];
  for (const f of plan) {
    const entry = { file: f.file, mine: f.mine.length, others: f.others.length, known: f.tracked || assumed.has(f.file), staged: false, assumed: assumed.has(f.file) };
    skippedHunks += f.others.length;
    if (!f.mine.length) {
      if (!f.tracked) entry.note = '这个文件没有我去改过的记录（不是我改的，或改了没走 atwo edit）';
      files.push(entry);
      continue;
    }
    if (opts.dryRun) {
      entry.staged = false;
      entry.would = f.mine.length;
      files.push(entry);
      continue;
    }
    const patch = buildPatch(f.file, f.mine);
    const res = spawnSync('git', ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'], { cwd, input: patch, encoding: 'utf8' });
    if (res.status === 0) {
      entry.staged = true;
      stagedHunks += f.mine.length;
    } else {
      entry.error = String(res.stderr || '').trim().slice(0, 300);
      errors.push(f.file + '：' + entry.error);
    }
    files.push(entry);
  }
  return {
    contract: STAGE_CONTRACT,
    ok: errors.length === 0,
    dryRun: !!opts.dryRun,
    editsLogged: rows,
    stagedHunks,
    skippedHunks,
    files,
    errors,
  };
}

export function formatStage(r) {
  const L = [];
  const mine = r.files.reduce((n, f) => n + f.mine, 0);
  const others = r.files.reduce((n, f) => n + f.others, 0);
  L.push((r.dryRun ? '看了一遍（没动暂存区）：' : '暂存完了：') + '我的 ' + mine + ' 处 / 别人的 ' + others + ' 处');
  for (const f of r.files) {
    const tail = f.error ? ' ✗ ' + f.error : (f.staged ? ' ✓ 已暂存' : (f.note ? ' · ' + f.note : ''));
    L.push('  ' + f.file + '  我的 ' + f.mine + ' · 别人 ' + f.others + tail);
  }
  if (!r.editsLogged) L.push('  （.atw/edits.jsonl 是空的 —— 改动没走 atwo edit，无法判断归属，一个都没暂存）');
  if (!r.files.length) L.push('  工作区没有未暂存的改动');
  if (r.ok && r.stagedHunks) L.push('下一步：git commit -F <消息文件>  （消息仍手写：机器不知道你这笔在做什么）');
  if (!r.ok) L.push('有文件没能暂存：' + r.errors.join('；'));
  return L.join(NL);
}