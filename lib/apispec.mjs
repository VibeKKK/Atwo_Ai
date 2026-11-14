// lib/apispec.mjs —— 产物接口契约：把「导出什么、几个参数」从中文散文变成机器可校验的结构。
//
// 和 lib/contract.mjs 不是一回事，别混淆：
//   contract.mjs  = 输出格式契约（让 agent 的【回复】是一个 JSON）
//   apispec.mjs   = 产物接口契约（让 agent 写出的【文件】能对上别人写的那一半）
//
// 为什么要有这层：今晚 9 个零件能拼通，靠的是我把接口签名抄进了每段任务描述里 ——
// 那是我的认真，不是系统的保证。一旦漏抄、或者模型没照抄，产物就是「能跑但拼不上」。
// 这个模块把那句话变成结构，由程序判，不由模型猜。
//
// 两条设计约束：
//   1) 不执行产物代码。只做静态解析 —— 产物可能是刚生成、带副作用的半成品，
//      为了验签名去 import 它，等于让验收入口承担执行风险。
//   2) 只验「形状」不验「意图」。函数叫 loadTasks、收一个 string 参数，这是形状；
//      它读文件读得对不对，是意图。意图靠测试，形状靠这里。

import fs from 'node:fs';

/** 从参数串里切出参数名。支持默认值与解构（解构整体算一个参数）。 */
function splitParams(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const out = [];
  let depth = 0, cur = '', quote = null;
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if ('({['.includes(ch)) depth++;
    if (')}]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((p) => p.split('=')[0].trim()).filter(Boolean);
}

/** 静态解析一个 ESM 文件的导出表。返回 [{ name, params }]，params 为参数名数组（null 表示未知）。 */
export function parseExports(src) {
  const text = String(src || '');
  const found = new Map();

  const fnRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  for (const m of text.matchAll(fnRe)) found.set(m[1], splitParams(m[2]));

  const arrowRe = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/g;
  for (const m of text.matchAll(arrowRe)) {
    if (!found.has(m[1])) found.set(m[1], m[2] !== undefined ? splitParams(m[2]) : [m[3]]);
  }
  const fnExprRe = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)/g;
  for (const m of text.matchAll(fnExprRe)) if (!found.has(m[1])) found.set(m[1], splitParams(m[2]));

  const namedRe = /export\s*\{([^}]*)\}/g;
  for (const m of text.matchAll(namedRe)) {
    for (const raw of m[1].split(',')) {
      const parts = raw.trim().split(/\s+as\s+/);
      const alias = (parts[1] || parts[0] || '').trim();
      if (alias && !found.has(alias)) found.set(alias, null);
    }
  }
  const nsRe = /export\s+(?:\*|\*\s+as\s+\w+)\s+from/g;
  const hasNs = nsRe.test(text);
  return { list: [...found.entries()].map(([name, params]) => ({ name, params })), hasNamespaceReexport: hasNs };
}

/**
 * 校验一个文件是否符合契约。
 * @param {string} file 绝对路径
 * @param {{exports: Array<{name:string, params?:string[]}>}} spec
 */
export function checkApiSpecSource(src, spec, label) {
  const res = { ok: false, file: label || '<src>', missing: [], arity: [], extra: [], notes: [] };
  const { list, hasNamespaceReexport } = parseExports(src);
  if (hasNamespaceReexport) res.notes.push('有 export * from，导出表不完整');
  const byName = new Map(list.map((e) => [e.name, e]));
  const want = (spec && spec.exports) || [];
  if (!want.length) { res.notes.push('契约没写 exports，无法校验'); return res; }

  for (const w of want) {
    const hit = byName.get(w.name);
    if (!hit) { res.missing.push(w.name); continue; }
    if (!w.params) continue;
    if (hit.params === null) { res.notes.push(w.name + ' 通过 export {} 再导出，参数个数未知'); continue; }
    if (hit.params.length !== w.params.length) { res.arity.push({ name: w.name, want: w.params, got: hit.params }); continue; }
    const wrong = w.params.findIndex((p, i) => p !== hit.params[i]);
    if (wrong >= 0) res.arity.push({ name: w.name, want: w.params, got: hit.params, firstDiff: wrong });
  }

  const wanted = new Set(want.map((x) => x.name));
  res.extra = list.map((e) => e.name).filter((n) => !wanted.has(n));
  res.ok = res.missing.length === 0 && res.arity.length === 0;
  return res;
}

/** 文件版：不存在要明说，不能当成通过。 */
export function checkApiSpec(file, spec) {
  if (!fs.existsSync(file)) return { ok: false, file, missing: [], arity: [], extra: [], notes: ['文件不存在'] };
  return checkApiSpecSource(fs.readFileSync(file, 'utf8'), spec, file);
}

/** 一行结论，人和机器都能读。 */
export function formatApiSpec(r) {
  if (r.ok) return 'apispec ok' + (r.extra.length ? '（额外导出 ' + r.extra.join(',') + '，不算违约）' : '');
  const bits = [];
  if (r.missing.length) bits.push('缺导出 ' + r.missing.join(','));
  for (const a of r.arity) {
    bits.push(a.name + ' 参数不符：要 [' + a.want.join(',') + '] 实为 [' + a.got.join(',') + ']' + (a.firstDiff !== undefined ? '（第 ' + (a.firstDiff + 1) + ' 个就错了）' : ''));
  }
  return 'apispec FAIL: ' + bits.join('；');
}
