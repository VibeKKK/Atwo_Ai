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
import { runSandboxed, allowCommand, makeShadow } from './sandbox.mjs';

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
  const list = children || [];
  // RUN 核对：一批产物共用一个影子副本，用完就删（真仓库一个字节都不动）。
  // 懒建：没人声称跑过就不复制仓库（27MB 复制约 5.9s，不该白付）。
  let shadow = null;
  let shadowTried = false;
  let shadowFail = null;
  const wantsRun = !!opts.runVerify;
  const ensureShadow = () => {
    if (!wantsRun || opts.runVerify.dir) return (opts.runVerify && opts.runVerify.dir) || null;
    if (shadowTried) return shadow ? shadow.dir : null;
    shadowTried = true;
    shadow = makeShadow(opts.runVerify.cwd || opts.cwd || process.cwd());
    if (!shadow.ok) shadowFail = shadow.reason;
    return shadow ? shadow.dir : null;
  };
  const runCwd0 = wantsRun && opts.runVerify.dir ? opts.runVerify.dir : null;
  const runLog = [];
  try {
    for (const c of list) {
      const g = preGate(c);
      if (g.verdict === PRE.revise) { reviews.push(g); continue; }
      const r = refMatchCheck(c, opts);
      if (r.verdict === PRE.revise) { reviews.push(r); continue; }
      const needsRun = wantsRun && parseRuns(c).length > 0;
      const runCwd = needsRun ? (runCwd0 || ensureShadow()) : null;
      if (needsRun && !runCwd) {
        reviews.push({ id: (c && c.id) || 'child-?', verdict: PRE.revise, mechanical: true, runs: [], reason: '机械闸门：产物声称跑过命令，但影子副本没建成 —— ' + (shadowFail || '未知原因') + '（不能在真仓库里跑，只能判死）' });
        continue;
      }
      if (needsRun && runCwd) {
        const rc = runCheck(c, { cwd: runCwd, timeoutMs: opts.runVerify.timeoutMs, maxRuns: opts.runVerify.maxRuns });
        runLog.push(...rc.runs);
        if (rc.verdict === PRE.revise) { reviews.push(rc); continue; }
        deferred.push(opts.withRefMatch ? Object.assign({}, c, { refMatch: r.refMatch, runs: rc.runs }) : Object.assign({}, c, { runs: rc.runs }));
        continue;
      }
      deferred.push(opts.withRefMatch ? Object.assign({}, c, { refMatch: r.refMatch }) : c);
    }
  } finally {
    if (shadow && shadow.cleanup) shadow.cleanup();
  }
  return { reviews, deferred, runs: runLog, shadow: { ok: true } };
}

// ── RUN 证据：产物声称「我跑过」，机械层就真跑一遍。声称与实跑不符 → 判死。
// 形状：EVIDENCE 里写 RUN node test/x.test.mjs → exit 0
const RUN_RE = /RUN[:：]?\s*([^\n→]+?)\s*(?:→|->|=>)\s*exit\s*(-?\d+)/gi;

/** 从产物的 answer/evidence 里抠出所有 RUN 声明。 */
export function parseRuns(child) {
  const text = String((child && child.evidence) || '') + '\n' + String((child && child.answer) || '');
  const out = [];
  for (const m of text.matchAll(RUN_RE)) {
    const cmd = m[1].replace(/[「」“”]/g, '').replace(/^[\s:：-]+/, '').trim();
    const declared = Number(m[2]);
    if (!cmd || !Number.isFinite(declared)) continue;
    out.push({ cmd, declared });
  }
  return out;
}

