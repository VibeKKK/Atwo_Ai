// atwo edit：结构化改文件。判据是「同一份指令重放，结果逐字节相同」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEdits, validateSpec, applyOne, eolOf, logEdits, formatEdit } from '../lib/edit-ops.mjs';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-ops-'));
  fs.writeFileSync(path.join(d, 'a.mjs'), 'const x = 1;' + NL + 'const y = 2;' + NL);
  return d;
}

test('replace 唯一命中就改，位置与行数变化都报准', () => {
  const d = tmp();
  const r = runEdits({ ops: [{ file: 'a.mjs', find: 'const y = 2;', replace: 'const y = 3;' }] }, { cwd: d });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].line, 2);
  assert.equal(r.results[0].delta, 0);
  assert.ok(fs.readFileSync(path.join(d, 'a.mjs'), 'utf8').includes('const y = 3;'));
});

test('命中多处而没给 all 就拒绝（绝不猜改哪一处）', () => {
  const d = tmp();
  const r = runEdits({ ops: [{ file: 'a.mjs', find: 'const ', replace: 'let ' }] }, { cwd: d });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].reason, 'ambiguous');
  assert.ok(fs.readFileSync(path.join(d, 'a.mjs'), 'utf8').includes('const x = 1;'), '一个字节都没写');
});

test('all:true 时全部替换', () => {
  const d = tmp();
  const r = runEdits({ ops: [{ file: 'a.mjs', find: 'const ', replace: 'let ', all: true }] }, { cwd: d });
  assert.equal(r.ok, true);
  const out = fs.readFileSync(path.join(d, 'a.mjs'), 'utf8');
  assert.ok(!out.includes('const '));
  assert.equal(r.results[0].hits, 2);
});

test('insert 按标记插入：after 与 before 都落在正确一侧', () => {
  const d = tmp();
  runEdits({ ops: [{ file: 'a.mjs', anchor: 'const x = 1;', insert: 'const z = 9;' }] }, { cwd: d });
  let out = fs.readFileSync(path.join(d, 'a.mjs'), 'utf8');
  assert.equal(out.split(NL)[1], 'const z = 9;', 'after 落在标记下一行');
  runEdits({ ops: [{ file: 'a.mjs', anchor: 'const x = 1;', insert: 'const w = 8;', where: 'before' }] }, { cwd: d });
  out = fs.readFileSync(path.join(d, 'a.mjs'), 'utf8');
  assert.equal(out.split(NL)[0], 'const w = 8;', 'before 落在标记上一行');
});

test('CRLF 文件改完还是 CRLF（今晚踩过的坑）', () => {
  const d = tmp();
  const crlf = 'line one；' + CR + NL + 'line two；' + CR + NL;
  fs.writeFileSync(path.join(d, 'c.txt'), crlf);
  assert.equal(eolOf(crlf), CR + NL);
  const r = runEdits({ ops: [{ file: 'c.txt', find: 'line two；', replace: 'line two!(改了)' }] }, { cwd: d });
  assert.equal(r.ok, true);
  assert.equal(r.changed[0].eol, 'CRLF');
  const out = fs.readFileSync(path.join(d, 'c.txt'), 'utf8');
  assert.ok(!out.split(CR + NL).join('').includes(NL), '不该混进单个 LF');
  assert.ok(out.includes(CR + NL + 'line two!(改了)'));
});

test('多 op 原子：第二个失败第一个也不落盘', () => {
  const d = tmp();
  const before = fs.readFileSync(path.join(d, 'a.mjs'), 'utf8');
  const r = runEdits({ ops: [
    { file: 'a.mjs', find: 'const x = 1;', replace: 'const x = 111;' },
    { file: 'a.mjs', find: '不存在的标记', replace: 'x' },
  ] }, { cwd: d });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'atomic-abort');
  assert.equal(fs.readFileSync(path.join(d, 'a.mjs'), 'utf8'), before);
});

test('改完语法红了整批回滚（靠这条救命两次）', () => {
  const d = tmp();
  const before = fs.readFileSync(path.join(d, 'a.mjs'), 'utf8');
  const r = runEdits({ ops: [{ file: 'a.mjs', find: 'const y = 2;', replace: 'const y = ;' }] }, { cwd: d, check: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'syntax-after-edit');
  assert.equal(r.rolledBack, true);
  assert.equal(fs.readFileSync(path.join(d, 'a.mjs'), 'utf8'), before, '逐字节回到改前');
});

test('dry-run 不写盘也不校验语法', () => {
  const d = tmp();
  const before = fs.readFileSync(path.join(d, 'a.mjs'), 'utf8');
  const r = runEdits({ ops: [{ file: 'a.mjs', find: 'const y = 2;', replace: 'const y = ;' }] }, { cwd: d, dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(fs.readFileSync(path.join(d, 'a.mjs'), 'utf8'), before);
});

test('validateSpec 拦越界路径与空指令', () => {
  assert.equal(validateSpec({}).ok, false);
  assert.equal(validateSpec({ ops: [] }).ok, false);
  assert.equal(validateSpec({ ops: [{ file: '../x.mjs', find: 'a', replace: 'b' }] }).reason, 'op[0].file-outside');
  assert.equal(validateSpec({ ops: [{ file: 'a.mjs', find: 'a', replace: 'b' }] }).ok, true);
});

test('applyOne 对未知 kind 给出机器码而不是崩', () => {
  const r = applyOne('x', { file: 'a.mjs', kind: 'rewrite-everything' });
  assert.equal(r.ok, false);
  assert.ok(r.reason.startsWith('unknown-kind:'));
});

test('记账落 .atw/edits.jsonl：谁改的、改在第几行', () => {
  const d = tmp();
  const r = runEdits({ ops: [{ file: 'a.mjs', find: 'const x = 1;', replace: 'const x = 7;' }] }, { cwd: d });
  const p = logEdits(d, r, { by: 'test-agent' });
  assert.ok(p && fs.existsSync(p));
  const line = JSON.parse(fs.readFileSync(p, 'utf8').trim().split(NL).pop());
  assert.equal(line.by, 'test-agent');
  assert.equal(line.file, 'a.mjs');
  assert.equal(line.line, 1);
});

test('formatEdit 失败时说清「未落盘」，成功时报 EOL', () => {
  const bad = formatEdit({ ok: false, reason: 'atomic-abort', results: [{ file: 'a.mjs', ok: false, reason: 'not-found' }] });
  assert.ok(bad.includes('整批没写'));
  assert.ok(bad.includes('not-found'));
  const good = formatEdit({ ok: true, results: [{ file: 'a.mjs', ok: true, line: 1, delta: 1 }], changed: [{ file: 'a.mjs', eol: 'LF' }] });
  assert.ok(good.includes('改完了'));
  assert.ok(good.includes('LF'));
});