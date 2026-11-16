// @orch/accept —— AI 交活的验收闸门（零依赖）
//
// 为什么要有这个东西：
// 2026-11-15 这一天里，同一个故障出现了四次，四次都不是「AI 不会写代码」，
// 而是「AI 说它写完了，其实没写完」：
//   1. 任务要 9 章 markdown，交上来 178 行 JS —— 状态是 done
//   2. 注释开头的两个星号被渲染层当成加粗吃掉，文件语法直接坏掉
//   3. 问 A 题，答的是上一轮 B 题的答案（虚拟列表串台）
//   4. 存盘的是对的，通道却说「没拿到回答」，于是判成失败
// 四次全都通过了「看起来没问题」这一层。
//
// 所以验收不能靠看，得靠程序判定。分五层，任一不过就是没过：
//   shape    存在 / 非空 / 没有占位符（TODO、your-code-here、省略号）
//   syntax   语言层能过：node --check，或 JSON.parse
//   contract 接口签名对得上消费者（可选）
//   custom   任务里点名要求的行数区间 / 导出名 / 章节数（可选）
//   behavior 真跑一遍行为用例（可选，2026-11-16 加）
//
// 第五层的由来：前三层全只看「长得对不对」，判不了「算得对不对」。
// 真事 —— 一份 179 行、语法正确、导出齐全的 humanVerdict，
// 收到 17 个问题，输出「共列出 0 个问题」。三层一个都没拦住。
//
// 四层之上还有一层：异源评审（reviewer）。静态检查判得了形状，判不了意图 ——
// 「这个函数叫 classify，参数是 score，签名全对」但它把 null 当成及格，只有
// 另一个模型读得出来。评审器是可插拔的：不给就跳过，给了就必须给结论。
//
// 三件刻意不做的事：
//   1. 默认不 import 被测文件。import 会执行顶层代码（联网、写盘、开端口），
//      验收入口不该有副作用。唯一的例外是显式给了 --behave —— 那时执行发生在
//      独立的子进程里（bin/behavior-runner.mjs），崩了挂住都影响不到验收本身。
//   2. 不把「解析不到裁决」当成通过。没结论就是没通过。
//   3. 不猜。看不出是哪种文件就报 unknown，不硬套检查。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 还没写完的痕迹。命中即判失败，不让半成品混过去。 */
const PLACEHOLDER = /(TODO:|FIXME:|your[-_]code[-_]here|待实现|此处省略|省略若干|example\.com\/your|<your |^\s*\.\.\.\s*$)/im;

/** 能跑 node --check 的扩展名 */
const JS_EXT = new Set(['.mjs', '.cjs', '.js']);
/** 纯文本类，靠章节数/行数验 */
const DOC_EXT = new Set(['.md', '.markdown', '.txt']);

/**
 * 从一段任务描述里解析行数要求，如「120-180 行」。
 * @returns {{min:number,max:number}|null}
 */
export function parseLineRange(text) {
  const m = String(text || '').match(/(\d{2,5})\s*[-–~到—]\s*(\d{2,5})\s*行/);
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/** 从任务描述里解析「导出 X、Y 两个函数」这类点名要求的名字 */
export function parseRequiredExports(text) {
  const names = new Set();
  const s = String(text || '');
  const re = /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(s))) names.add(m[1]);
  const re2 = /导出\s*(?:一个|两个|三个|\d+\s*个)?\s*函数\s*[:：]?\s*([A-Za-z_$][\w$]*(?:\s*[、,，/]\s*[A-Za-z_$][\w$]*)*)/g;
  while ((m = re2.exec(s))) {
    for (const n of m[1].split(/[、,，/\s]+/)) if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
  }
  return [...names];
}

/** 从源码里静态扒出导出名（不执行） */
export function parseExports(src) {
  const out = new Set();
  const s = String(src || '');
  const pats = [
    /export\s+async\s+function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const re of pats) { let m; while ((m = re.exec(s))) out.add(m[1]); }
  return [...out];
}

