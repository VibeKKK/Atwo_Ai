// 把「Trae 页面文本」变成「干净回答」的纯函数层。
//
// 为什么单独抽出来：这些函数以前住在 agents/trae.mjs 里，要测它们就得连 CDP、启动 Trae。
// 但它们本质是纯文本处理 —— 抽到独立模块后可以用真实坏样本做回归测试，
// 不启动任何 agent 也能验证「界面小改之后清洗还准不准」。
//
// 实测过的四种坏输入（都进了 fixtures/）：
//   trae-one-line.txt   代码被塞进单个 <p>，换行全丢
//   trae-gutter.txt     代码块混进行号 1..N 和语言标签
//   trae-polluted.txt   回答里掺了 "@ 添加上下文""完全访问" 等界面文案
//   trae-no-marker.txt  没有 TRAE / 由 AI 生成 标记的裸文本

/** 从新增区域里剥出 Trae 真正说的话：TRAE 标记之后、「由 AI 生成」之前 */
export function extractReply(text) {
  const s = String(text || '');
  const i = s.lastIndexOf('TRAE');
  const j = s.lastIndexOf('由 AI 生成');
  const body = (i >= 0 && j > i) ? s.slice(i + 4, j) : s;
  return body.replace(/^\s*思考过程\s*$/m, '').trim();
}

/**
 * 删掉独立成行的界面文案（输入框占位、权限提示、工具栏按钮）。
 * 判据是整行匹配，不做子串替换 —— 子串替换会把用户真的想说的句子切掉。
 */
const CHROME_LINE = /^(?:@\s*添加上下文.*|添加上下文|完全访问|允许完全访问|正常模式|深度思考|思考中\.*|深度求索中.*|发送|停止|停止生成|新会话|新建对话|历史会话|更多|设置|反馈|升级会员|立即升级|会员首月立减.*)$/;
export function stripUiChrome(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !CHROME_LINE.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 清掉代码块的「外壳」：行号栏、语言标签、复制按钮文字。
 * 实测（2026-11-13）：Trae 的代码块渲染成 <pre> + 行号 gutter，
 * 序列化后行号 1..N 会作为独立行混进来，语言名（Python）也会单独一行。
 */
export function cleanCodeChrome(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const isNum = (s) => /^\s*\d{1,4}\s*$/.test(s);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isNum(lines[i])) {
      let j = i;
      while (j < lines.length && isNum(lines[j])) j++;
      if (j - i >= 3) { i = j; continue; }   // 连续 ≥3 行纯数字 = 行号栏，整块丢掉
    }
    out.push(lines[i]);
    i++;
  }
  const lang = /^(python|py|python3|javascript|js|typescript|ts|java|c|cpp|csharp|go|rust|bash|sh|powershell|json|yaml|xml|html|css|sql|text|plaintext)$/i;
  const kept = out.filter((l, idx) => !(idx < 4 && lang.test(l.trim())));
  const noCopy = kept.filter((l) => !/^(复制|拷贝|复制代码|copy|copy code|run|运行)$/i.test(l.trim()));
  while (noCopy.length && !noCopy[0].trim()) noCopy.shift();
  while (noCopy.length && !noCopy[noCopy.length - 1].trim()) noCopy.pop();
  return noCopy.join('\n').trim();
}

/** 从文本里抽出第一个 ```lang … ``` 代码块；没有围栏就原样返回 */
export function extractCode(text) {
  const s = String(text || '');
  const m = s.match(/```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)```/);
  return (m ? m[1] : s).replace(/^\s*\n/, '').replace(/\s*$/, '');
}

/** 页面文本 → 干净回答（一次做完三道：剥标记 → 洗界面文案 → 清代码外壳） */
export function cleanReply(text) {
  return cleanCodeChrome(stripUiChrome(extractReply(text)));
}

/**
 * 检测缩进是否在传输里被压平了。
 * Trae 把多行代码塞进单个 <p> 时，HTML 的 white-space:normal 会把换行压成空格，
 * 取回来就是一行 —— 这时必须重发（要求围栏），而不是把坏结果交出去。
 */
export function looksCollapsed(code) {
  const s = String(code || '');
  if (!s) return false;
  const lines = s.split('\n').filter((l) => l.trim());
  if (lines.length >= 2) return false;                    // 已经多行，正常
  // 单行里出现「语句; 语句」或「def f(): return x」这类，说明原来该是多行
  return /;\s*\S/.test(s) || /:\s*(return|print|if|for|while)\b/.test(s);
}
