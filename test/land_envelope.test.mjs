// 契约外壳必须剥掉再落盘：否则 {"answer": "..."} 整段 JSON 会被当成代码写进 .mjs，
// 语法闸迟一步才炸，而人看到的是「产物落下了但语法没过」——排查方向被带偏一整轮。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractCode, planLanding, unwrapEnvelope } from '../lib/land.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('ok ' + name); }
  else { fail += 1; console.log('FAIL ' + name); }
};

const CODE = 'export function add(a, b) {' + String.fromCharCode(10) + '  return a + b;' + String.fromCharCode(10) + '}';

// ① 剥壳：answer 键
{
  const raw = JSON.stringify({ answer: '// file: lib/a.mjs' + String.fromCharCode(10) + CODE, notes: ['x'], confidence: 0.9 });
  const t = unwrapEnvelope(raw);
  ok(t.startsWith('// file:'), 'answer 被剥出来当正文');
  ok(!t.includes('"confidence"'), '不带 JSON 尾巴');
}

// ② 剥壳：code 键（老契约回归）
{
  const raw = JSON.stringify({ code: CODE, target: 'lib/a.mjs' });
  ok(unwrapEnvelope(raw) === CODE, 'code 键也能剥');
}

// ③ 不是 JSON / 空值 → 原样返回（不许抛、不许清空）
{
  ok(unwrapEnvelope('') === '', '空串原样返回');
  ok(unwrapEnvelope('export const a = 1;') === 'export const a = 1;', '纯代码原样返回');
  ok(unwrapEnvelope('{ 坏 json') === '{ 坏 json', '坏 JSON 原样返回');
  ok(unwrapEnvelope({ code: 'x' }) === '[object Object]', '非字符串输入不抛（转成字符串）');
}

// ④ 空正文的壳不许当正文（否则等于把产物清空）
{
  const raw = JSON.stringify({ answer: '   ', code: '' });
  ok(unwrapEnvelope(raw) === raw, '空 answer 时不剥，保持原样');
}

// ⑤ 端到端：契约 JSON 落盘后，目标路径与内容都对
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-env-'));
  const cwd0 = process.cwd();
  try {
    process.chdir(root);
    const raw = JSON.stringify({ answer: '// file: lib/a.mjs' + String.fromCharCode(10) + CODE });
    const plan = planLanding([{ id: 1, status: 'done', output: raw, text: '新建 lib/a.mjs', agent: 'codebuddy' }], { minBytes: 8 });
    const it = plan[0];
    ok(it.target === 'lib/a.mjs', '目标路径认对（实际 ' + it.target + '）');
    ok(it.content.includes('export function add'), '内容是真代码');
    ok(!it.content.includes('"answer"'), '内容里没有 JSON 外壳');
    ok(it.action === 'create', '首次是 create');
    ok(it.reason === '' || it.reason === undefined, '没有拒绝理由（实际 ' + it.reason + '）');
  } finally { process.chdir(cwd0); }
}

// ⑥ 端到端：answer 里带多文件契约 → 两段都要落
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-env2-'));
  const cwd0 = process.cwd();
  try {
    process.chdir(root);
    const NL = String.fromCharCode(10);
    const inner = '// file: lib/a.mjs' + NL + 'export const a = 1;' + NL + NL + '// file: lib/b.mjs' + NL + 'export const b = 2;';
    const raw = JSON.stringify({ answer: inner });
    const plan = planLanding([{ id: 1, status: 'done', output: raw, text: '新建 lib/a.mjs 与 lib/b.mjs', agent: 'codebuddy' }], { minBytes: 8 });
    const targets = plan.map((p) => p.target).sort().join(',');
    ok(targets === 'lib/a.mjs,lib/b.mjs', '多文件契约两段都认（实际 ' + targets + '）');
  } finally { process.chdir(cwd0); }
}

// ⑦ extractCode 仍然能单独吃 code 键（老调用方不破）
{
  const r = extractCode(JSON.stringify({ code: CODE, target: 'lib/a.mjs', summary: 's' }));
  ok(r.source === 'contract' && r.code === CODE, 'extractCode 的 contract 分支未变');
}

console.log('');
console.log((fail === 0 ? '全部通过' : '有失败') + '：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