/** 重跑每条 RUN，比对退出码。返回 { id, verdict, runs, reason }。 */
export function runCheck(child, { cwd, timeoutMs = 120000, maxRuns = 3 } = {}) {
  const id = (child && child.id) || 'child-?';
  const claimed = parseRuns(child);
  if (!claimed.length) return { id, verdict: PRE.defer, runs: [], mechanical: true };
  if (!cwd) return { id, verdict: PRE.defer, runs: [], mechanical: true, reason: '没有可比对的目录，跳过 RUN 核对' };
  const runs = [];
  for (const c of claimed.slice(0, maxRuns)) {
    const allow = allowCommand(c.cmd);
    if (!allow.ok) {
      return { id, verdict: PRE.revise, mechanical: true, runs, reason: '机械闸门：RUN 想跑的命令不许跑 —— ' + c.cmd + '（' + allow.reason + '）' };
    }
    const r = runSandboxed(c.cmd, { cwd, timeoutMs });
    runs.push({ cmd: c.cmd, declared: c.declared, actual: r.code, ok: r.code === c.declared, ms: r.ms, timedOut: r.timedOut });
    if (r.timedOut) {
      return { id, verdict: PRE.revise, mechanical: true, runs, reason: '机械闸门：RUN 跑不完（超时 ' + timeoutMs + 'ms）—— ' + c.cmd + '。要么命令本身会挂，要么它会等输入' };
    }
    if (r.code !== c.declared) {
      const hint = (r.stderr || r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' ⏎ ').slice(-200);
      return {
        id,
        verdict: PRE.revise,
        mechanical: true,
        runs,
        reason: '机械闸门：RUN 声明与实跑不符 —— ' + c.cmd + ' 你写 exit ' + c.declared + '，实跑 exit ' + r.code + (hint ? '；尾部输出：' + hint : '') + '（要么没跑就写了，要么跑的是别的东西）',
      };
    }
  }
  return { id, verdict: PRE.defer, runs, mechanical: true };
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
 *  判死三种情况（2026-11-17 补前两种，此前会被静默放过）：
 *   A 引用了不存在的行（行号 > 文件长度）—— 省略式引用不会编出行号，属硬错；
 *   B 引用 ≥2 处且全部零重叠 —— 每一处都对不上，不可能是写法差异；
 *   C 引用 ≥4 处且零重叠 ≥50% —— 原判据。
 *  单条弱证据（该行只有 1–2 个可判标识符）只记 detail，不单独判死。 */
export function refMatchCheck(child, { cwd = process.cwd() } = {}) {
  const id = (child && child.id) || 'child-?';
  const text = String((child && child.evidence) || '') + '\n' + String((child && child.answer) || '');
  const details = [];
  const missingLines = [];
  const weak = [];
  for (const m of text.matchAll(REF)) {
    const rel = m[1].replace(/^[a-zA-Z]:[\\/]/, '').replace(/\\/g, '/');
    const ln = Number(m[2]);
    const endLn = m[3] ? Number(m[3]) : ln;
    let body;
    try { body = fs.readFileSync(path.resolve(cwd, rel), 'utf8').split(/\r?\n/); } catch { continue; }
    if (ln < 1 || ln > body.length) { missingLines.push({ rel, ln, lines: body.length, line: body[ln - 1] ? '' : '' }); continue; }
    // 纯数字不进比对集：行号本身、常量 1/2 这类数字在引文里到处都是，会让零重叠永远算不成零
    // 引用写成 file:A-B 时按范围拼原文比对（2026-11-17 真实语料抓到的假阳性：
    // 产物引 task.py:880-882 的三行合体，旧版只读 880 行，于是判「引文与原文不符」）。
    const spanText = body.slice(ln - 1, Math.max(ln, Math.min(body.length, endLn))).join("\n");
    const real = new Set([...tokensOf(spanText)].filter((x) => !/^\d+$/.test(x)));
    const idx = m.index + m[0].length;
    const around = tokensOf(text.slice(Math.max(0, m.index - 80), Math.min(text.length, idx + 160)));
    let inter = 0;
    for (const t of real) if (around.has(t)) inter += 1;
    const overlap = real.size ? inter / real.size : 0;
    const row = { rel, ln, overlap, line: body[ln - 1].trim().slice(0, 80), realSize: real.size };
    if (real.size < 3) weak.push(row); else details.push(row);
  }
  const judged = details.length;
  const zero = details.filter((d) => d.overlap === 0).length;
  const detail = details.concat(weak).slice(0, 12);
  const base = { id, mechanical: true, refMatch: { judged, zero, weak: weak.length, missing: missingLines.length, detail } };
  if (missingLines.length) {
    const s = missingLines[0];
    return Object.assign({}, base, {
      verdict: PRE.revise,
      reason: '机械闸门：引用了不存在的行 —— ' + missingLines.map((x) => x.rel + ':' + x.ln).slice(0, 3).join('、') +
        '（该文件只有 ' + s.lines + ' 行）—— 证据对不上原文，重做时去读真文件',
    });
  }
  if (judged >= 2 && zero === judged) {
    const s = details.find((d) => d.overlap === 0);
    return Object.assign({}, base, {
      verdict: PRE.revise,
      reason: '机械闸门：引用了 ' + judged + ' 处「文件:行」，每一处都在那一行里找不到你写的任何标识符（例如 ' + s.rel + ':' + s.ln + ' 实际是「' + s.line + '」）—— 证据对不上原文，重做时去读真文件',
    });
  }
  // 规则 D（2026-11-17）：引用后面那段「像代码的引文」里的数字，该行真值里一个都没有 → 引文与原文不符。
  // 数字是 LLM 编造最常改的东西（6 → 99），token 重叠抓不到它，因为标识符名字完全一样。
  const numOf = (s) => (String(s).match(/\d+(?:\.\d+)?/g) || []);
  const badValue = [];
  for (const m of text.matchAll(REF)) {
    const rel = m[1].replace(/^[a-zA-Z]:[\\/]/, '').replace(/\\/g, '/');
    const ln = Number(m[2]);
    const endLn = m[3] ? Number(m[3]) : ln;
    let body;
    try { body = fs.readFileSync(path.resolve(cwd, rel), 'utf8').split(/\r?\n/); } catch { continue; }
    if (ln < 1 || ln > body.length) continue;
    const spanText = body.slice(ln - 1, Math.max(ln, Math.min(body.length, endLn))).join("\n");
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 80);
    const quote = after.replace(/^[\s—–\-:：|>]+/, '').split(/\n/)[0].trim();
    if (!/[=;(]/.test(quote)) continue;
    const qn = numOf(quote);
    if (!qn.length) continue;
    // 只有「代码位置的数字」才比：MAX_PARTS = 99 是抄写，19 条命令 是计数（2026-11-17 真语料误杀）。
    // 判据：数字前 3 字内有 ASCII 赋值/括号符，或后 3 字内有闭合符；紧跟中文量词的直接跳过。
    const codeNum = qn.filter((n) => {
      const i = quote.indexOf(n);
      if (i < 0) return false;
      const pre = quote.slice(Math.max(0, i - 3), i);
      const post = quote.slice(i + n.length, i + n.length + 3);
      // 紧跟在冒号后面的是「文件名:行号」里的行号本身，不是代码里的数字（2026-11-17 真语料第二类假阳性）。
      // 例：引文写 lib/contract.mjs:40 ... :43 ...，40/43 被当成抄写数字去和第 40 行内容比，必然对不上。
      if (/[:：]$/.test(pre)) return false;
      if (/^\s*[条个处种行次份项章节位]/.test(post)) return false;
      return /[=:(,[]/.test(pre) || /[);,\]]/.test(post);
    });
    if (!codeNum.length) continue;
    // 只在「引文确实像在抄这一行」时才比数字：与真行共享 ≥2 个非数字标识符。
    // 否则散文里提一个数字（「含 budget=6」）会被当成抄写错误 —— 那是误杀。
    const qTok = [...tokensOf(quote)].filter((x) => !/^\d+$/.test(x));
    const realTok = [...tokensOf(spanText)].filter((x) => !/^\d+$/.test(x));
    const shared = qTok.filter((x) => realTok.includes(x)).length;
    if (shared < 2) continue;
    const rn = new Set(numOf(spanText));
    if (codeNum.some((n) => rn.has(n))) continue;
    badValue.push({ rel, ln, quote: quote.slice(0, 60), real: body[ln - 1].trim().slice(0, 60) });
  }
  if (badValue.length) {
    const s = badValue[0];
    return Object.assign({}, base, {
      verdict: PRE.revise,
      reason: '机械闸门：引文与原文的数字对不上 —— ' + s.rel + ':' + s.ln + ' 你写的是「' + s.quote + '」，该行实际是「' + s.real + '」—— 证据要逐字抄原文',
    });
  }
  if (judged >= 4 && zero / judged >= 0.5) {
    const sample = details.find((d) => d.overlap === 0);
    return Object.assign({}, base, {
      verdict: PRE.revise,
      reason: '机械闸门：引用了 ' + judged + ' 处「文件:行」，其中 ' + zero + ' 处那一行里找不到你写的任何标识符（例如 ' + sample.rel + ':' + sample.ln + ' 实际是「' + sample.line + '」）—— 证据对不上原文，重做时去读真文件',
    });
  }
  return Object.assign({}, base, { verdict: PRE.defer });
}