/** 从源码里静态扒出导出函数的参数名（不执行） */
export function parseSignatures(src) {
  const out = new Map();
  const s = String(src || '');
  const re = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(s))) {
    const params = splitParams(m[2]);
    out.set(m[1], params);
  }
  // 2026-11-16 修的洞（附复现）：原来只认 function 声明，
  //   checkContract('export const loadTasks = (path) => []', {params:['filePath']}) 返回 ok:true，
  //   只加一句「签名未校验」的 note 就放行——而箭头函数写错参数名正是最常见的接不上原因。
  const reArrow = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/g;
  while ((m = reArrow.exec(s))) {
    if (out.has(m[1])) continue;
    out.set(m[1], splitParams(m[2] != null ? m[2] : m[3]));
  }
  return out;
}

/** 切参数串，尊重嵌套括号与字符串 */
function splitParams(str) {
  const parts = [];
  let depth = 0; let cur = ''; let quote = null;
  for (const ch of String(str || '')) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) { depth++; cur += ch; continue; }
    if (')]}'.includes(ch)) { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const t = p.trim();
    if (!t) return '';
    const beforeEq = t.split('=')[0].trim();
    if (beforeEq.startsWith('{') || beforeEq.startsWith('[')) return beforeEq; // 解构整体算一个
    return beforeEq.replace(/\.\.\..*/, '').trim();
  }).filter(Boolean);
}

/** 校验契书本身写得对不对 —— 坏契约要比坏产物先报出来，否则人看错方向 */
export function validateSpec(spec) {
  const notes = [];
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, notes: ['契约必须是对象，形如 {"exports":[{"name":"f","params":["a"]}]}'] };
  }
  const ex = spec.exports;
  if (!Array.isArray(ex)) return { ok: false, notes: ['契约缺 exports 数组'] };
  if (!ex.length) return { ok: false, notes: ['契约的 exports 是空的，没有任何东西可验'] };
  ex.forEach((e, i) => {
    if (e == null || typeof e !== 'object') { notes.push('exports[' + i + '] 不是对象'); return; }
    if (typeof e.name !== 'string' || !e.name.trim()) notes.push('exports[' + i + '].name 必须是非空字符串');
    if (e.params != null && !Array.isArray(e.params)) notes.push('exports[' + i + '].params 必须是数组');
  });
  return { ok: notes.length === 0, notes };
}

/** 比对源码签名与契约 */
export function checkContract(src, spec, label = '产物') {
  const res = { ok: true, notes: [] };
  const vs = validateSpec(spec);
  if (!vs.ok) { res.ok = false; res.notes.push(...vs.notes); return res; }
  const sigs = parseSignatures(src);
  const have = new Set(parseExports(src));
  for (const want of spec.exports) {
    const name = String(want.name || '').trim();
    if (!name) continue;
    if (!have.has(name)) { res.ok = false; res.notes.push(label + ' 缺导出 ' + name); continue; }
    if (!want.params) { res.notes.push(name + ' 只给了名字、没给 params，签名未校验'); continue; }
    const actual = sigs.get(name);
    if (!actual) { res.notes.push(name + ' 是箭头函数或非函数导出，签名未校验'); continue; }
    const exp = want.params.map(String);
    if (exp.length !== actual.length) {
      res.ok = false;
      res.notes.push(name + ' 参数个数不符：要 [' + exp.join(', ') + '] 实为 [' + actual.join(', ') + ']');
      continue;
    }
    for (let i = 0; i < exp.length; i++) {
      if (exp[i] !== actual[i]) {
        res.ok = false;
        res.notes.push(name + ' 参数名不符：第 ' + (i + 1) + ' 个要 ' + exp[i] + ' 实为 ' + actual[i]);
        break;
      }
    }
  }
  return res;
}

/** 语法检查：.js/.mjs/.cjs 跑 node --check，.json 跑 JSON.parse */
function checkSyntax(file, content) {
  const ext = path.extname(file).toLowerCase();
  if (JS_EXT.has(ext)) {
    const tmp = path.join(os.tmpdir(), 'accept-' + process.pid + '-' + Date.now() + (ext === '.cjs' ? '.cjs' : ext));
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 30000 });
      if (r.status === 0) return { ok: true, notes: [] };
      const msg = String(r.stderr || r.stdout || '').split('\n').filter((l) => l.trim()).slice(0, 3).join(' | ');
      return { ok: false, notes: ['语法错误：' + (msg || 'node --check 非零退出')] };
    } finally { try { fs.unlinkSync(tmp); } catch { } }
  }
  if (ext === '.json') {
    try { JSON.parse(content); return { ok: true, notes: [] }; }
    catch (e) { return { ok: false, notes: ['JSON 解析失败：' + e.message] }; }
  }
  return { ok: true, notes: ['跳过语法检查（' + (ext || '无扩展名') + '）'] };
}

