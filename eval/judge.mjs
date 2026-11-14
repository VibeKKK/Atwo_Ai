// 判据引擎 —— 只做「可自动判定」的检查，不猜语义好坏。
// 设计原则：
//   1. 每条检查都必须能给出「为什么没过」的具体证据（哪一行、缺什么、编译报什么）
//   2. 判不了的一律 skip，不算失败，也不偷偷算通过
//   3. 全部零 token：不调模型，只跑本地编译器与字符串/结构检查
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkSyntax } from '../lib/syntax.mjs';
import { config } from '../lib/config.mjs';

// 候选清单与 lib/syntax.mjs 共用同一份（lib/config.mjs），换机器不用改两处
const PY_CANDIDATES = [...config.pythonCandidates, 'python3', 'python'].filter(Boolean);

let PY = null;
function pythonBin() {
  if (PY) return PY;
  for (const c of PY_CANDIDATES) {
    try {
      execFileSync(c, ['-c', 'print(1)'], { stdio: 'pipe', timeout: 8000 });
      PY = c; return c;
    } catch { /* next */ }
  }
  return null;
}

function runPy(code, { timeout = 15000 } = {}) {
  const py = pythonBin();
  if (!py) return { ok: false, reason: 'no-python' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-eval-'));
  const f = path.join(dir, 'candidate.py');
  try {
    fs.writeFileSync(f, code, 'utf8');
    const out = execFileSync(py, [f], { stdio: 'pipe', timeout, encoding: 'utf8' });
    return { ok: true, stdout: String(out) };
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message || '').split('\n').filter(Boolean).slice(-4).join(' / ');
    return { ok: false, reason: 'runtime-error', detail: msg };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
}

/** 从回答里把代码取出来：优先 ``` 围栏，其次整段（用于无围栏但像代码的回答） */
export function takeCode(text) {
  const s = String(text || '');
  const m = s.match(/```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)```/);
  if (m) return m[1];
  // 没有围栏时的兜底（2026-11-13 实测遇到）：Trae 会把「代码 + 中文说明」混在一段里，
  // 直接把整段当代码会 IndentationError。这里按「空行 + 以中文开头的非注释行」切掉尾部散文。
  const lines = s.split(/\r?\n/);
  const isProse = (ln) => {
    const t = ln.trim();
    if (!t) return false;
    if (/^[#/]/.test(t)) return false;          // 注释不算散文
    return /[\u4e00-\u9fff]/.test(t) && !/["'][^"']*[\u4e00-\u9fff]/.test(t); // 含中文且不在字符串里
  };
  let cut = lines.length;
  for (let i = 1; i < lines.length; i++) {
    if (isProse(lines[i]) && (lines[i - 1].trim() === '' || isProse(lines[i - 1]))) { cut = i; break; }
  }
  return lines.slice(0, cut).join('\n').replace(/\s+$/, '');
}

/** 结构化输出：能不能 parse 成对象，必要字段在不在 */
function checkShape(text, want = {}) {
  const t = String(text || '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, why: '回答里没有 JSON 对象' };
  let obj;
  try { obj = JSON.parse(m[0]); } catch (e) { return { ok: false, why: 'JSON 解析失败：' + e.message.slice(0, 120) }; }
  const missing = (want.keys || []).filter(k => !(k in obj));
  if (missing.length) return { ok: false, why: '缺字段：' + missing.join(',') };
  return { ok: true, obj };
}

/**
 * 判一条回答。
 * @param {object} task  eval/tasks.json 里的一项
 * @param {string} text  agent 的回答
 * @returns {{pass:boolean, checks:Array<{name:string,ok:boolean|'skip',detail:string}>}}
 */
export function judge(task, text) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const raw = String(text || '');
  const body = takeCode(raw);

  if (!raw.trim()) {
    add('非空', false, '回答是空的');
    return { pass: false, checks };
  }
  add('非空', true, `${raw.length} 字符`);

  // 1. 结构/编译
  if (task.kind === 'code' && task.compile !== false) {
    const lang = task.lang || 'python';
    const r = checkSyntax(body, lang);
    if (r.lang === 'skip') add('编译', 'skip', '该语言没有本地编译器，跳过');
    else add('编译', !!r.ok, r.ok ? `${r.lang} 通过` : String(r.error || '').split('\n')[0].slice(0, 160));
  }
  if (task.kind === 'json' || task.shape) {
    const s = checkShape(raw, task.shape || {});
    add('结构', s.ok, s.ok ? 'JSON 可解析且字段齐' : s.why);
  }

  // 2. 必含 / 禁含（正则，大小写敏感）
  for (const [i, re] of (task.include || []).entries()) {
    const ok = new RegExp(re, 'm').test(raw);
    add(`必含#${i + 1}`, ok, ok ? re : `没匹配到 /${re}/`);
  }
  for (const [i, re] of (task.forbid || []).entries()) {
    const hit = new RegExp(re, 'm').test(raw);
    add(`禁含#${i + 1}`, !hit, hit ? `出现了禁止内容 /${re}/` : re);
  }

  // 3. 长度（散文任务的主要判据：太短就是没干）
  if (task.minChars) {
    const ok = raw.length >= task.minChars;
    add('长度', ok, `${raw.length}/${task.minChars}`);
  }

  // 4. 行为测试（python 专用）：把候选代码 + 测试片段拼起来真跑
  if (task.kind === 'code' && (task.lang || 'python') === 'python' && task.unit) {
    const r = runPy(body + '\n\n' + task.unit);
    if (r.reason === 'no-python') add('行为', 'skip', '本机找不到可用 python');
    else add('行为', r.ok, r.ok ? (r.stdout || '').trim().slice(0, 80) : `运行失败：${r.detail}`);
  }

  const pass = checks.every(c => c.ok !== false);
  return { pass, checks };
}

/** 人读的一行摘要 */
export function line(taskId, res) {
  const bad = res.checks.filter(c => c.ok === false);
  const skip = res.checks.filter(c => c.ok === 'skip').length;
  const head = res.pass ? 'PASS' : 'FAIL';
  const detail = bad.length ? bad.map(b => `${b.name}(${b.detail})`).join(' ') : (skip ? `skip ${skip}` : '');
  return `${head}  ${taskId}${detail ? '  ' + detail : ''}`;
}
