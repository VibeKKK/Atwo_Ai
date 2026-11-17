// lib/exports-check.mjs —— 第 9 步闸门：import 的名字必须真的被导出。
//
// 为什么需要它（2026-11-17 实测事故）：HEAD 里 lib/outcome.mjs 有
//   import { detectTarget, selfLanded } from './land.mjs';
// 而 lib/land.mjs 的 selfLanded 还留在某人的工作区没提交 —— 于是
//   git clone 之后 atwo 起不来：SyntaxError: The requested module './land.mjs'
//   does not provide an export named 'selfLanded'
// 干净 checkout 跑 test/all.mjs：13 个测试全挂在同一个根因上。
//
// 原有的 closure 步只查「这个文件在不在」，不查「里面的名字在不在」。
// 提交不全（调用方进了库、实现没进库）是最常见的一种坏发布，必须机械兜住。
//
// 判据：对每个本地 import（以 . 开头、以 .mjs 结尾），把具名导入名与目标文件的导出集合求差。
// 目标文件里有 export-star 声明时不判（静态无法确定，宁可漏不可误杀）。
import fs from 'node:fs';
import path from 'node:path';

export const EXPORTS_CONTRACT = 'atwo-exports-check/1';

const SCAN_DIRS = ['lib', 'vm', 'agents'];
const SCAN_FILES = ['atwo.mjs', 'orchestra.mjs'];


/** 剥掉注释：注释里的示例 import 不算真引用（我自己踩过 —— 在注释里写一行 import
 *  演示，被自己的解析器当成缺导出报了红）。字符串字面量整体保留，仅跳过其内容。
 */
export function stripComments(src) {
  const BT = String.fromCharCode(96);
  const text = String(src == null ? '' : src);
  let out = '';
  let i = 0;
  const n = text.length;
  let state = 'code';
  let quote = '';
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === '\'' || c === '"' || c === BT) { state = 'str'; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += '\n';
      i++; continue;
    }
    if (c === '\\') { out += c + (c2 == null ? '' : c2); i += 2; continue; }
    if (c === quote) { state = 'code'; out += c; i++; continue; }
    out += c; i++; continue;
  }
  return out;
}

/** 一个文件里声明的导出名集合；unknown=true 表示有 export-star 之类无法静态确定的声明。 */
export function exportsOf(src) {
  const names = new Set();
  let unknown = false;
  const text = stripComments(src);
  if (/export\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*['"]/.test(text)) unknown = true;
  let m;
  const decl = /export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = decl.exec(text))) names.add(m[1]);
  const braced = /export\s*\{([^}]*)\}/g;
  while ((m = braced.exec(text))) {
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const as = seg.split(/\s+as\s+/);
      const name = (as[1] || as[0]).trim().replace(/^type\s+/, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  if (/export\s+default\b/.test(text)) names.add('default');
  return { names, unknown };
}

/** 一个文件里的本地具名导入：[{ from, names: [] }] */
export function importsOf(src) {
  const out = [];
  const text = stripComments(src);
  let m;
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = re.exec(text))) {
    const spec = m[2];
    if (!spec.startsWith('.') || !spec.endsWith('.mjs')) continue;
    const names = m[1].split(',').map((x) => x.trim()).filter(Boolean)
      .map((x) => x.split(/\s+as\s+/)[0].trim().replace(/^type\s+/, ''))
      .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));
    out.push({ from: spec, names });
  }
  return out;
}

function listFiles(cwd) {
  const files = [];
  for (const f of SCAN_FILES) {
    if (fs.existsSync(path.join(cwd, f))) files.push(f);
  }
  for (const d of SCAN_DIRS) {
    const dir = path.join(cwd, d);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.mjs') || name.includes('.bak')) continue;
      files.push(path.posix.join(d, name));
    }
  }
  return files;
}

/** 找出「import 了但对方没导出」的引用。 */
export function findMissingExports(cwd = process.cwd()) {
  const problems = [];
  const files = listFiles(cwd);
  const cache = new Map();
  const exportSetOf = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const abs = path.join(cwd, rel);
    const v = fs.existsSync(abs) ? exportsOf(fs.readFileSync(abs, 'utf8')) : { missing: true };
    cache.set(rel, v);
    return v;
  };
  for (const file of files) {
    const abs = path.join(cwd, file);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const imp of importsOf(text)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), imp.from));
      const ex = exportSetOf(target);
      const lineOf = (name) => {
        const i = text.indexOf(name);
        return i < 0 ? 0 : text.slice(0, i).split('\n').length;
      };
      if (ex.missing) {
        problems.push({ file, line: lineOf(imp.from), from: imp.from, name: '*', reason: 'missing-file' });
        continue;
      }
      if (ex.unknown) continue;
      for (const name of imp.names) {
        if (!ex.names.has(name)) {
          problems.push({ file, line: lineOf(name), from: imp.from, name, reason: 'missing-export' });
        }
      }
    }
  }
  return problems;
}

export function formatMissingExports(problems) {
  if (!problems.length) return '导出与引用一致';
  return problems.slice(0, 8).map((p) => p.file + ':' + p.line + ' 要 ' + p.name + '，'
    + (p.reason === 'missing-file' ? p.from + ' 这个文件不存在' : p.from + ' 没导出它')).join('；');
}
