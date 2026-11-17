// 失败自愈：同一任务连续失败到阈值就该换招式，而不是无人看管地一遍遍重试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { drainOnce, formatDrain, inboxDir, attemptsOf, MAX_ATTEMPTS } from '../lib/inbox.mjs';

let pass = 0; let fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ✓ ' + name); },
    (e) => { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); },
  );
}
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-degrade-'));
  fs.mkdirSync(path.join(dir, '.atw', 'inbox'), { recursive: true });
  return dir;
}
function drop(dir, id, spec) {
  fs.writeFileSync(path.join(inboxDir(dir), id + '.task.json'), JSON.stringify(spec), 'utf8');
}

console.log('atwo drain · 失败自愈（降级成只报告）');

await test('没跑过 → attemptsOf 是 0', () => {
  const d = sandbox();
  assert.equal(attemptsOf(d, 'nope'), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

await test('失败一次 → result 里 attempts=1，degraded=false', async () => {
  const d = sandbox();
  drop(d, 'f1', { task: '干这个' });
  const r = await drainOnce({ cwd: d, handlers: { patch: async () => ({ ok: false, reason: 'tests-red' }) } });
  assert.equal(r.ok, false);
  const res = JSON.parse(fs.readFileSync(path.join(inboxDir(d), 'f1.result.json'), 'utf8'));
  assert.equal(res.attempts, 1);
  assert.equal(res.degraded, false);
  fs.rmSync(d, { recursive: true, force: true });
});

await test('连续失败到阈值 → handler 收到 asReport 与 failStreak', async () => {
  const d = sandbox();
  let seen = null;
  const handler = async (spec) => {
    seen = spec;
    return { ok: false, reason: 'tests-red' };
  };
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    drop(d, 'f2', { task: '干这个' });
    await drainOnce({ cwd: d, handlers: { patch: handler } });
  }
  assert.equal(seen.asReport, undefined, '前 MAX_ATTEMPTS 次不许降级');
  drop(d, 'f2', { task: '干这个' });
  await drainOnce({ cwd: d, handlers: { patch: handler } });
  assert.equal(seen.asReport, true, '到阈值这一次必须降级');
  assert.equal(seen.failStreak, MAX_ATTEMPTS);
  fs.rmSync(d, { recursive: true, force: true });
});

await test('降级成功 → attempts 清零（下次重新给写权限）', async () => {
  const d = sandbox();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    drop(d, 'f3', { task: 'x' });
    await drainOnce({ cwd: d, handlers: { patch: async () => ({ ok: false, reason: 'red' }) } });
  }
  drop(d, 'f3', { task: 'x' });
  const r = await drainOnce({ cwd: d, handlers: { patch: async () => ({ ok: true, reportPath: '/tmp/r.md' }) } });
  assert.equal(r.ok, true);
  const res = JSON.parse(fs.readFileSync(path.join(inboxDir(d), 'f3.result.json'), 'utf8'));
  assert.equal(res.attempts, 0);
  assert.equal(res.degraded, true, '这一次确实是降级跑的');
  fs.rmSync(d, { recursive: true, force: true });
});

await test('formatDrain 会标出降级，不用翻 result.json 才知道', async () => {
  const d = sandbox();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    drop(d, 'f4', { task: 'x' });
    await drainOnce({ cwd: d, handlers: { patch: async () => ({ ok: false, reason: 'red' }) } });
  }
  drop(d, 'f4', { task: 'x' });
  const r = await drainOnce({ cwd: d, handlers: { patch: async () => ({ ok: false, reason: 'report-only' }) } });
  const txt = formatDrain(r);
  assert.ok(/已降级/.test(txt), '要写明降级：' + txt);
  fs.rmSync(d, { recursive: true, force: true });
});

await test('降级模式真的不给写权限（源码断言：readOnly 走 REPORT_TOOLS）', () => {
  const src = fs.readFileSync(new URL('../lib/writeback.mjs', import.meta.url), 'utf8');
  assert.ok(/REPORT_TOOLS = 'Read,Grep,Glob'/.test(src));
  assert.ok(/tools: readOnly \? REPORT_TOOLS : WRITE_TOOLS/.test(src));
  assert.ok(/permissionMode: readOnly \? undefined : 'bypassPermissions'/.test(src));
  assert.ok(/if \(readOnly\) \{/.test(src), '降级分支必须在 ask 之后立刻返回');
});

await test('inbox-cli 的降级分支会落 report.md', () => {
  const src = fs.readFileSync(new URL('../lib/inbox-cli.mjs', import.meta.url), 'utf8');
  assert.ok(/if \(spec\.asReport\)/.test(src));
  assert.ok(/readOnly: true/.test(src));
  assert.ok(/\.report\.md/.test(src));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);