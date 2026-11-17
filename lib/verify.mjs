// 自动验收（阶段 1 · 第二件）：文件写完不等于交得了活。
//
// 为什么需要它：昨晚 6 个产出里，有一个是 codebuddy 把任务描述原样回显（526 字、
// 内容全是「导出 5 个函数：parseDeps(list)->...」这种规格复述），status 却是 done。
// 「agent 说完成」和「产出能用」之间差着一次真实检查。
//
// 检查分三层，任何一层不过都算没交：
//   1. 结构：文件存在、非空、没有占位符（TODO / your-code-here / 省略号占位）
//   2. 语法：.mjs/.cjs/.js 跑 node --check；.json 跑 JSON.parse
//   3. 约定：任务里点名要求的导出名 / 行数区间 / 章节数，是否真的出现
//
// 刻意不做的事：不 import 被测模块。import 会执行顶层代码（可能联网、写盘、开端口），
// 验收不该有副作用。要跑行为测试，应该由调用方显式传 mode: 'deep' 或 behave: '<用例文件>'。
//
// 第四层（2026-11-16 加）：行为用例。
// 上面三层全只看「长得对不对」，判不了「算得对不对」。真事：humanVerdict 收到 17 个问题
// 却输出「共列出 0 个问题」—— 结构、语法、行数、导出名四层全过。
// 所以加一层显式点名的行为验证：执行在子进程里（副作用隔离），只在给了 behave 时才跑。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkApiSpecSource, formatApiSpec } from './apispec.mjs';

/** 明显是「还没写完」的痕迹 */
const PLACEHOLDER = /(TODO:|FIXME:|your[-_]code[-_]here|待实现|此处省略|省略若干|example\.com\/your|<your |\.\.\.\s*$)/im;

/** 从任务文本里解析行数要求，如「120-180 行」「100–160 行区间内」 */
export function parseLineRange(text) {
  const m = String(text || '').match(/(\d{2,4})\s*[-–~]\s*(\d{2,4})\s*行/);
  if (!m) return null;
  const lo = Number(m[1]); const hi = Number(m[2]);
  return lo <= hi ? [lo, hi] : [hi, lo];
}

