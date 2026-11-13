/**
 * 输出契约层 —— 让 agent 的产出变成可校验的数据，而不是"一段看起来像代码的文字"。
 *
 * 为什么要有这层：
 *   Trae 把代码渲染进单个 <p class="markdown-p">，缩进在 DOM 层就被折叠，
 *   只能靠「要求围栏 → 抽围栏 → 洗行号」三步猜。codebuddy 的 CLI 文本同理。
 *   改成「让对面直接吐 JSON」，我们只需要 JSON.parse：一次成功或一次明确失败，
 *   不再有"看起来对了其实缩进没了"的中间态。
 */

export const CONTRACT_VERSION = 'v1';

/** 追加在 prompt 尾部的契约说明。刻意写得短——每多 100 字，每次都多花 token。 */
export const JSON_CONTRACT = `

[输出契约 ${CONTRACT_VERSION}]
只输出一个 JSON 对象。不要解释、不要 markdown 围栏、不要前后任何文字。
字段固定：
{"summary": "一句话说明你做了什么",
 "code": "完整可运行的代码；没有代码就填空字符串",
 "notes": ["关键决定或风险，最多 3 条"],
 "confidence": 0.0 到 1.0 之间的数}
代码里的换行必须写成 \\n 转义，整个对象必须能被 JSON.parse 直接解析。`;

/** 非代码任务（评审/解释/短答）用这个：只要一个 answer 字段。
 *  为什么散文也要契约：Trae 的页面 diff 会把「@ 添加上下文」「完全访问」这类 UI 文字
 *  一起算进回复（短回答时尤其明显，实测把「乙乙」污染成 44 个字符的界面文案）。 */
export const PROSE_CONTRACT = `

[输出契约 ${CONTRACT_VERSION}]
只输出一个 JSON 对象。不要解释、不要 markdown 围栏、不要前后任何文字。
字段固定：
{"answer": "你完整的回答正文（保留原有分段，换行写成 \\n 转义）",
 "notes": ["关键结论或风险，最多 3 条；没有就空数组"],
 "confidence": 0.0 到 1.0 之间的数}
整个对象必须能被 JSON.parse 直接解析；字符串里的双引号必须写成 \\"。`;

/** 判断"是不是一道要产出代码的活"。和 orchestra.mjs 里的 CODE_HINTS 口径一致。 */
const CODE_HINTS = /(写一个|写个|写一段|实现|编写|生成代码|重构|重写|改一下|修改代码|修复|报错|异常|堆栈|traceback|函数|方法|类|脚本|正则|SQL|接口|API|钩子|单元测试|用例|代码|code|function|class|script|bug|debug|patch|refactor|schema|parser)/i;
export const isCodeTask = (p) => CODE_HINTS.test(String(p || ''));

/** 洗掉 UI 噪声：行号 gutter、语言标签、复制按钮文字、围栏本身。 */
export function stripChrome(text) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  // ```json / ``` 围栏
  t = t.replace(/^[ \t]*```[a-zA-Z0-9_+-]*[ \t]*$/gm, '');
  // 单独的 "复制" / "Copy" / "运行" 行
  t = t.replace(/^[ \t]*(复制|Copy|Run|运行|插入|应用)[ \t]*$/gmi, '');
  // 行号 gutter：形如 "1  " / "12│" / "1\t" 开头的短前缀
  t = t.replace(/^[ \t]*\d{1,4}[ \t]*[│|][ \t]?/gm, '');
  t = t.replace(/^[ \t]*\d{1,4}[ \t]+(?=\S)/gm, '');
  return t;
}

/** 从任意文本里找出最外层配平的 { ... }。找不到返回 null。 */
function outerObject(text) {
  const s = String(text || '');
  let start = -1, depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 修第二种常见坏法：字符串值里出现**没转义的内部双引号**。
 * 实测 Trae 会这样输出：`"code": "... endswith(".lnk") ..."` —— 换行转义对了，引号没转。
 * 判据：一个 `"` 后面（跳过空白）不是 , } ] : 之一，那它就不是字符串结束符，而是内容 → 补 \。
 */
function fixInnerQuotes(text) {
  const s = String(text || '');
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch !== '"') { out += ch; continue; }
    if (!inStr) { inStr = true; out += ch; continue; }
    // 在字符串里遇到 " —— 看后面是不是合法的结束位置
    let k = i + 1;
    while (k < s.length && /\s/.test(s[k])) k++;
    const nxt = s[k];
    if (nxt === undefined || nxt === ',' || nxt === '}' || nxt === ']' || nxt === ':') {
      inStr = false;
      out += ch;
    } else {
      out += '\\"';   // 是内容里的引号，补转义
    }
  }
  return out;
}

/** 修常见坏法：字符串里出现裸换行/制表符（模型忘了转义）。 */
function escapeControlInStrings(text) {  let out = '', inStr = false, esc = false;
  for (const ch of text) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { out += ch; inStr = false; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

/**
 * 解析契约。
 * @returns {{ok:boolean, data?:object, reason?:string, repaired?:boolean}}
 */
export function parseContract(raw) {
  const cleaned = stripChrome(raw);
  const objText = outerObject(cleaned);
  if (!objText) return { ok: false, reason: 'no-object' };

  const attempts = [
    ['as-is', objText],
    ['escape-control', escapeControlInStrings(objText)],
    ['fix-inner-quotes', fixInnerQuotes(escapeControlInStrings(objText))],
    ['fix-inner-quotes-plain', fixInnerQuotes(objText)],
    // 有些模型会输出单引号 JSON
    ['single-quote', escapeControlInStrings(objText).replace(/'/g, '"')],
  ];
  for (const [tag, candidate] of attempts) {
    try {
      const data = JSON.parse(candidate);
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      return { ok: true, data: normalize(data), repaired: tag !== 'as-is' };
    } catch { /* 试下一个 */ }
  }
  return { ok: false, reason: 'unparseable' };
}

function normalize(d) {
  const out = {
    summary: typeof d.summary === 'string' ? d.summary : (typeof d.title === 'string' ? d.title : ''),
    answer: typeof d.answer === 'string' ? d.answer : (typeof d.text === 'string' ? d.text : ''),
    code: typeof d.code === 'string' ? d.code : '',
    notes: Array.isArray(d.notes) ? d.notes.filter(x => typeof x === 'string').slice(0, 3) : [],
    confidence: typeof d.confidence === 'number' ? Math.max(0, Math.min(1, d.confidence)) : null,
  };
  if (!out.code && typeof d.content === 'string') out.code = d.content;
  if (!out.answer && !out.code && typeof d.response === 'string') out.answer = d.response;
  return out;
}

/** 契约失败时的兜底：从原始文本里抽第一个围栏块，或整段当代码。 */
export function fallbackCode(raw) {
  const t = stripChrome(raw);
  const m = t.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/);
  if (m) return m[1].replace(/\s+$/, '');
  return t.trim();
}

/** 把契约结果渲染成人看的文本。 */
export function renderContract(c) {
  const lines = [];
  if (c.code) lines.push(c.code);
  else if (c.answer) lines.push(c.answer);
  if (c.summary) lines.push('\n—— ' + c.summary);
  if (c.notes && c.notes.length) lines.push(...c.notes.map(n => '· ' + n));
  if (typeof c.confidence === 'number') lines.push(`(confidence ${c.confidence.toFixed(2)})`);
  return lines.join('\n');
}
