// test/self_parse.mjs —— lib/selfparse.mjs 的回归测试（零依赖，node:assert）
// 为什么需要它：自举时「抽文件」和「挑待办」这两步一旦静默错，会用错文件覆盖真代码，
// 或者把任务描述抽成半句话交给 agent —— 都不会立刻报错，只会产出垃圾提案。
import assert from 'node:assert';
import { extractFiles, pickTodoFrom } from '../lib/selfparse.mjs';

let n = 0;
const ck = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

// 1) 标准写法：两个围栏，各自首行 FILE:
ck('两个 FILE: 围栏都能抽出来', () => {
  const ans = [
    '这里是说明。',
    '```js',
    'FILE: lib/a.mjs',
    'export const a = 1;',
    '```',
    '再看下一个。',
    '```python',
    'FILE: docs/b.md',
    '# 标题',
    '```',
  ].join('\n');
  const f = extractFiles(ans);
  assert.strictEqual(f.length, 2);
  assert.strictEqual(f[0].file, 'lib/a.mjs');
  assert.strictEqual(f[0].content.trim(), 'export const a = 1;');
  assert.strictEqual(f[1].file, 'docs/b.md');
  assert.strictEqual(f[1].content.trim(), '# 标题');
});

// 2) 适配层契约写法：内容在 code 里，路径在首行注释
ck('契约 {summary,code} 能抽出单个文件', () => {
  const ans = JSON.stringify({
    summary: '新增一个测试',
    code: '// test/store_history.mjs\nimport assert from "node:assert";\n',
    notes: [],
    confidence: 1,
  });
  const f = extractFiles(ans);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].file, 'test/store_history.mjs');
  assert.ok(f[0].content.includes('import assert'));
  assert.ok(!f[0].content.includes('// test/store_history.mjs'), '路径注释应被剥掉，不该留在正文首行');
});

// 3) 围栏首行只写路径注释（不带 FILE:）
ck('围栏首行只有路径注释也能认', () => {
  const ans = '```js\n// lib/b.mjs\nexport const b = 2;\n```';
  const f = extractFiles(ans);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].file, 'lib/b.mjs');
  assert.strictEqual(f[0].content.trim(), 'export const b = 2;');
});

// 4) 围栏外上一行写路径（标题式）
ck('围栏外上一行的路径能被认作文件名', () => {
  const ans = '### docs/c.md\n```markdown\n内容在这里\n```';
  const f = extractFiles(ans);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].file, 'docs/c.md');
});

// 5) 同文件只取第一次；非法扩展名拒绝
ck('同文件去重 + 非法扩展名被拒', () => {
  const ans = [
    '```js', 'FILE: lib/a.mjs', 'first', '```',
    '```js', 'FILE: lib/a.mjs', 'second', '```',
    '```bash', 'FILE: run.exe', 'x', '```',
  ].join('\n');
  const f = extractFiles(ans);
  assert.strictEqual(f.length, 1, '只应剩一个文件');
  assert.strictEqual(f[0].content.trim(), 'first', '应保留第一次出现的内容');
});

// 6) 一个文件都没有时返回空数组（不能抛）
ck('无文件时返回空数组', () => {
  assert.deepStrictEqual(extractFiles('纯聊天，没有任何代码块'), []);
  assert.deepStrictEqual(extractFiles(''), []);
  assert.deepStrictEqual(extractFiles(null), []);
});

// 7) 挑待办：跳过已完成项，去掉尾部负责人括注
ck('pickTodoFrom 取第 N 条未完成项并去掉括注', () => {
  const md = [
    '## 9 别的节',
    '- [ ] 不该被选中',
    '## 10 待办（两边共见）',
    '- [x] 已经做完了',
    '- [ ] 三种竞态改 `aria-busy` 判据（rank1）',
    '- [ ] `ensureTrae` 加 allowRestart（用户手动开过 Trae 后现会返回 started:false）',
    '## 11 下一节',
    '- [ ] 也不该被选中',
  ].join('\n');
  assert.strictEqual(pickTodoFrom(md, 1), '三种竞态改 `aria-busy` 判据');
  assert.ok(pickTodoFrom(md, 2).startsWith('`ensureTrae` 加 allowRestart'));
  assert.strictEqual(pickTodoFrom(md, 3), null, '越界应返回 null 而不是抛错');
  assert.strictEqual(pickTodoFrom('没有待办节的文档', 1), null);
});

console.log('self_parse.mjs: ' + n + ' checks passed');