/** 从任务文本里解析点名要求的导出名：「导出 5 个函数：parseDeps(list)、topoSort(list)」 */
export function parseRequiredExports(text) {
  const t = String(text || '');
  const names = new Set();
  // 只在「导出/实现/提供」之后的 200 字以内找，避免把正文里所有标识符都当成要求。
  // 识别两种形态：「name(args)」和「甲 与 乙」。
  // 按行截断而不是按分号：任务规格里导出清单常用「；」分隔（parseDeps(...)；topoSort(...)），
  // 按分号切会把第 2 个之后的导出全漏掉（实测只抓到 1 个）。
  const segRe = /(?:导出|实现|提供)([^\n]{0,400})/g;
  let m;
  while ((m = segRe.exec(t))) {
    const seg = m[1];
    const callRe = /([a-zA-Z_$][\w$]{2,})\s*[（(]/g;
    let n2;
    while ((n2 = callRe.exec(seg))) names.add(n2[1]);
    const andRe = /与\s*([a-zA-Z_$][\w$]{2,})\b/g;
    while ((n2 = andRe.exec(seg))) names.add(n2[1]);
  }
  return [...names];
}

/** 语法检查：用系统 node 跑 --check（ESM 需要真实文件，所以写临时 .mjs） */
function syntaxCheck(content, ext) {
  const tmp = path.join(os.tmpdir(), 'orch-verify-' + process.pid + '-' + Date.now() + (ext || '.mjs'));
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0) return { ok: true, detail: '' };
    const msg = String(r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(0, 3).join(' / ');
    return { ok: false, detail: msg.replace(new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<tmp>') };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e).slice(0, 200) };
  } finally {
    try { fs.unlinkSync(tmp); } catch { }
  }
}

/**
 * 验收一份内容。
 * @returns {{ ok: boolean, checks: Array<{name:string, ok:boolean, detail:string}> }}
 */
export function verifyContent(target, content, taskText = '', opts = {}) {
  const checks = [];
  const body = String(content || '');
  const ext = path.extname(String(target || '')).toLowerCase();
  const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });

  // 1. 结构
  add('非空', body.trim().length > 0, body.trim().length ? body.trim().length + 'B' : '空内容');
  const ph = body.match(PLACEHOLDER);
  add('无占位符', !ph, ph ? '出现「' + String(ph[0]).slice(0, 40) + '」' : '');

  // 2. 语法
  if (ext === '.mjs' || ext === '.cjs' || ext === '.js') {
    const s = syntaxCheck(body, ext);
    add('node --check', s.ok, s.detail);
    const docish = /^#\s/m.test(body.slice(0, 200)) && !/export\s/.test(body);
    add('形态匹配 .mjs', !docish, docish ? '内容像 markdown（.mjs 应以代码开头）' : '');
  } else if (ext === '.json') {
    try { JSON.parse(body); add('JSON.parse', true); } catch (e) { add('JSON.parse', false, String((e && e.message) || e)); }
  } else if (ext === '.md') {
    const heads = (body.match(/^##\s+/gm) || []).length;
    add('markdown 章节', heads >= 2, heads + ' 个 ## ');
    // 内容形态与扩展名匹配。实测抓过一次：任务要「写 docs/EXTENDING.md 文档」，
    // codebuddy 交付的 code 字段是一份 .mjs 适配器骨架（以 // 自检 开头、零个 ##），
    // 落盘后扩展名 .md、内容却是 JS —— 只查章节数能发现，但这里补一条更直白的判据。
    const codeish = /^\s*(\/\/|\/\*|export\s|import\s|function\s)/m.test(body) && !/^#\s/m.test(body.slice(0, 300));
    add('形态匹配 .md', !codeish, codeish ? '内容像代码（markdown 应以 # 标题开头）' : '');
  } else {
    add('格式', true, '未定义检查项（' + ext + '）');
  }

  // 3. 约定：行数区间
  const range = parseLineRange(taskText);
  if (range) {
    const lines = body.split('\n').length;
    add('行数 ' + range[0] + '-' + range[1], lines >= range[0] && lines <= range[1], lines + ' 行');
  }

  // 3. 约定：要求的导出名真的写了
  const reqs = parseRequiredExports(taskText);
  const missing = reqs.filter((n) => !new RegExp('(export\\s+(async\\s+)?(function|const|let|class)\\s+' + n + '\\b)|(export\\s*\\{[^}]*\\b' + n + '\\b)').test(body));
  if (reqs.length) add('导出名 ' + reqs.length + ' 个', missing.length === 0, missing.length ? '缺：' + missing.join(', ') : '齐全');

  // 3. 约定：结构化接口契约（只验形状，不执行产物）
  // 上面那层「导出名」是从中文散文里正则抓的，只验「名字出现过」；参数个数、参数名一律没验。
  // 元凶场景：A 写 model.mjs 的 loadTasks(filePath)，B 写 bin.mjs 时按 loadTasks(path) 调 ——
  // 名字对、签名错，两边都能过 node --check，拼起来才炸。这一层专补这个缝。
  // spec 由调用方显式传（{ exports: [{ name, params: [...] }] }），不传就跳过，不猜。
  if (opts.spec) {
    const sr = checkApiSpecSource(body, opts.spec, target);
    add('接口契约', sr.ok, formatApiSpec(sr));
  }

  // 行为用例：跑一遍才算知道它对不对（子进程隔离，只在显式给 behave 时跑）
  if (opts.behave) {
    const br = runBehaviorCheck(target, opts.behave);
    add('行为用例', br.ok, br.detail);
  }

  // deep：实际 import（有副作用，默认关）
  if (opts.mode === 'deep' && (ext === '.mjs' || ext === '.cjs')) {
    const tmp = path.join(os.tmpdir(), 'orch-deep-' + Date.now() + '.mjs');
    try {
      fs.writeFileSync(tmp, body, 'utf8');
      const code = "import('file:///' + " + JSON.stringify(tmp.replace(/\\/g, '/')) + ").then(m=>{console.log(Object.keys(m).join(','))}).catch(e=>{console.error(String(e&&e.message||e));process.exit(1)})";
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 25000 });
      add('可加载', r.status === 0, r.status === 0 ? 'exports: ' + String(r.stdout || '').trim().slice(0, 200) : String(r.stderr || '').slice(0, 200));
    } finally { try { fs.unlinkSync(tmp); } catch { } }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * 在子进程里跑行为用例，判「算得对不对」。
 * 跑的是磁盘上那份真实文件（不是内存里的字符串），所以必须落盘在前、验收在后。
 */
function runBehaviorCheck(target, casesPath) {
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'accept', 'bin', 'behavior-runner.mjs');
  const abs = path.resolve(process.cwd(), String(target || ''));
  const cases = path.resolve(process.cwd(), String(casesPath || ''));
  if (!fs.existsSync(abs)) return { ok: false, detail: '产物不在磁盘上，行为用例跑不了' };
  if (!fs.existsSync(cases)) return { ok: false, detail: '用例文件不存在：' + casesPath };
  if (!fs.existsSync(runner)) return { ok: false, detail: '行为执行器丢了：' + runner };
  const cp = spawnSync(process.execPath, [runner, abs, cases], { encoding: 'utf8', timeout: 30000 });
  if (cp.error) return { ok: false, detail: '跑不起来：' + cp.error.message };
  let j = null;
  try { j = JSON.parse(cp.stdout || ''); } catch { return { ok: false, detail: '用例进程没吐 JSON：' + String(cp.stdout || cp.stderr || '').slice(0, 160) }; }
  if (j.fatal) return { ok: false, detail: '用例文件本身有问题：' + j.fatal };
  const bad = (j.results || []).filter((x) => !x.ok);
  const passed = (j.results || []).length - bad.length;
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? passed + '/' + j.results.length + ' 通过；' + bad.map((x) => x.name + ' → 实际 ' + x.got).join('；')
      : passed + '/' + j.results.length + ' 通过',
  };
}

