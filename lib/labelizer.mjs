// atwo labelizer —— 用「可核事实」给盲测产物打标签，不再靠人手贴 good/bad。
//
// 为什么必须换掉人工标签：2026-11-17 第一跑得出「误杀 86%」，人工复核发现至少 2 份标 good 的产物
// 引用的行根本对不上（仓库当晚被我自己挪了行号）—— 那不是父审误杀，是我的标签跟着仓库漂了。
//
// 三条硬事实（都能对字节复算，不看作者是谁、也不看父审怎么想）：
//   F1「文件:行」存不存在、行号越不越界 —— 路径先按直连解析，再按 basename 唯一命中（产物常写不带目录）
//   F2 引文（「」/双引号/反引号括起来的）开头 8 字是否真出现 —— 当前对不上时翻 git 历史，产物写于旧版本不算假
//   F3 EVIDENCE 是否为空
// 标签口径（写死）：
//   bad     任一硬事实不过，且连历史里都找不到（= 当时也不成立）
//   stale   「当时可核、现在对不上」—— 单独一类，不许混进 bad（那会把仓库漂移算成产物的错）
//   good    全部引用可核（当前或历史）
//   unknown 一处「文件:行」都没有，无法核
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LABEL_CONTRACT = 'atwo-label/2';
const BT = String.fromCharCode(96);
const EXT = 'mjs|js|cjs|ts|tsx|jsx|json|md|py|go|rb|java|sh|sql|yml|yaml|txt|vue|html|css';
// 两种写法都认：`lib/x.mjs:83` 与 `lib/x.mjs 第 83 行`（后者是中文回答的常态，不认就会误判 unknown）
const REF_EXT = '(?:[A-Za-z0-9_.\\-]+/)*[A-Za-z0-9_.\\-]+\\.(?:' + EXT + ')';
const REF_RE = new RegExp('(' + REF_EXT + '):(\\d+)|(' + REF_EXT + ')' + BT + '?\\s*[,，]?\\s*第\\s*(\\d+)\\s*(?:[-–~～]\\s*(\\d+)\\s*)?行', 'g');
const QUOTE_SRC = '[\u300c\u201c"]([^\u300d\u201d"]{4,200})[\u300d\u201d"]|' + BT + '([^' + BT + ']{4,200})' + BT;
const QUOTE_RE = new RegExp(QUOTE_SRC, 'g');
const STRIP_RE = new RegExp('[' + '\\u300c\\u300d\\u201c\\u201d' + '"' + "'" + BT + ']', 'g');
const TRIM_RE = /\s+/g;
// 判断引文是不是「代码片段」：中文回答里 `xx.mjs:12` 后面跟的常是作者自己的描述，不是原文抄写。
// 只有 ASCII 为主且含代码符号的才算逐字引文，否则跳过 F2（只核行存在性）。
/** 引文里最长的 ASCII 标识符（>=4 字符、不是纯数字）当核对指纹；纯中文描述返回 ''。 */
export function codeToken(q) {
  const s = String(q || '');
  // 关键字与泛用词当不了指纹：`const b = 2;` 里的 const 到处都有，拿它核对等于不核对。
  const KW = /^(?:const|return|export|function|import|let|var|if|else|true|false|null|undefined|await|async|typeof|new|class|this|file|code|test|line|note|readonly|string|number|value|values|object|array|error)$/i;
  // 纯散文（没有任何代码标点）不当引文：'measure to artifacts' 里的 artifacts 是词，不是指纹。
  if (!/[=(){}\[\];:.\/]/.test(s)) return '';
  // 带点的标识符（opts.lanes / a.b）本身就是指纹 —— 2026-11-17 实测：要求「含代码标点」会让
  // 「opts.lanes」这类引用直接跳过逐字核对，于是内容对不上的产物被判 exact（good-c/good-e 就是这么错的）。
  const hits = (s.match(/[A-Za-z_][A-Za-z0-9_.]{2,}/g) || [])
    .filter((x) => !KW.test(x))
    .filter((x) => (x.includes('.') && x.length >= 5) || x.length >= 7);
  if (!hits.length) return '';
  return hits.sort((a, b) => b.length - a.length)[0];
}

