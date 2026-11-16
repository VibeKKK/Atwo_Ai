// atwo 的「机器可读出口」验收（2026-11-16）。
//
// 操作者换成 AI 之后，唯一不能靠猜的两件事：退出码、stdout 是不是合法 JSON。
// 这个测试只钉这两条，外加「人话不许丢」——否则人回来看不懂日志了。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ATWO = path.join(ROOT, 'atwo.mjs');

let n = 0;
function ok(name, fn) {
  fn();
  n++;
  console.log('  ✓ ' + name);
}

function run(args) {
  const r = spawnSync(process.execPath, [ATWO, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function runJson(args) {
  const r = run(args);
  let json = null;
  try { json = JSON.parse(r.out); } catch { /* 留空，下面断言会报 */ }
  return { code: r.code, json, raw: r.out };
}

// ── 退出码表：0 成功 / 2 用法错 ──
ok('state --json 退出码 0 且是合法 JSON', () => {
  const r = runJson(['state', '--json']);
  assert.equal(r.code, 0);
  assert.ok(r.json, 'stdout 不是合法 JSON：' + r.raw.slice(0, 200));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.verb, 'state');
  assert.equal(r.json.exitCode, 0);
});

ok('不认识的动词 → 退出码 2，JSON 里 ok=false', () => {
  const r = runJson(['nosuchverb', '--json']);
  assert.equal(r.code, 2);
  assert.ok(r.json);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.exitCode, 2);
});

ok('check 缺参数 → 退出码 2', () => {
  assert.equal(run(['check']).code, 2);
});

ok('done 不带确认 → 退出码 2（不许不问就结）', () => {
  assert.equal(run(['done']).code, 2);
});

ok('done --json 也遵守同一张码表', () => {
  const r = runJson(['done', '--json']);
  assert.equal(r.code, 2);
  assert.equal(r.json.exitCode, 2);
  assert.equal(r.json.ok, false);
});

// ── 结构化数据：state 不能给空 data，否则调用方只能去正则 log ──
ok('state --json 的 data 有任务字段', () => {
  const r = runJson(['state', '--json']);
  const d = r.json.data || {};
  assert.ok(Object.keys(d).length > 0, 'data 是空的');
  // 任务表非空时必须有这四个，为空时至少要有 tasks 数组
  if (Array.isArray(d.tasks)) return;
  for (const k of ['task', 'title', 'status', 'mode']) assert.ok(k in d, '缺字段 ' + k);
});

// ── 人话不许丢：log 字段里得有人看得懂的话 ──
ok('JSON 里保留人话（log 非空且含中文）', () => {
  const r = runJson(['state', '--json']);
  assert.ok(r.json.log.length > 10, 'log 太短');
  assert.match(r.json.log, /[\u4e00-\u9fa5]/);
});

// ── 不带 --json 时，stdout 必须还是人话（不能因为加了出口就把人挡在外面）──
ok('不带 --json 时 stdout 是人话，不是 JSON', () => {
  const r = run(['state']);
  assert.equal(r.code, 0);
  assert.throws(() => JSON.parse(r.out), /./, '不带 --json 竟然吐了 JSON');
  assert.match(r.out, /[\u4e00-\u9fa5]/);
});

console.log('\n' + n + ' 项通过');
