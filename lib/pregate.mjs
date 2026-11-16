// lib/pregate.mjs —— 分层验收的第一、二层：机器能做的先做完，别让父审花时间在机械活上。
//
// 第一层 preGate：只判「证据形式」（有没有答案、有没有可核对的引用）。
//   8 路编队里有 2 路来自本地小模型，产物一眼能看出不合格 —— 让父审（一次 20–60s）
//   去读这种产物是纯浪费；但也不能直接判死内容，所以判死的唯一理由是形式缺失。
//
// 第二层 collectRefs：把产物引用的「文件:行」原文预先读好，塞进父审提示。
//   2026-11-16 实测：父审的开销主要不是读产物，是它自己调 Read 逐行核对
//   （每份 3–5 次读、每次 2–4s round-trip）。原文摆到桌上，核对就变成纯比对。
//   这不是判定 —— 对不上时仍由父审判，只是把证据换成确定性输入。
import fs from 'node:fs';
import path from 'node:path';

export const PRE = { revise: 'REVISE', defer: 'defer' };

const FILE_LINE = /[\w./\-]+\.(?:mjs|js|cjs|ts|py|json|json5|md|txt|yml|yaml|toml|sh|ps1|rs|go|c|h|cpp|java|sql)\b[^a-zA-Z0-9]{0,12}\d+/i;
const LINE_WORD = /第\s*\d+\s*行|line\s*\d+|L\d{1,5}\b/i;

export function preGate(child) {
  const id = (child && child.id) || 'child-?';
  const answer = String((child && child.answer) || '').trim();
  const evidence = String((child && child.evidence) || '').trim();
  if (!answer) return { id, verdict: PRE.revise, reason: '机械闸门：ANSWER 为空（等于没交）', mechanical: true };
  if (!evidence) return { id, verdict: PRE.revise, reason: '机械闸门：EVIDENCE 为空（无法核对）', mechanical: true };
  const hasRef = FILE_LINE.test(evidence) || LINE_WORD.test(evidence);
  if (!hasRef) return { id, verdict: PRE.revise, reason: '机械闸门：EVIDENCE 没有「文件:行」或「第 N 行」，不可核对（要它自己去读源码再交）', mechanical: true };
  return { id, verdict: PRE.defer, reason: '', mechanical: true };
}

/** 一次判完一批；返回 reviews（机械判定的部分）与 deferred（要送父审的 children）。 */
export function preGateAll(children, opts = {}) {
  const reviews = [];
  const deferred = [];
  for (const c of children || []) {
    const g = preGate(c);
    if (g.verdict === PRE.revise) { reviews.push(g); continue; }
    const r = refMatchCheck(c, opts);
    if (r.verdict === PRE.revise) { reviews.push(r); continue; }
    deferred.push(opts.withRefMatch ? Object.assign({}, c, { refMatch: r.refMatch }) : c);
  }
  return { reviews, deferred };
}

const REF = /([\w./\\-]+\.(?:mjs|js|cjs|ts|py|json|md|txt|yml|yaml))[:：](\d{1,6})(?:\s*[-–~]\s*(\d{1,6}))?/g;

/** 收集被引用的行原文，供父审直接比对。返回 { text, files, chars, missing }。 */
export function collectRefs(children, { cwd = process.cwd(), maxPerFile = 40, maxFiles = 6, maxChars = 6000 } = {}) {
  const files = new Map();
  for (const c of children || []) {
    const text = String((c && c.evidence) || '') + '\n' + String((c && c.answer) || '');
    for (const m of text.matchAll(REF)) {
      const rel = m[1].replace(/^[a-zA-Z]:[\\/]/, '').replace(/\\/g, '/');
      const line = Number(m[2]);
      if (!Number.isFinite(line) || line < 1) continue;
      if (!files.has(rel)) files.set(rel, new Set());
      files.get(rel).add(line);
    }
  }
  const out = [];
  const missing = [];
  let total = 0;
  for (const [rel, lines] of files) {
    if (out.length >= maxFiles) break;
    let body;
    try { body = fs.readFileSync(path.resolve(cwd, rel), 'utf8').split(/\r?\n/); } catch { missing.push(rel); continue; }
    const picked = [...lines].filter((l) => l <= body.length).sort((a, b) => a - b).slice(0, maxPerFile);
    if (!picked.length) { missing.push(rel + '（行号超出文件长度 ' + body.length + '）'); continue; }
    const block = picked.map((l) => String(l) + ': ' + body[l - 1].trim().slice(0, 200)).join('\n');
    const piece = '### ' + rel + '\n' + block;
    if (total + piece.length > maxChars) break;
    total += piece.length;
    out.push(piece);
  }
  return { text: out.join('\n\n'), files: out.length, chars: total, missing };
}
const TOKEN = /[A-Za-z_][A-Za-z0-9_]{3,}|\d+/g;
const tokensOf = (s) => {
  const out = new Set();
  for (const m of String(s || '').matchAll(TOKEN)) out.add(m[0].toLowerCase());
  return out;
};

/** 第三层：引用比对。对每条「文件:行」，把该行真实 token 集与产物在该引用附近的 token 集求交集。
 *  交集为 0 = 产物在那一行的位置写的全是文件里不存在的标识符 → 证据对不上原文。
 *  标定（2026-11-16，30 份真实产物）：PASS 产物零重叠比例 0–17%，本地小模型捏造的产物 100%。
 *  所以只在「可判引用 ≥4 条且零重叠 ≥50%」时判死，单条不判（省略式引用合法）。 */
export function refMatchCheck(child, { cwd = process.cwd() } = {}) {
  const id = (child && child.id) || 'child-?';
  const text = String((child && child.evidence) || '') + '\n' + String((child && child.answer) || '');
  const details = [];
  for (const m of text.matchAll(REF)) {
    const rel = m[1].replace(/^[a-zA-Z]:[\\/]/, '').replace(/\\/g, '/');
    const ln = Number(m[2]);
    let body;
    try { body = fs.readFileSync(path.resolve(cwd, rel), 'utf8').split(/\r?\n/); } catch { continue; }
    if (ln < 1 || ln > body.length) continue;
    const real = tokensOf(body[ln - 1]);
    if (real.size < 3) continue;
    const idx = m.index + m[0].length;
    const around = tokensOf(text.slice(Math.max(0, m.index - 80), Math.min(text.length, idx + 160)));
    let inter = 0;
    for (const t of real) if (around.has(t)) inter += 1;
    details.push({ rel, ln, overlap: inter / real.size, line: body[ln - 1].trim().slice(0, 80), realSize: real.size });
  }
  const judged = details.length;
  const zero = details.filter((d) => d.overlap === 0).length;
  const detail = details.slice(0, 12);
  if (judged >= 4 && zero / judged >= 0.5) {
    const sample = details.find((d) => d.overlap === 0);
    return {
      id, verdict: PRE.revise, mechanical: true, refMatch: { judged, zero, detail },
      reason: '机械闸门：引用了 ' + judged + ' 处「文件:行」，其中 ' + zero + ' 处那一行里找不到你写的任何标识符（例如 ' + sample.rel + ':' + sample.ln + ' 实际是「' + sample.line + '」）—— 证据对不上原文，重做时去读真文件',
    };
  }
  return { id, verdict: PRE.defer, mechanical: true, refMatch: { judged, zero, detail } };
}
