// 收件箱的账本：结果不能被覆盖，撞名不能静默，换了任务不该继续背旧失败。
// 三条都是 2026-11-18 对着真实 .atw/inbox 抓出来的，不是设想。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { drainOnce, formatDrain, inboxDir, attemptsOf, taskHash, MAX_ATTEMPTS, SUFFIX } from '../lib/inbox.mjs';

let pass = 0; let fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ✓ ' + name); },
    (e) => { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); },
  );
}
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-ledger-'));
  fs.mkdirSync(path.join(dir, '.atw', 'inbox'), { recursive: true });
  return dir;
}
function drop(dir, id, spec) {
  fs.writeFileSync(path.join(inboxDir(dir), id + SUFFIX), JSON.stringify(spec), 'utf8');
}
function ls(dir, bucket) {
  const p = path.join(inboxDir(dir), bucket);
  return fs.existsSync(p) ? fs.readdirSync(p).sort() : [];
}

console.log('atwo drain · 账本（结果留档 / 撞名留痕 / 换任务重置）');

await test('先成功后失败 → 两份 result 各自留档，history 两条都在', async () => {
  const d = sandbox();
  drop(d, 'k1', { task: '往 README 加一行' });
  await drainOnce({ cwd: d, handlers: { patch: async () => ({ ok: true, patchPaths: ['.atw/patches/a.patch'], applied: false }) } });
  drop(d, 'k1', { task: '降级复验', lane: 'codebuddy' });
  await drainOnce({ cwd: d, handlers: { patch: async () => ({ ok: false, reason: 'Max turns exceeded' }) } });

  assert.ok(ls(d, 'done').includes('k1.result.json'), 'done/ 里必须有成功那次的结论：' + ls(d, 'done'));
  assert.ok(ls(d, 'failed').includes('k1.result.json'), 'failed/ 里必须有失败那次的结论：' + ls(d, 'failed'));

  const doneRes = JSON.parse(fs.readFileSync(path.join(inboxDir(d), 'done', 'k1.result.json'), 'utf8'));
  assert.equal(doneRes.ok, true, 'done/ 那份必须记着成功');
  assert.equal(doneRes.detail.applied, false, '成功 ≠ 已生效，必须带 applied:false');

  const failedRes = JSON.parse(fs.readFileSync(path.join(inboxDir(d), 'failed', 'k1.result.json'), 'utf8'));
  assert.equal(failedRes.ok, false);

  const hist = fs.readFileSync(path.join(inboxDir(d), 'history.jsonl'), 'utf8').trim().split(String.fromCharCode(10));
  assert.equal(hist.length, 2, '两次都要进账本，不能被覆盖：' + hist.length);
  fs.rmSync(d, { recursive: true, force: true });
});

await test('同桶同 id 再来一次 → 旧结论改名留档，不丢', async () => {
  const d = sandbox();
  for (const r of ['第一次', '第二次']) {
    drop(d, 'k2', { task: 'x' });
    await drainOnce({ cwd: d, handlers: { patch: async () => ({ ok: false, reason: r }) } });
  }
  const files = ls(d, 'failed');
  assert.ok(files.includes('k2.result.json'), '要有最新那份：' + files);
  assert.ok(files.some((f) => /^k2@[\dT-]+(-\d+)?\.result\.json$/.test(f)), '旧结论要改名留档：' + files);
  const hist = fs.readFileSync(path.join(inboxDir(d), 'history.jsonl'), 'utf8').trim().split(String.fromCharCode(10));
  assert.equal(hist.length, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

await test('撞名归档 → 两份 task 都留下，且记账里有 collided', async () => {
  const d = sandbox();
  drop(d, 'k3', { task: '前一版' });
  await drainOnce({ cwd: d, handlers: { patch: async () => ({ ok: true }) } });
  drop(d, 'k3', { task: '后一版' });
  const r = await drainOnce({ cwd: d, handlers: { patch: async () => ({ ok: true }) } });

  const files = ls(d, 'done');
  assert.ok(files.includes('k3' + SUFFIX), '第一份在：' + files);
  assert.ok(files.some((f) => /^k3@\d+/.test(f)), '第二份改名留档，不许被吞：' + files);
  assert.equal(r.processed[0].collided.length, 1, '撞名事实必须回传：' + JSON.stringify(r.processed[0].collided));
  assert.ok(/撞名留档/.test(formatDrain(r)), '人看得见的输出也要写：' + formatDrain(r));
  fs.rmSync(d, { recursive: true, force: true });
});

await test('同 id 换任务 → 旧失败不再算数（不背着 4 次失败降级）', async () => {
  const d = sandbox();
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    drop(d, 'k4', { task: '旧任务' });
    await drainOnce({ cwd: d, handlers: { patch: async () => ({ ok: false, reason: 'red' }) } });
  }
  assert.ok(attemptsOf(d, 'k4') >= MAX_ATTEMPTS, '旧任务确实堆到阈值了');
  assert.equal(attemptsOf(d, 'k4', taskHash({ task: '新任务' })), 0, '换了任务就该从 0 开始');

  let seen = null;
  drop(d, 'k4', { task: '新任务' });
  await drainOnce({ cwd: d, handlers: { patch: async (spec) => { seen = spec; return { ok: false, reason: 'red' }; } } });
  assert.equal(seen.asReport, undefined, '新任务第一次不许降级：' + JSON.stringify(seen));
  fs.rmSync(d, { recursive: true, force: true });
});

await test('taskHash 只认任务内容，不看无关字段', () => {
  assert.equal(taskHash({ task: 'a' }), taskHash({ task: 'a', timeoutMs: 1 }));
  assert.notEqual(taskHash({ task: 'a' }), taskHash({ task: 'b' }));
  assert.notEqual(taskHash({ task: 'a', lane: 'trae' }), taskHash({ task: 'a', lane: 'codebuddy' }));
});

await test('源码守卫：archive 不许再是空 catch', () => {
  const src = fs.readFileSync(new URL('../lib/inbox.mjs', import.meta.url), 'utf8');
  assert.ok(/collided\.push/.test(src), '撞名必须记账');
  assert.ok(/history\.jsonl/.test(src), '账本必须存在');
  assert.ok(!/catch \{ \/\* 撞名就留在原地/.test(src), '旧静默注释必须消失');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);