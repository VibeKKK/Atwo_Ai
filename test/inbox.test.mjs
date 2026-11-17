// 无人值守的第一块：任务源外移。测的是「没人盯着也会推进，且失败不会静默」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listInbox, claimTask, writeResult, archive, drainOnce, formatDrain, inboxDir, INBOX_CONTRACT, KINDS } from '../lib/inbox.mjs';

let pass = 0; let fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ✓ ' + name); },
    (e) => { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); },
  );
}
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
  fs.mkdirSync(path.join(dir, '.atw', 'inbox'), { recursive: true });
  return dir;
}
function drop(dir, id, spec) {
  fs.writeFileSync(path.join(inboxDir(dir), id + '.task.json'), JSON.stringify(spec), 'utf8');
}

console.log('atwo drain · 文件收件箱');

await test('空收件箱 → 0 条，不报错', () => {
  const d = sandbox();
  const r = listInbox(d);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

await test('合法任务被认出（kind 缺省 = patch）', () => {
  const d = sandbox();
  drop(d, 'a', { task: '改点东西' });
  const r = listInbox(d);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].ok, true);
  assert.equal(r.entries[0].spec.kind, 'patch');
  fs.rmSync(d, { recursive: true, force: true });
});

await test('三种坏任务都被标出来，不会被当成待办执行', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(inboxDir(d), 'bad.task.json'), '{oops', 'utf8');
  drop(d, 'kind', { task: 'x', kind: 'rm-rf' });
  drop(d, 'empty', { task: '   ' });
  const r = listInbox(d);
  const why = r.entries.map((e) => e.reason);
  assert.ok(why.some((x) => /bad-json/.test(x)), 'JSON 坏了要能说');
  assert.ok(why.some((x) => /unknown-kind/.test(x)));
  assert.ok(why.some((x) => /empty-task/.test(x)));
  assert.ok(r.entries.every((e) => !e.ok));
  fs.rmSync(d, { recursive: true, force: true });
});

await test('认领是 rename：第二次认领必须失败（防两个 drain 抢同一条）', () => {
  const d = sandbox();
  drop(d, 'x', { task: 't' });
  const entry = listInbox(d).entries[0];
  assert.equal(claimTask(entry).ok, true);
  assert.equal(fs.existsSync(entry.file), false, '原文件应该已经不在了');
  assert.equal(claimTask(entry).ok, false, '第二次必须失败');
  fs.rmSync(d, { recursive: true, force: true });
});

await test('成功 → 归档到 done/ 且留下 result', async () => {
  const d = sandbox();
  drop(d, 'ok1', { task: '干这个' });
  const r = await drainOnce({ cwd: d, handlers: { patch: async () => ({ ok: true, patchPaths: ['/tmp/p.patch'] }) } });
  assert.equal(r.ok, true);
  assert.equal(r.processed.length, 1);
  assert.ok(fs.existsSync(path.join(inboxDir(d), 'done', 'ok1.task.json')), '原任务要挪进 done/');
  const res = JSON.parse(fs.readFileSync(path.join(inboxDir(d), 'ok1.result.json'), 'utf8'));
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'patch');
  assert.equal(res.contract, INBOX_CONTRACT);
  fs.rmSync(d, { recursive: true, force: true });
});

await test('handler 抛错 → failed/ 且 reason 写清（不许把整轮打死）', async () => {
  const d = sandbox();
  drop(d, 'boom', { task: 'x' });
  drop(d, 'fine', { task: 'y' });
  const r = await drainOnce({ cwd: d, handlers: { patch: async () => { throw new Error('子会话超时'); } } });
  assert.equal(r.processed.length, 2, '一条炸了另一条还要继续');
  assert.equal(r.processed[0].ok, false);
  assert.match(r.processed[0].reason, /exception: 子会话超时/);
  assert.ok(fs.existsSync(path.join(inboxDir(d), 'failed', 'boom.task.json')));
  fs.rmSync(d, { recursive: true, force: true });
});

await test('没有对应 handler → 明确说 no-handler，不假装成功', async () => {
  const d = sandbox();
  drop(d, 'g', { task: '跑闸门', kind: 'gate' });
  const r = await drainOnce({ cwd: d, handlers: {} });
  assert.equal(r.ok, false);
  assert.match(r.processed[0].reason, /no-handler: gate/);
  fs.rmSync(d, { recursive: true, force: true });
});

await test('坏任务文件不被执行，但也不会每轮都留着（直接进 failed/）', async () => {
  const d = sandbox();
  fs.writeFileSync(path.join(inboxDir(d), 'junk.task.json'), 'not json', 'utf8');
  let called = 0;
  const r = await drainOnce({ cwd: d, handlers: { patch: async () => { called++; return { ok: true }; } } });
  assert.equal(called, 0, '坏任务绝不能进 handler');
  assert.equal(r.skipped.length, 1);
  assert.ok(fs.existsSync(path.join(inboxDir(d), 'failed', 'junk.task.json')));
  fs.rmSync(d, { recursive: true, force: true });
});

await test('--limit 生效，剩下的数着报出来', async () => {
  const d = sandbox();
  for (const id of ['a', 'b', 'c']) drop(d, id, { task: id });
  const r = await drainOnce({ cwd: d, limit: 2, handlers: { patch: async () => ({ ok: true }) } });
  assert.equal(r.processed.length, 2);
  assert.equal(r.remaining, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

await test('formatDrain 在空/成功/失败三种情况下都说人话', () => {
  assert.match(formatDrain({ processed: [], skipped: [], remaining: 0, elapsedMs: 1 }), /收件箱是空的/);
  const ok = formatDrain({ processed: [{ id: 'a', kind: 'patch', ok: true, elapsedMs: 2000, detail: { patchPaths: ['/x.patch'] } }], skipped: [], remaining: 0, elapsedMs: 2000 });
  assert.match(ok, /✓ a \[patch\] 2\.0s/);
  assert.match(ok, /patch：\/x\.patch/);
  const bad = formatDrain({ processed: [{ id: 'b', kind: 'gate', ok: false, reason: 'tests 红', elapsedMs: 500, detail: null }], skipped: [{ id: 'c', reason: 'claim-failed' }], remaining: 0, elapsedMs: 500 });
  assert.match(bad, /✗ b \[gate\].*tests 红/);
  assert.match(bad, /c 跳过/);
});

await test('KINDS 就是那两个，别悄悄扩（新 kind 必须有 handler 才算数）', () => {
  assert.deepEqual(KINDS, ['patch', 'gate']);
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);