/**
 * 验收一个文件。
 * @param {string} file 绝对或相对路径
 * @param {object} opts
 *   spec        接口契约（可选）
 *   taskText    任务原文，用来解析行数/导出名要求（可选）
 *   lines       {min,max} 覆盖 taskText 解析结果
 *   exports     string[] 必须出现的导出名
 *   sections    要求的最低 ## 章节数（文档类）
 * @returns {object} 判定结果
 */
export function accept(file, opts = {}) {
  const abs = path.resolve(file);
  const r = { file: abs, bytes: 0, lines: 0, layers: {}, verdict: 'FAIL', reasons: [] };
  let content = '';
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) { r.reasons.push('不是普通文件'); r.layers.shape = { ok: false, notes: ['不是普通文件'] }; return finish(r); }
    content = fs.readFileSync(abs, 'utf8');
    r.bytes = st.size;
    r.lines = content.split('\n').length;
  } catch (e) {
    r.layers.shape = { ok: false, notes: ['读不到文件：' + e.code] };
    r.reasons.push('读不到文件');
    return finish(r);
  }

  // 1) shape
  // 文档类不查占位符：README 里举例 "TODO:" 是正常写法，不是半成品。
  // 这条规则是自验收抓出来的——第一版把自家 README 判成了未通过。
  const isDoc = DOC_EXT.has(path.extname(abs).toLowerCase());
  const shapeNotes = [];
  let shapeOk = true;
  if (!content.trim()) { shapeOk = false; shapeNotes.push('文件是空的'); }
  if (!isDoc) {
    const ph = content.match(PLACEHOLDER);
    if (ph) { shapeOk = false; shapeNotes.push('发现未完成标记：' + ph[0].trim()); }
  }
  r.layers.shape = { ok: shapeOk, notes: shapeNotes };

  // 2) syntax
  r.layers.syntax = checkSyntax(abs, content);

  // 3) contract
  if (opts.spec) r.layers.contract = checkContract(content, opts.spec, path.basename(abs));

  // 4) custom
  const cust = [];
  let custOk = true;
  const lr = opts.lines || parseLineRange(opts.taskText || '');
  if (lr) {
    if (r.lines < lr.min || r.lines > lr.max) {
      custOk = false;
      cust.push('行数越界：要求 ' + lr.min + '-' + lr.max + ' 行，实际 ' + r.lines + ' 行');
    }
  }
  const wantEx = opts.exports && opts.exports.length ? opts.exports : parseRequiredExports(opts.taskText || '');
  if (wantEx.length) {
    const have = new Set(parseExports(content));
    const miss = wantEx.filter((n) => !have.has(n));
    if (miss.length) { custOk = false; cust.push('缺导出：' + miss.join('、')); }
  }
  if (opts.sections) {
    const n = (content.match(/^##\s+/gm) || []).length;
    if (n < opts.sections) { custOk = false; cust.push('章节数不足：要求 ' + opts.sections + '，实际 ' + n); }
  }
  if (cust.length || Object.keys(r.layers).length > 2) r.layers.custom = { ok: custOk, notes: cust };

  // 5) behavior —— 唯一会真正执行被测文件的一层
  //
  // 前面四层都只看「长得对不对」，判不了「算得对不对」。
  // 2026-11-16 的真事：humanVerdict({consensus:'all-revise', issues:17})
  // 输出「共列出 0 个问题」—— 形状、语法、行数、导出名四层全过。
  // 只有真跑一遍才知道它数错了。
  //
  // 所以这一层打破本文件开头「不 import 被测文件」的约定，但只在
  // 显式给了 --behave 时才走：默认行为不变，想验行为就得自己点名。
  if (opts.behave) {
    r.layers.behavior = runBehavior(abs, opts.behave);
  }
  // 对拍：不需要人给期望值，只要两个实现（参考实现 / 改造前的自己 / 同规格的另一个 AI）在同一组用例上结论一致。
  // 它抓的是「同一件事被定义了两遍、两遍不一样」—— 今晚跨层契约 70/200 不一致就是这么出来的。
  if (opts.against && opts.behave) {
    r.layers.compare = runCompare(abs, opts.against, opts.behave);
  }

  for (const [k, v] of Object.entries(r.layers)) if (!v.ok) r.reasons.push(k + ': ' + v.notes.join('；'));
  return finish(r);
}

/** 在子进程里跑行为用例。用例文件格式与 divergence 的 cases 一致。 */
function runBehavior(modPath, casesPath) {
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'behavior-runner.mjs');
  const cp = spawnSync(process.execPath, [runner, path.resolve(modPath), path.resolve(casesPath)], {
    encoding: 'utf8', timeout: 20000,
  });
  if (cp.error) return { ok: false, notes: ['跑不起来：' + cp.error.message] };
  if (cp.status !== 0 && !cp.stdout) return { ok: false, notes: ['用例进程挂了：' + (cp.stderr || '').slice(0, 200)] };
  let j = null;
  try { j = JSON.parse(cp.stdout); } catch { return { ok: false, notes: ['用例进程没吐 JSON：' + String(cp.stdout || '').slice(0, 120)] }; }
  if (j.fatal) return { ok: false, notes: ['用例文件本身有问题：' + j.fatal] };
  const bad = j.results.filter((x) => !x.ok);
  const notes = bad.map((x) => x.name + ' → 实际 ' + x.got);
  return { ok: bad.length === 0, notes, total: j.results.length, passed: j.results.length - bad.length };
}