/** 这条引文能不能拿来核对：拿不到指纹就是「纯中文描述」，只能核行是否存在。 */
export const verifiable = (q) => !!codeToken(q);

export const codeLike = (q) => { const s = String(q || ''); if (s.length < 4) return false; const ascii = (s.match(/[\x20-\x7e]/g) || []).length; return ascii / s.length > 0.5 && /[A-Za-z0-9_]/ .test(s) && /[=(){}\[\];:.\/]/.test(s); };

/** 去空白与各类引号，只留下「能被字节比对的字」。 */
export const norm = (s) => String(s).replace(TRIM_RE, '').replace(STRIP_RE, '');
export const head8 = (q) => norm(q).slice(0, 8);

/**
 * 从 ANSWER 正文抽出所有「文件:行号」声称。认 `lib/x.mjs:123`、`lib/x.mjs:123-130`（只取起始行，
 * 区间是否覆盖由 EVIDENCE 的 ln..endLn 核）、`lib/x.mjs:123,456`（每个行号各算一条声称）。
 * 纯函数：不读文件、不碰环境。
 * @param {string} answer
 * @returns {{file: string, line: number, raw: string}[]}
 */
export function claimsOf(answer) {
  const text = String(answer || '');
  const re = new RegExp(REF_RE.source, 'g');
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const file = (m[1] || m[3]).replace(/^\.\//, '');
    const add = (ln, r) => {
      const k = file + ':' + ln;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ file, line: ln, raw: r });
    };
    add(Number(m[2] || m[4]), raw);
    // 逗号连写的行号（:123,456）—— 冒号形式只吃到第一个数，后面每段都要单独算声称
    const list = /^\s*[,，]\s*(\d{1,6}(?:\s*[,，]\s*\d{1,6})*)/.exec(text.slice(m.index + raw.length));
    if (list) for (const n of list[1].split(/\s*[,，]\s*/)) add(Number(n), (raw + list[0]).trim());
  }
  return out;
}

/**
 * 从 ANSWER 正文抽出「共 N 处 / N 个文件 / N 份」这类计数声称。
 * 纯函数：不读文件、不碰环境。
 * @param {string} answer
 * @returns {{n: number, subject: string, raw: string}[]}
 */
export function countClaimsOf(answer) {
  const text = String(answer || '');
  const re = /(?:共|总共|合计|一共)\s*(\d{1,5})\s*(个文件|处|份)|(?<![第\d])(\d{1,5})\s*(个文件|处|份)/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    out.push({ n: Number(m[1] || m[3]), subject: m[2] || m[4], raw: m[0] });
  }
  return out;
}

const idxCache = new Map();

/** 仓库内按 basename 建索引：产物常写 army-run.mjs:78 而不带目录，这是人能读的写法，不是错。 */
export function basenameIndex(cwd) {
  if (idxCache.has(cwd)) return idxCache.get(cwd);
  const idx = new Map();
  const skip = new Set(['.git', 'node_modules', '.atw', 'dist', 'coverage']);
  const stack = [cwd];
  let n = 0;
  while (stack.length && n < 4000) {
    const d = stack.pop();
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of names) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      n++;
      const arr = idx.get(e.name) || [];
      arr.push(path.relative(cwd, p).split(path.sep).join('/'));
      idx.set(e.name, arr);
    }
  }
  idxCache.set(cwd, idx);
  return idx;
}

