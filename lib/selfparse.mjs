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

// ─────────────────────────────────────────────────────────────────────────────
// A0：就地补丁（unified diff）
//
// 为什么需要：2026-11-15 实测，让 codebuddy 改一个 20 行的小函数，它回的是散文
// （「仅替换 buildBrief 的 return 行」+ 一小段 diff），**没有整文件** →
// extractFiles() 抽不到东西 → self.mjs 报「没拿到回答」。
// 模型对「小改动」天然倾向给 diff，硬要整文件只会得到胡编的全文。
// 所以解析层必须同时认整文件与补丁两种形态。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从回答里抽出 unified diff 补丁：[{ file, hunks: [{ header, lines }] }]
 * 认三种形态：
 *   1. ```diff 围栏（带 --- / +++ / @@）
 *   2. 普通 ``` 围栏里直接出现 @@ hunk（模型常省略 --- / +++）
 *   3. 围栏外裸 diff（同样要求出现 @@）
 * 文件路径优先取 `+++ b/path`，其次 `--- a/path`，最后取 hunk 之前 400 字里像路径的串。
 */
export function extractPatches(text) {
  const body = String(text || '').replace(/\r\n/g, '\n');
  const out = [];
  const seen = new Set();

  const blocks = [];
  const fence = /```(?:diff|patch)?\n([\s\S]*?)```/g;
  let m;
  let covered = 0;
  while ((m = fence.exec(body)) !== null) {
    covered += m[0].length;
    if (/^\s*@@ /m.test(m[1])) blocks.push({ inner: m[1], start: m.index });
  }
  // 一个围栏都没有但整段就是 diff（模型直接贴裸 diff）
  if (!blocks.length && /^\s*@@ /m.test(body)) blocks.push({ inner: body, start: 0 });

  for (const b of blocks) {
    const lines = b.inner.split('\n');
    let file = '';
    for (const l of lines) {
      const pm = /^\+\+\+\s+(?:b\/)?([A-Za-z0-9_./\\-]+\.(?:mjs|js|json|md|txt))/.exec(l)
        || /^---\s+(?:a\/)?([A-Za-z0-9_./\\-]+\.(?:mjs|js|json|md|txt))/.exec(l);
      if (pm) { file = pm[1]; break; }
    }
    if (!file) {
      const before = body.slice(Math.max(0, b.start - 400), b.start);
      const cands = [...before.matchAll(/([A-Za-z0-9_./\\-]+\.(?:mjs|js|json|md|txt))/gi)].map(x => x[1]);
      if (cands.length) file = cands[cands.length - 1];
    }
    if (!file) continue;
    const f = String(file).replace(/^\.\//, '').replace(/\\/g, '/');
    if (!ALLOWED_EXT.test(f) || seen.has(f)) continue;

    const hunks = [];
    let cur = null;
    for (const l of lines) {
      if (/^@@/.test(l)) { cur = { header: l, lines: [] }; hunks.push(cur); continue; }
      if (!cur) continue;
      if (/^(?:---|\+\+\+|diff |index )/.test(l)) continue;
      // 真空行只可能是围栏尾部/粘贴产生的垃圾：unified diff 的空上下文行是**一个空格**，
      // 从来不是空串。2026-11-15 单测踩到：把尾部空串当上下文行会让 hunk 多一行、永远定位失败。
      if (l === '') continue;
      if (/^[ +\-]/.test(l)) cur.lines.push(l);
    }
    const real = hunks.filter(h => h.lines.some(x => x[0] === '-' || x[0] === '+'));
    if (!real.length) continue;
    seen.add(f);
    out.push({ file: f, hunks: real });
  }
  return out;
}

/**
 * 把补丁应用到原文。返回 { ok, text, applied, reason }。
 * 定位策略：把 hunk 里「上下文 + 删除行」拼成 oldBlock，在目标里找整块相等的位置；
 * 找不到再做一次宽容匹配（去掉首尾空白后比较），仍失败则该 hunk 记 failed 并整体失败。
 */
export function applyPatch(originalText, patch) {
  const src = String(originalText || '').replace(/\r\n/g, '\n');
  let lines = src.split('\n');
  let applied = 0;
  for (const h of (patch && patch.hunks) || []) {
    const oldBlock = [];
    const newBlock = [];
    for (const raw of h.lines) {
      const tag = raw[0];
      const body = raw.slice(1);
      if (tag === ' ') { oldBlock.push(body); newBlock.push(body); }
      else if (tag === '-') oldBlock.push(body);
      else if (tag === '+') newBlock.push(body);
    }
    if (!oldBlock.length && !newBlock.length) continue;
    let at = -1;
    outer:
    for (let i = 0; i + oldBlock.length <= lines.length; i++) {
      for (let k = 0; k < oldBlock.length; k++) {
        if (lines[i + k] !== oldBlock[k]) continue outer;
      }
      at = i; break;
    }
    if (at < 0) {
      // 宽容匹配：忽略首尾空白
      const norm = (s) => s.replace(/\s+$/,'').replace(/^\s+/,'');
      const target = oldBlock.map(norm);
      outer2:
      for (let i = 0; i + target.length <= lines.length; i++) {
        for (let k = 0; k < target.length; k++) {
          if (norm(lines[i + k]) !== target[k]) continue outer2;
        }
        at = i; break;
      }
    }
    if (at < 0) {
      return { ok: false, text: src, applied, reason: `hunk 定位失败（${h.header || '?'}）` };
    }
    lines = [...lines.slice(0, at), ...newBlock, ...lines.slice(at + oldBlock.length)];
    applied++;
  }
  return { ok: true, text: lines.join('\n'), applied, reason: '' };
}

