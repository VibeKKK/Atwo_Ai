// lib/selfparse.mjs —— self.mjs 的纯函数层（可被单测直接 import，不需要跑 CLI）
//
// 为什么单独拆出来：self.mjs 是个 CLI 脚本，import 它就会执行主流程；
// 而「从 agent 回答里抽文件」和「从 SHARED.md 待办里挑任务」这两件事是纯字符串处理，
// 必须能脱离网络/agent/磁盘副作用单独测（2026-11-14 多文件自改实测踩到）。

const ALLOWED_EXT = /\.(mjs|js|json|md|txt)$/i;

/**
 * 从 agent 回答里抽出 [{ file, content }]。
 * 支持的四种写法（实测都出现过）：
 *   1. 适配层契约：{"summary":"…","code":"// test/x.mjs\n…"}
 *   2. 围栏首行：```js \n // FILE: test/x.mjs \n …
 *   3. 围栏首行只写路径注释：```js \n // test/x.mjs \n …
 *   4. 围栏外上一行写路径：### test/x.mjs \n ```js \n …
 * 同一文件出现多次只取第一次；只接受允许的扩展名。
 */
export function extractFiles(text) {
  const out = [];
  const seen = new Set();
  const push = (file, content) => {
    const f = String(file || '')
      .trim()
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/^\.\//, '')
      .replace(/\\/g, '/');
    if (!f || !ALLOWED_EXT.test(f) || seen.has(f)) return;
    seen.add(f);
    out.push({ file: f, content: String(content || '').replace(/\r\n/g, '\n') });
  };
  const body = String(text || '');

  // 第零优先：适配层契约把文件内容整段塞在 code 字段，路径写在正文首行注释里
  const bare = body.trim().replace(/^```[a-zA-Z]*\r?\n/, '').replace(/\r?\n```$/, '');
  if (bare.startsWith('{')) {
    try {
      const o = JSON.parse(bare);
      const code = typeof o.code === 'string' ? o.code : (typeof o.answer === 'string' ? o.answer : '');
      if (code.trim()) {
        const first = code.split(/\r?\n/)[0].trim();
        const m1 = /^(?:\/\/|#|\/\*|<!--)\s*(?:FILE:\s*)?([A-Za-z0-9_./\\-]+\.(?:mjs|js|json|md|txt))\b/i.exec(first);
        if (m1) { push(m1[1], code.split(/\r?\n/).slice(1).join('\n')); return out; }
        const m2 = /(?:^|\n)\s*(?:\/\/|#)?\s*([A-Za-z0-9_./\\-]+\.(?:mjs|js|json|md|txt))/i.exec(code.slice(0, 300));
        if (m2) { push(m2[1], code); return out; }
      }
    } catch { /* 不是 JSON，继续走围栏 */ }
  }

  // 第一优先：围栏首行 `FILE: path` / `// FILE: path` / `# FILE: path`
  const fence = /```[a-zA-Z]*\r?\n([\s\S]*?)```/g;
  let m;
  const leftovers = [];
  while ((m = fence.exec(body)) !== null) {
    const inner = m[1];
    const lines = inner.split(/\r?\n/);
    const first = (lines[0] || '').trim();
    const hit = /^(?:\/\/|#|\/\*)?\s*FILE:\s*(.+?)\s*(?:\*\/)?$/i.exec(first);
    if (hit) { push(hit[1], lines.slice(1).join('\n')); continue; }
    // 第二优先：首行是「看着像路径」的注释，例如 `// test/x.mjs`
    const cmt = /^(?:\/\/|#|\/\*|<!--)\s*([A-Za-z0-9_./\\-]+\.(?:mjs|js|json|md|txt))\b/i.exec(first);
    if (cmt) { push(cmt[1], lines.slice(1).join('\n')); continue; }
    leftovers.push({ inner, start: m.index });
  }

  // 第三/四优先：围栏外前面 400 字里最后出现的那个「像路径」的字符串
  for (const lf of leftovers) {
    const before = body.slice(Math.max(0, lf.start - 400), lf.start);
    const cands = [...before.matchAll(/([A-Za-z0-9_./\\-]+\.(?:mjs|js|json|md|txt))/gi)].map(x => x[1]);
    if (cands.length) { push(cands[cands.length - 1], lf.inner); continue; }
    const name = /(?:^|\n)\s*(?:创建|新增|改成|edit|add)\s*([A-Za-z0-9_./\\-]+\.(?:mjs|js|json|md|txt))/i.exec(body);
    if (name) push(name[1], lf.inner);
  }
  return out;
}

/**
 * 从 SHARED.md 全文里取「## N 待办」一节中第 nth 条未完成项（nth 从 1 起）。
 * 尾部的「（rank1）」这类括注会被去掉，因为它是负责人标注、不属于任务描述。
 */
export function pickTodoFrom(text, nth = 1) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex(l => /^##\s*\d+\s*待办/.test(l));
  if (start < 0) return null;
  const items = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const m = /^\s*-\s*\[\s*\]\s*(.+?)\s*$/.exec(l);
    if (m) items.push(m[1].replace(/[（(][^）)]*[）)]\s*$/, '').trim());
  }
  return items[nth - 1] || null;
}
