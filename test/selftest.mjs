// 回归自测：把「真实坏样本」喂给纯函数层，验证清洗与契约解析仍然正确。
// 不启动 Trae、不连 CDP、不花任何 token —— 界面小改之后先跑这个。
//
//   node test/selftest.mjs              正常跑
//   node test/selftest.mjs --verbose    打印每项细节
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanReply, extractCode, looksCollapsed, stripUiChrome } from '../lib/reply.mjs';
import { parseContract, renderContract, fallbackCode, isCodeTask } from '../lib/contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FIX = path.join(ROOT, 'fixtures');
const VERBOSE = process.argv.includes('--verbose');

let pass = 0;
let fail = 0;
const rows = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; rows.push(['✓', name, detail]); }
  else { fail++; rows.push(['✗', name, detail]); }
}
const fix = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');

// ---------- 1. 行号 gutter + 语言标签 ----------
{
  const raw = fix('trae-gutter.txt');
  const cleaned = cleanReply(raw);
  check('gutter: 去掉 TRAE / 由 AI 生成 标记', !/由 AI 生成/.test(cleaned) && !/^TRAE$/m.test(cleaned));
  check('gutter: 去掉行号栏（连续数字行）', !/^\s*[1-6]\s*$/m.test(cleaned), cleaned.split('\n')[0] || '');
  check('gutter: 去掉语言标签 Python', !/^Python$/m.test(cleaned));
  check('gutter: 去掉「复制」按钮文字', !/^复制$/m.test(cleaned));
  check('gutter: 保留 4 空格缩进', /\n    items = \[\]/.test(cleaned));
  check('gutter: 保留 def 行', /^def top_lnk\(root, n\):$/m.test(cleaned));
  const code = extractCode(cleaned);
  check('gutter: extractCode 抽出可用代码', /return items\[:n\]/.test(code));
  check('gutter: looksCollapsed 判为未压平', looksCollapsed(code) === false);
}

// ---------- 2. 界面文案污染 ----------
{
  const raw = fix('trae-polluted.txt');
  const cleaned = cleanReply(raw);
  check('污染: 去掉 @ 添加上下文', !/添加上下文/.test(cleaned));
  check('污染: 去掉 完全访问', !/完全访问/.test(cleaned));
  check('污染: 残留内容仍是合法 JSON', parseContract(cleaned).ok === true, cleaned.slice(0, 60));
  const p = parseContract(cleaned);
  check('污染: answer 字段被解析出来', p.data && p.data.answer === '癸癸', JSON.stringify(p.data));
}

// ---------- 3. 换行被压平（关键回归） ----------
{
  const raw = fix('trae-one-line.txt');
  const cleaned = cleanReply(raw);
  const code = extractCode(cleaned);
  check('压平: 单行代码被 looksCollapsed 认出来', looksCollapsed(code) === true, code);
}

// ---------- 4. 没有标记的裸文本 ----------
{
  const raw = fix('trae-no-marker.txt');
  const cleaned = cleanReply(raw);
  check('裸文本: 原样保留可解析 JSON', parseContract(cleaned).ok === true);
  check('裸文本: looksCollapsed 不误报', looksCollapsed('{"code":"print(1)"}') === false);
}

// ---------- 5. 围栏代码块 ----------
{
  const raw = fix('trae-fenced.txt');
  const cleaned = cleanReply(raw);
  const code = extractCode(cleaned);
  check('围栏: 抽出代码不带 ``` 标记', !/```/.test(code) && /def mul/.test(code), code.replace(/\n/g, '⏎'));
  check('围栏: 保留缩进', /\n    return a \* b/.test(code));
}

// ---------- 6. 契约解析五级修复链 ----------
{
  const cases = [
    ['干净 JSON', '{"code":"x=1","notes":[],"confidence":1}', true],
    ['前后有废话', '好的，这是结果：{"code":"x=1","notes":[],"confidence":1} 希望有用', true],
    ['字符串内裸换行', '{"code":"def f():\n    return 1","notes":[],"confidence":0.9}', true],
    ['字符串内未转义双引号', '{"code":"if f.endswith(".lnk"): pass","notes":[],"confidence":0.8}', true],
    ['完全不是 JSON', '我拒绝输出 JSON', false],
  ];
  for (const [name, raw, want] of cases) {
    const r = parseContract(raw);
    check('契约: ' + name, r.ok === want, r.ok ? `repaired=${r.repaired || 'as-is'}` : r.reason);
  }
  const hard = parseContract(cases[3][1]);
  check('契约: 双引号修复后 code 完整', hard.ok && /endswith\("\.lnk"\)/.test(hard.data.code), hard.ok ? hard.data.code : '');
}

// ---------- 7. 路由判据 ----------
{
  check('路由: 「写一个函数」判为代码', isCodeTask('写一个 Python 函数统计文件大小') === true);
  check('路由: 「解释一下为什么」判为非代码', isCodeTask('解释一下为什么这个逻辑会死循环') === false);
  check('路由: 混合判为代码', isCodeTask('评审这段代码并给出修复') === true);
}

// ---------- 8. 渲染不丢内容 ----------
{
  const r = { ok: true, data: { summary: '加法', code: 'def add(a,b):\n    return a+b', notes: ['无副作用'], confidence: 0.95 } };
  const out = renderContract(r, { isCode: true });
  check('渲染: 含代码本体', /return a\+b/.test(out));
  check('渲染: 含 notes', /无副作用/.test(out));
  check('渲染: 含 confidence', /0\.95/.test(out));
  const fb = fallbackCode('随便说了一句\n```js\nconsole.log(1)\n```');
  check('渲染: 降级时能抽到围栏代码', /console\.log\(1\)/.test(fb));
}

// ---------- 9. UI 清洗不误杀正常句子 ----------
{
  const keep = '设置这个参数之后，完全访问权限就够了，不需要重新添加。';
  check('清洗: 句中的「完全访问」不被删', stripUiChrome(keep).includes('完全访问'));
}

// ---------- 输出 ----------
if (VERBOSE) {
  for (const [mark, name, detail] of rows) {
    console.log(`${mark} ${name}${detail ? '   ' + String(detail).slice(0, 80) : ''}`);
  }
  console.log('');
}
const total = pass + fail;
console.log(`回归自测：${pass}/${total} 通过${fail ? `，${fail} 项失败` : ''}`);
if (fail) {
  for (const [mark, name, detail] of rows.filter((r) => r[0] === '✗')) {
    console.log(`  ✗ ${name}   ${String(detail).slice(0, 120)}`);
  }
  process.exit(1);
}