/** 对拍：两个实现喂同一组用例，只比结论一不一样，不需要人给期望值。
 *  与行为用例的分工：行为用例判「对不对」（要期望值），对拍判「一样不一样」（不要）。
 *  用得上的场合：跨层契约、重构前后、两个 AI 各写一份同一规格。 */
function runCompare(aPath, bPath, casesPath) {
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'compare-runner.mjs');
  const cp = spawnSync(process.execPath, [runner, path.resolve(aPath), path.resolve(bPath), path.resolve(casesPath)], {
    encoding: 'utf8', timeout: 20000,
  });
  if (cp.error) return { ok: false, notes: ['跑不起来：' + cp.error.message] };
  let j = null;
  try { j = JSON.parse(cp.stdout); } catch { return { ok: false, notes: ['对拍进程没吐 JSON：' + String(cp.stdout || '').slice(0, 120)] }; }
  if (j.fatal) return { ok: false, notes: ['对拍参数有问题：' + j.fatal] };
  const notes = j.diffs.slice(0, 8).map((d) => d.name + ' → 甲 ' + d.a + ' / 乙 ' + d.b);
  return { ok: j.diffs.length === 0, notes, total: j.total, passed: j.total - j.diffs.length };
}

function finish(r) {
  r.verdict = r.reasons.length === 0 ? 'PASS' : 'FAIL';
  return r;
}

/** 把人话报告渲染成一段能直接读的文字 */
export function formatReport(r) {
  const L = [];
  const mark = (ok) => (ok ? '过' : '不过');
  L.push('产物  ' + r.file);
  L.push('尺寸  ' + r.bytes + ' B · ' + r.lines + ' 行');
  const nameOf = { shape: '形状', syntax: '语法', contract: '契约', custom: '要求', behavior: '行为', compare: '对拍' };
  for (const [k, v] of Object.entries(r.layers)) {
    const tally = v.total ? '（' + v.passed + '/' + v.total + ' 通过）' : '';
    L.push((nameOf[k] || k).padEnd(4, ' ') + '  ' + mark(v.ok) + tally + (v.notes.length ? '  ' + v.notes.join('；') : ''));
  }
  L.push('判定  ' + (r.verdict === 'PASS' ? '通过' : '未通过'));
  return L.join('\n');
}

export default { accept, formatReport, validateSpec, checkContract, parseExports, parseSignatures, parseLineRange, parseRequiredExports };
