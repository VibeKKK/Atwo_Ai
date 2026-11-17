/**
 * 引文能不能落地：父审写「lib/x.mjs:244」时，那一行到底存不存在。
 *
 * 为什么值得单独一个模块：机械闸门原先只检查「理由里有没有文件:行 的形状」，
 * 于是编造行号也能过 —— 形状对、内容假。这一步只需读文件、比行数，成本微秒级，
 * 却能挡住最省事的一种编造（对着形状写一个看起来合理的行号）。
 *
 * 边界：只验「这一行存在」，不验「这一行的内容与你的说法一致」——后者必须读语义，
 * 属于父审/人工的事。宁可只做能确定的那一半，也不要假装验了全部。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 取文本里第一个「文件:行」形状的引用。没有就返回 null。 */
const CITE = /([\w./-]+\.(?:mjs|js|cjs|ts|tsx|json|md|py|ya?ml|txt))(?::(\d+))?/;

export function firstCite(text) {
  // 先把反斜杠归一：Windows 路径与 Markdown 转义都爱用 \，正则里不该为此再写一套分支。
  const norm = String(text || '').split(String.fromCharCode(92)).join('/');
  const m = CITE.exec(norm);
  if (!m) return null;
  return { file: m[1].replace(/^[a-zA-Z]:[\\/]/, '').replace(/\\/g, '/').replace(/^\.\//, ''), line: m[2] ? Number(m[2]) : 0 };
}

/**
 * 检查一个引用是否落地。
 * @returns {{ ok: boolean, why?: string, lines?: number }}
 *   why: 'file-missing' 文件不在仓库里 / 'line-out-of-range' 行号超出文件长度
 *        / 'not-a-cite' 文本里没有引用
 */
export function checkCite(cwd, text, cache) {
  const cite = firstCite(text);
  if (!cite) return { ok: false, why: 'not-a-cite' };
  const abs = path.resolve(cwd || process.cwd(), cite.file);
  let lines;
  if (cache && cache.has(abs)) {
    lines = cache.get(abs);
  } else {
    try {
      lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
    } catch {
      if (cache) cache.set(abs, -1);
      return { ok: false, why: 'file-missing' };
    }
    if (cache) cache.set(abs, lines);
  }
  if (lines < 0) return { ok: false, why: 'file-missing' };
  if (cite.line && cite.line > lines) return { ok: false, why: 'line-out-of-range', lines };
  return { ok: true, lines };
}

/** 给提示/日志用的一句话解释。 */
export function explainCiteMiss(why, text) {
  const cite = firstCite(text);
  const at = cite ? cite.file + (cite.line ? ':' + cite.line : '') : '（文本里没有文件引用）';
  if (why === 'file-missing') return '理由里引用的文件不存在：' + at;
  if (why === 'line-out-of-range') return '理由里引用的行号超出文件长度：' + at;
  return '理由里没有可核对的「文件:行」：' + at;
}