/**
 * 回归对拍：落盘之后，把「新版本」和「改动前的旧版本」喂同一组用例，比结论是否一致。
 * 与 runBehaviorCheck 的分工：那个要人给期望值（判对错），这个只要旧版本（判有没有变）。
 * 用在「改一个已经通过验收的模块」这种活儿上 —— 这是 AI 最容易悄悄改坏别人行为的地方。
 */
// 回归对拍的落账规则。抽成纯函数的原因：原本是 runPool 里 15 行内联，
// 而「strictRegress 一票否决」这种开关最容易被后来的改动悄悄弄丢 ——
// 丢了之后的表现是「对拍报了变化，但验收照样通过、退出码照样 0」，看起来一切正常。
export function applyRegress(rec, creg, strictRegress) {
  const r = { ok: !!creg.ok, detail: creg.detail, against: creg.against };
  rec.regress = r;
  if (!rec.verify || !Array.isArray(rec.verify.checks)) return r;
  rec.verify.checks.push({ name: '回归对拍', ok: r.ok, detail: creg.detail });
  // 默认只报不判失败：改行为可能是本意（比如任务就是要求改输出格式）。
  // strict 才升级成一票否决 —— 用于「这次只该动 A，不该动 B」的回归批次。
  if (!r.ok && strictRegress) rec.verify.ok = false;
  return r;
}

export function runCompareCheck(newPath, oldPath, casesPath) {
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'accept', 'bin', 'compare-runner.mjs');
  const a = path.resolve(process.cwd(), String(newPath || ''));
  const b = path.resolve(process.cwd(), String(oldPath || ''));
  const cases = path.resolve(process.cwd(), String(casesPath || ''));
  if (!fs.existsSync(a)) return { ok: false, detail: '新版本不在磁盘上，对拍跑不了' };
  if (!fs.existsSync(b)) return { ok: false, detail: '旧版本备份不在，对拍跑不了' };
  if (!fs.existsSync(cases)) return { ok: false, detail: '用例文件不存在：' + casesPath };
  if (!fs.existsSync(runner)) return { ok: false, detail: '对拍执行器丢了：' + runner };
  const cp = spawnSync(process.execPath, [runner, a, b, cases], { encoding: 'utf8', timeout: 30000 });
  if (cp.error) return { ok: false, detail: '跑不起来：' + cp.error.message };
  let j = null;
  try { j = JSON.parse(cp.stdout || ''); } catch { return { ok: false, detail: '对拍进程没吐 JSON：' + String(cp.stdout || cp.stderr || '').slice(0, 160) }; }
  if (j.fatal) return { ok: false, detail: '对拍参数有问题：' + j.fatal };
  const diffs = j.diffs || [];
  return {
    ok: diffs.length === 0,
    detail: diffs.length
      ? (j.total - diffs.length) + '/' + j.total + ' 一致；变了的有：' + diffs.slice(0, 6).map((d) => d.name + '（旧 ' + d.b + ' / 新 ' + d.a + '）').join('；')
      : j.total + '/' + j.total + ' 一致',
  };
}

/** 验收一个已经落盘的文件 */
export function verifyFile(target, taskText = '', opts = {}) {
  const abs = path.join(process.cwd(), target);
  if (!fs.existsSync(abs)) return { ok: false, checks: [{ name: '文件存在', ok: false, detail: target + ' 不在磁盘上' }] };
  return verifyContent(target, fs.readFileSync(abs, 'utf8'), taskText, opts);
}

/** 失败时用来回喂给 agent 的反馈文本 */
export function feedbackFor(result, taskText, verifyRes) {
  const bad = (verifyRes.checks || []).filter((c) => !c.ok);
  const lines = [];
  lines.push('上一次的产出没通过验收，问题如下：');
  for (const c of bad) lines.push('- ' + c.name + '：' + (c.detail || '未通过'));
  lines.push('');
  lines.push('请只修上面这些问题，保持原任务的其他要求不变，重新给出完整产出（不要只给片段）。');
  lines.push('');
  lines.push('原任务：');
  lines.push(String(taskText || '').slice(0, 2000));
  return lines.join(String.fromCharCode(10));
}
