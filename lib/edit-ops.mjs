// lib/edit-ops.mjs —— 结构化改文件。
//
// 为什么要有它：今晚我手拼补丁脚本踩了四次坑 —— 反引号、换行被解释、read 带 limit 把文件截断、
// CRLF 文件按 LF 拼的 marker 匹配不上。这些都不是判断错误，是「shell 字符串 + 整文件重写」
// 这个接口本身的错。接口换成 JSON 指令，这些错误就没了。
//
// 三条硬规矩：
// 1. 字面量匹配，不收正则 —— 正则要转义，转义就是今天所有 bug 的来源。
// 2. 默认要求唯一命中，命不中或命多都是错，绝不猜。
// 3. 全部 op 先在内存里算完；语法红或任一 op 失败，一个字节都不写（原子）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const EDIT_CONTRACT = 'atwo-edit/1';
const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);
const MAX_OPS = 40;
const JS_EXT = ['.mjs', '.js', '.cjs'];

export function eolOf(text) {
  return text.includes(CR + NL) ? CR + NL : NL;
}

function toLf(text) {
  return String(text).split(CR + NL).join(NL);
}

function toEol(text, eol) {
  return eol === NL ? text : String(text).split(NL).join(eol);
}

function countOf(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) { n += 1; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

function lineAt(text, index) {
  let n = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

// 一个 op 在已 normalize 成 LF 的文本上算出新文本；失败给出机器码。
export function applyOne(textLf, op) {
  const kind = op.kind || (op.anchor ? 'insert' : 'replace');
  if (kind === 'replace') {
    const find = toLf(op.find == null ? '' : op.find);
    const rep = toLf(op.replace == null ? '' : op.replace);
    if (!find) return { ok: false, reason: 'empty-find' };
    const n = countOf(textLf, find);
    if (n === 0) return { ok: false, reason: 'not-found' };
    if (n > 1 && op.all !== true) return { ok: false, reason: 'ambiguous', hits: n };
    const at = textLf.indexOf(find);
    const out = op.all === true ? textLf.split(find).join(rep) : textLf.slice(0, at) + rep + textLf.slice(at + find.length);
    return { ok: true, out, hits: n, line: lineAt(textLf, at), delta: rep.split(NL).length - find.split(NL).length };
  }
  if (kind === 'insert') {
    const anchor = toLf(op.anchor == null ? '' : op.anchor);
    const body = toLf(op.insert == null ? '' : op.insert);
    if (!anchor) return { ok: false, reason: 'empty-anchor' };
    if (!body) return { ok: false, reason: 'empty-insert' };
    const n = countOf(textLf, anchor);
    if (n === 0) return { ok: false, reason: 'anchor-not-found' };
    if (n > 1 && op.all !== true) return { ok: false, reason: 'ambiguous-anchor', hits: n };
    const at = textLf.indexOf(anchor);
    const end = at + anchor.length;
    const where = op.where === 'before' ? 'before' : 'after';
    const out = where === 'before'
      ? textLf.slice(0, at) + body + NL + textLf.slice(at)
      : textLf.slice(0, end) + NL + body + textLf.slice(end);
    return { ok: true, out, hits: n, line: lineAt(textLf, at), delta: body.split(NL).length + 1 };
  }
  return { ok: false, reason: 'unknown-kind:' + String(kind) };
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') return { ok: false, reason: 'spec-not-object' };
  const ops = Array.isArray(spec.ops) ? spec.ops : null;
  if (!ops) return { ok: false, reason: 'spec.ops-missing' };
  if (!ops.length) return { ok: false, reason: 'spec.ops-empty' };
  if (ops.length > MAX_OPS) return { ok: false, reason: 'spec.ops-too-many', max: MAX_OPS };
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i] || {};
    if (!op.file) return { ok: false, reason: 'op[' + i + '].file-missing' };
    if (path.isAbsolute(op.file) || op.file.startsWith('..')) return { ok: false, reason: 'op[' + i + '].file-outside' };
  }
  return { ok: true, ops };
}

function checkSyntax(cwd, cache) {
  const bad = [];
  for (const [abs, entry] of cache) {
    if (!entry.touched) continue;
    if (!JS_EXT.some((x) => abs.toLowerCase().endsWith(x))) continue;
    const rr = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
    if (rr.status !== 0) {
      bad.push({
        file: path.relative(cwd, abs),
        error: String(rr.stderr || NL).split(NL).filter(Boolean).slice(0, 2).join(' / ').slice(0, 300),
      });
    }
  }
  return bad;
}