/** 一条引用可能对应哪些真实文件：直连优先，其次 basename（唯一命中就认，多命中按尾部匹配）。 */
// readBase：有快照时按快照读（产物生成那一刻的行号），没有才看当前仓库。
// 2026-11-19 实测：11-17 的 12 份产物全被判 shifted，不是因为造假，是行号随提交漂了；
// 快照机制建了但核引用还在看当前仓库，等于白建。
export function candidates(cwd, rel, readBase) {
  const rb = readBase || cwd;
  const out = [];
  if (fs.existsSync(path.resolve(rb, rel))) out.push(rel);
  const base = path.basename(rel);
  const hits = basenameIndex(cwd).get(base) || [];
  if (hits.length === 1) out.push(hits[0]);
  else if (hits.length > 1) {
    const tail = rel.replace(/^\.\//, '');
    const best = hits.filter((h) => h === tail || h.endsWith('/' + tail));
    out.push(...(best.length ? best : hits));
  }
  return [...new Set(out)];
}

function lineAt(cwd, rel, ln) {
  let text;
  try { text = fs.readFileSync(path.resolve(cwd, rel), 'utf8'); } catch { return { ok: false, why: 'file-missing' }; }
  const lines = text.split(/\r?\n/);
  if (ln < 1 || ln > lines.length) return { ok: false, why: 'line-out-of-range', total: lines.length };
  return { ok: true, line: lines[ln - 1], total: lines.length };
}

/** 当前对不上时，翻 git 历史看「当时是否可核」。只翻最近 30 个动过该文件的提交。 */
export function historyHit(cwd, rel, quote, maxCommits = 30) {
  const head = quote ? head8(quote) : '';
  for (const p of candidates(cwd, rel).concat([rel])) {
    const log = spawnSync('git', ['log', '--format=%H', '-n', String(maxCommits), '--', p], { cwd, encoding: 'utf8', timeout: 20000, windowsHide: true });
    const revs = String(log.stdout || '').split(/\r?\n/).filter(Boolean);
    for (const rev of revs) {
      const show = spawnSync('git', ['show', rev + ':' + p], { cwd, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      if (show.status !== 0) continue;
      if (!head || norm(show.stdout).indexOf(head) >= 0) return { rev, path: p };
    }
  }
  return null;
}

/** ANSWER 声称的 (file,line) 是否被 EVIDENCE 的引用覆盖：同一文件，且行号落在引用行或区间内。 */
function coveredByEvidence(claim, refs) {
  const full = String(claim.file || '').replace(/^\.\//, '');
  const base = path.basename(full);
  return refs.some((r) => {
    const cand = [String(r.rel || '').replace(/^\.\//, ''), String(r.resolved || '').replace(/^\.\//, '')].filter(Boolean);
    const same = full.includes('/')
      ? cand.some((x) => x === full || x.endsWith('/' + full))
      : cand.some((x) => path.basename(x) === base);
    return same && claim.line >= r.ln && claim.line <= (r.endLn || r.ln);
  });
}

/** 对一份产物做客观事实核对。cwd 用产物自己的快照目录（有就优先，没有就用当前仓库 + git 历史兜底）。 */
export function objectiveFacts(child, { cwd, snapBase } = {}) {
  const base = cwd || process.cwd();
  // 核行号一律走 readBase：产物是那一刻生成的，行号只对那一刻成立。
  const readBase = snapBase || base;
  const evidence = String((child && child.evidence) || '');
  const refs = [];
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(evidence))) {
    const raw = m[0];
    const rel = (m[1] || m[3]).replace(/^\.\//, '');
    const ln = Number(m[2] || m[4]);
    // 引用可能是行区间：lib/sandbox.mjs:19-27 或「第 19–27 行」。
    // 2026-11-17 实测 bad-20 被判 bad 就是因为它写 :1-116（通读全文件），被当成「第 1 行」而第 1 行是注释。
    const after = evidence.slice(m.index + raw.length);
    const rangeM = new RegExp('^\s*[\u2013~～-]\s*(\\d{1,6})').exec(after);
    const endLn = Number(m[5] || (rangeM ? rangeM[1] : 0)) || ln;
    const tail = evidence.slice(m.index + raw.length, m.index + raw.length + 240);
    QUOTE_RE.lastIndex = 0;
    const qm = QUOTE_RE.exec(tail);
    const quote = qm ? (qm[1] || qm[2] || '') : '';
    // 引文可能夹中文括注（「（MIN_UNITS_TO_SPLIT=4、MI…」）——所以不比前 8 字，
    // 只取引文里最长的 ASCII 标识符当「指纹」去核；取不到（纯散文）就不做逐字核对。
    const tok = codeToken(quote);
    const nq = norm(quote);
    // 两种核对都算「对得上」：整段引文是原文子串（最强），或引文里最能定性的那个标识符出现在行里
    // （引文被中文括注截断时用后者）。两者都拿不到 → 这条算 weak，只能核行是否存在。
    // 「引文」本身可能就是行号区间（:61-67）或文件名（army-run.mjs:78）——那不是可核对的原文，
    // 不许因为「对不上」就判产物造假（2026-11-17 实测把 good-a/good-d 错判成 bad 的就是这种）。
    // 只有「像代码的引文」才能逐字核对：中文复述里夹一个 s 或 67.4 不算抄写，拿它判对不上
    // 等于把「作者自己的话」当成「伪造的原文」（2026-11-17 实测 good-d 62 处引用里有十几处是这种）。
    // 命令行开关（--review-model）与文件路径本身就是可核对的原文，别当散文丢掉。
    const flagOrPath = /^--?[A-Za-z][\w-]*$/.test(nq) || /^[\w./-]+\.(?:mjs|js|cjs|json|md|py|yml|sh)$/.test(nq);
    const quoteVerifiable = nq.length >= 4 && (codeLike(quote) || flagOrPath) && !/^:?\d+(?:-\d+)?$/.test(nq);
    // 引文里带占位符（<路径>、…、{mjs,js,cjs}）时，「整段逐字出现」永远不成立：
    // 2026-11-17 实测 bad-20 的 `node --check <路径>.{mjs,js,cjs}` 因此被判 shifted，
    // 再被 git grep 到别处的 node 关键词，最后整份标成 bad —— 那不是产物造假，是标签算错。
    // 所以带占位符的引文只允许用指纹核，抽不出指纹就记 weak（看不出，不是假的）。
    const placeholder = /<\s*[\u4e00-\u9fa5A-Za-z_][^<>]{0,20}\s*>|…/.test(quote);
    const strict = (quoteVerifiable && !placeholder) || !!tok;
    const hitIn = (line) => {
      const nl = norm(line);
      if (quoteVerifiable && nl.includes(nq)) return true;
      return !!tok && nl.includes(tok);
    };
    let hit = null;
    let state = 'ok';
    const spanOf = (file) => {
      let t = '';
      try { t = fs.readFileSync(path.resolve(readBase, file), 'utf8'); } catch { return ''; }
      const lines = t.split(/\r?\n/);
      return lines.slice(ln - 1, Math.max(ln, Math.min(lines.length, endLn))).join('\n');
    };
    const cands = candidates(base, rel, readBase);
    for (const c of cands) {
      const r = lineAt(readBase, c, ln);
      if (!r.ok) { if (c === cands[0]) state = 'line-missing'; continue; }
      const span = endLn > ln ? spanOf(c) : '';
      if (!strict || hitIn(r.line) || (span && hitIn(span))) { hit = { path: c, line: r.line }; state = 'ok'; break; }
      // 行号差几行是常见的手写误差：±3 行内找到就记 shifted，不算造假
      let near = null;
      for (let d = 1; d <= 3 && !near; d++) {
        for (const k of [ln - d, ln + d]) {
          const t = lineAt(readBase, c, k);
          if (t.ok && hitIn(t.line)) { near = { path: c, line: t.line, at: k }; break; }
        }
      }
      if (near) { hit = near; state = 'shifted'; break; }
      // 全文件搜索：内容在、行号错得更远
      let whole = null;
      try { whole = fs.readFileSync(path.resolve(readBase, c), 'utf8'); } catch { whole = null; }
      if (whole && (strict ? ((quoteVerifiable && norm(whole).includes(nq)) || (tok && norm(whole).includes(tok))) : false)) { hit = { path: c, line: '' }; state = 'shifted'; break; }
      if (state === 'ok') state = 'mismatch';
    }
    let hist = null;
    let contentIn = null;
    if (!hit) {
      // 引文内容在仓库别处存在 → 行号/归属写错，不是捏造（记 shifted）。
      // 2026-11-17 修：原先只在引文含 _ 或 ( 时才查，'MULT[key]' 这种整段引文被跳过 → 被误记成 bad。
      const gtok = tok || (String(quote).match(/[A-Za-z_][A-Za-z0-9_.]{3,}/g) || [])[0] || '';
      if (strict && gtok) {
        const g = spawnSync('git', ['grep', '-F', '-l', '-I', '--', gtok], { cwd: base, encoding: 'utf8', timeout: 30000, windowsHide: true });
        const first = String(g.stdout || '').split(/\r?\n/).filter(Boolean)[0];
        if (first) { state = 'shifted'; contentIn = first; }
      }
      if (!contentIn && strict && gtok) {
        hist = historyHit(base, rel, gtok);
        state = hist ? 'stale' : 'bad';
        if (state === 'stale' && hist) contentIn = hist.path;
      } else if (!contentIn && strict && !gtok) {
        // 没有可检索的标识符（引文里只有中文和数字）→ 既不能证明可核，也不能说造假
        state = 'weak';
      }
    }
    // 不可核（weak）不许当 bad：那是「看不出」，不是「假的」
    if (!strict) state = 'weak';
    const row = { rel, ln, endLn, state, weak: !strict, strict, resolved: hit ? hit.path : (contentIn || null), rev: hist ? hist.rev : null, contentIn, quote: quote.slice(0, 60), line: hit ? String(hit.line).slice(0, 160) : null };
    // 标签算错的排查入口：ATWO_LABEL_DEBUG=1 会把每条引用怎么判的打到 stderr。
    // 2026-11-17 实测：没有它就只能猜「这一份为什么是 bad」，而五档里 bad 与 shifted 只差一行代码。
    if (process.env.ATWO_LABEL_DEBUG) process.stderr.write('[label] ' + JSON.stringify(row) + String.fromCharCode(10));
    refs.push(row);
  }
  const bad = refs.filter((r) => r.state === 'bad' || (r.state === 'mismatch' && !r.weak));
  const stale = refs.filter((r) => r.state === 'stale');
  const shifted = refs.filter((r) => r.state === 'shifted');
  // 「(空)」是产物自己写的占位（上游通道失败时），按空证据算，不是「没有引用」
  const emptyEvidence = evidence.trim().length === 0 || /^\(\s*(?:空|empty)\s*\)/.test(evidence.trim());
  const weak = refs.filter((r) => r.weak);
  const verifiableN = Math.max(0, refs.length - weak.length);
  const facts = { contract: LABEL_CONTRACT, refs: refs.length, verifiable: verifiableN, weak: weak.length, bad: bad.length, stale: stale.length, shifted: shifted.length, emptyEvidence };
  let label = 'unknown';
  const why = [];
  const names = (arr) => arr.slice(0, 3).map((x) => x.rel + ':' + x.ln).join(' ');
  // 五档，不再把「行号写错」混进 good：父审抓的就是这个（2026-11-17 实测 5 份被我们标 good 的
  // 产物，逐条复核都确有问题）。exact 才算「这份证据真的逐字对得上」。
  if (emptyEvidence) { label = 'empty'; why.push('EVIDENCE 为空'); }
  else if (bad.length) { label = 'bad'; why.push('引用连历史里都找不到（编造或引错文件）：' + names(bad)); }
  else if (stale.length) { label = 'sloppy'; why.push('引文对不上当前仓库（旧版本可核或行号漂）：' + names(stale)); }
  else if (shifted.length) { label = 'sloppy'; why.push('引文在文件里但不在所写的行上（' + shifted.length + '/' + refs.length + ' 处）：' + names(shifted)); }
  else if (refs.length && verifiableN) {
    // exact 只核了 EVIDENCE 自己的引用；ANSWER 正文里另写的行号和计数同样是断言，核不过就不许 exact。
    const answer = String((child && child.answer) || '');
    const missing = [...new Set(claimsOf(answer).filter((c) => !coveredByEvidence(c, refs)).map((c) => c.file + ':' + c.line))];
    const fileN = new Set(refs.map((r) => r.rel)).size;
    const offCount = countClaimsOf(answer)
      .map((c) => ({ ...c, actual: c.subject === '处' ? refs.length : fileN }))
      .filter((c) => c.n !== c.actual);
    if (missing.length || offCount.length) {
      label = 'sloppy';
      if (missing.length) why.push('ANSWER 声称了未在 EVIDENCE 引用的 ' + missing.slice(0, 3).join(' '));
      if (offCount.length) why.push('ANSWER 计数与 EVIDENCE 实际枚举数不符：' + offCount.slice(0, 3).map((c) => '声称共 ' + c.n + ' ' + c.subject + '，实际 ' + c.actual + ' ' + c.subject).join('；'));
    } else {
      label = 'exact'; why.push('引用逐行对得上（' + verifiableN + ' 处可核）');
    }
  }
  // 一条都没法核（引文全是纯中文描述）→ 不许算 exact，那只是「看不出错」
  else if (refs.length) { label = 'unknown'; why.push('有 ' + refs.length + ' 处「文件:行」，但引文全是叙述、取不出可核指纹，判不了'); }
  else { label = 'unknown'; why.push('一处「文件:行」都没有，无法核'); }
  return Object.assign({}, facts, { label, why: why.join('；'), detail: refs });
}

// 人工标签只有 good/bad 两种，客观标签有五种 —— 比对前归到同一大类，否则「good vs exact」会被算成不一致。
// 两处（labelCases 与 blind-objective）共用这两个函数：2026-11-17 实测有第二份裸比较导致对照组全报不一致。
export const labelClassOfHand = (h) => (h === 'good' ? 'exact' : (h === 'bad' ? 'defect' : null));
export const labelClassOfObjective = (o) => (o === 'exact' ? 'exact' : (o === 'unknown' ? null : (o === 'sloppy' || o === 'bad' || o === 'empty' ? 'defect' : null)));

/** 一批 case 打客观标签，并与人工标签比对（不一致的单独列出 —— 那是人工标签漂了的地方）。 */
export function labelCases(cases, { cwd, snapBase } = {}) {
  const rows = cases.map((c) => {
    const f = objectiveFacts({ evidence: c.evidence, answer: c.answer }, { cwd, snapBase });
    return { id: c.id, file: c.file || null, hand: c.label || null, objective: f.label, why: f.why, facts: { refs: f.refs, verifiable: f.verifiable, weak: f.weak, bad: f.bad, stale: f.stale, emptyEvidence: f.emptyEvidence } };
  });
  // 人工标签只有 good/bad 两种，客观标签有五种 —— 比对前先归到同一个大类，
  // 否则「good vs exact」会被算成不一致（那只是叫法不同）。
  const handClass = labelClassOfHand;
  const objClass = labelClassOfObjective;
  const disagree = rows.filter((r) => r.hand && handClass(r.hand) && objClass(r.objective) && handClass(r.hand) !== objClass(r.objective));
  const counts = { exact: 0, sloppy: 0, bad: 0, empty: 0, unknown: 0 };
  for (const r of rows) counts[r.objective]++;
  return { contract: LABEL_CONTRACT, rows, disagree, counts };
}