export function runEdits(spec, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const v = validateSpec(spec);
  if (!v.ok) return { contract: EDIT_CONTRACT, ok: false, reason: v.reason, dryRun: !!opts.dryRun, results: [] };

  const cache = new Map();
  const results = [];
  for (let i = 0; i < v.ops.length; i += 1) {
    const op = v.ops[i];
    const abs = path.resolve(cwd, op.file);
    if (!fs.existsSync(abs)) {
      results.push({ op: i, file: op.file, ok: false, reason: 'file-missing' });
      continue;
    }
    if (!cache.has(abs)) {
      const raw = fs.readFileSync(abs, 'utf8');
      cache.set(abs, { raw, eol: eolOf(raw), lf: toLf(raw), touched: false });
    }
    const entry = cache.get(abs);
    const r = applyOne(entry.lf, op);
    if (!r.ok) {
      results.push({ op: i, file: op.file, ok: false, reason: r.reason, hits: r.hits || 0 });
      continue;
    }
    entry.lf = r.out;
    entry.touched = true;
    results.push({ op: i, file: op.file, ok: true, line: r.line, delta: r.delta, hits: r.hits, to: String(op.replace != null ? op.replace : (op.insert || '')).slice(0, 60) });
  }

  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    return { contract: EDIT_CONTRACT, ok: false, reason: 'atomic-abort', dryRun: !!opts.dryRun, results, failed: bad.map((r) => r.op) };
  }
  const writing = !opts.dryRun;
  if (writing) {
    for (const [abs, entry] of cache) if (entry.touched) fs.writeFileSync(abs, toEol(entry.lf, entry.eol));
  }
  // 语法兜底：改完立刻 node --check，红了整批回滚 —— 今晚两次把文件写坏都是靠它救命。
  if (writing && opts.check) {
    const syntax = checkSyntax(cwd, cache);
    if (syntax.length) {
      for (const [abs, entry] of cache) if (entry.touched) fs.writeFileSync(abs, entry.raw);
      return { contract: EDIT_CONTRACT, ok: false, reason: 'syntax-after-edit', dryRun: false, results, syntax, changed: [], rolledBack: true };
    }
  }
  const changed = [...cache.entries()].filter(([, e]) => e.touched).map(([abs, e]) => ({ file: path.relative(cwd, abs), eol: e.eol === NL ? 'LF' : 'CRLF' }));
  return { contract: EDIT_CONTRACT, ok: true, dryRun: !writing, results, changed };
}

// 记账：谁改的、改在哪一行。atwo commit 靠它认领 hunk。
export function logEdits(cwd, run, meta = {}) {
  const p = path.join(cwd, '.atw', 'edits.jsonl');
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const ts = new Date().toISOString();
    const lines = (run.results || []).filter((r) => r.ok).map((r) => JSON.stringify({ ts, by: meta.by || null, file: r.file, line: r.line, delta: r.delta, to: r.to || '' }));
    if (lines.length) fs.appendFileSync(p, lines.join(NL) + NL);
    return p;
  } catch {
    return null;
  }
}

export function formatEdit(r) {
  if (!r.ok) {
    const head = r.reason === 'syntax-after-edit'
      ? '✗ 改完语法不过，已整批回滚（文件与改前逐字节相同）'
      : r.reason === 'atomic-abort' ? '✗ 一处没过，整批没写（原子）' : '✗ 指令没用成：' + r.reason;
    const lines = [head];
    for (const x of r.results) {
      if (x.ok) lines.push('  – ' + x.file + ' 第 ' + x.line + ' 行（同一批，未落盘）');
      else lines.push('  ✗ ' + x.file + '：' + x.reason + (x.hits ? '（命中 ' + x.hits + ' 处）' : ''));
    }
    for (const s of r.syntax || []) lines.push('  语法 ' + s.file + '：' + s.error);
    if (r.reason === 'ambiguous' || r.reason === 'atomic-abort') lines.push('', '命中多处时给 all:true，或把 find 写长到唯一。');
    return lines.join(NL);
  }
  const lines = [(r.dryRun ? '预览（未写盘）：' : '改完了：') + (r.changed || []).length + ' 个文件'];
  for (const x of r.results) lines.push('  ✓ ' + x.file + ' 第 ' + x.line + ' 行 · 行数变化 ' + (x.delta > 0 ? '+' : '') + x.delta);
  for (const c of r.changed || []) lines.push('    ' + c.file + '（' + c.eol + '）');
  return lines.join(NL);
}