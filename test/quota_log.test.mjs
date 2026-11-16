// 额度账本落盘 + atwo 派活收尾接线的验收（对应 task.md 的 10 条行为用例）。
// 纯函数部分直接 import；接线部分用「假 orchestra + 临时任务目录」跑，不烧额度、不碰界面。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quotaRecord, appendQuota, readQuota } from '../lib/quota-log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ATWO = path.join(ROOT, 'atwo.mjs');

let pass = 0;
const bad = [];
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) {
    bad.push(name);
    console.log('  ✗ ' + name + '  ← ' + (e && e.message ? e.message : String(e)));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-log-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉也不影响结论 */ } });

// ── 1) 已知模型：倍率来自 quota-ledger，积分 = 倍率 × 100 ──
ok('1  trae/DeepSeek-V4.1-Flash → 0.11 × 100 = 11', () => {
  const rec = quotaRecord({ agent: 'trae', model: 'DeepSeek-V4.1-Flash', ok: true, elapsedMs: 1234, now: '2026-11-16T00:00:00.000Z' });
  assert.deepEqual(rec, {
    kind: 'quota', time: '2026-11-16T00:00:00.000Z', agent: 'trae', model: 'DeepSeek-V4.1-Flash',
    multiplier: 0.11, points: 11, ok: true, elapsedMs: 1234,
  });
});

// ── 2) Hy3 是 0 倍率 ──
ok('2  Hy3 → multiplier=0 / points=0', () => {
  const rec = quotaRecord({ agent: 'workbuddy', model: 'Hy3', ok: true, elapsedMs: 1, now: '2026-11-16T00:00:00.000Z' });
  assert.equal(rec.multiplier, 0);
  assert.equal(rec.points, 0);
});

// ── 3) 未知模型按 1 倍基准价 ──
ok('3  未知模型 → multiplier=1 / points=100', () => {
  const rec = quotaRecord({ agent: 'trae', model: '不存在的模型', ok: true, elapsedMs: 1, now: '2026-11-16T00:00:00.000Z' });
  assert.equal(rec.multiplier, 1);
  assert.equal(rec.points, 100);
});

// ── 4) ok 必须是严格布尔 ──
ok("4  ok:'true'（字符串）→ ok === false", () => {
  const rec = quotaRecord({ agent: 'trae', model: 'Hy3', ok: 'true', elapsedMs: 1, now: '2026-11-16T00:00:00.000Z' });
  assert.equal(rec.ok, false);
});

// ── 5) 非法耗时归零 ──
ok('5  elapsedMs:-5 / 非数字 → 0', () => {
  assert.equal(quotaRecord({ agent: 'trae', model: 'Hy3', ok: true, elapsedMs: -5 }).elapsedMs, 0);
  assert.equal(quotaRecord({ agent: 'trae', model: 'Hy3', ok: true, elapsedMs: '123' }).elapsedMs, 0);
});

// ── 6) 目录不存在就建，文件里正好一行合法 JSON ──
ok('6  appendQuota 自动建目录 + 一行合法 JSON', () => {
  const file = path.join(tmp, 'a', 'b', 'log.jsonl');
  const rec = quotaRecord({ agent: 'codebuddy', model: 'codebuddy', ok: true, elapsedMs: 9, now: '2026-11-16T00:00:00.000Z' });
  const r = appendQuota(file, rec);
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(file), '文件没建出来：' + file);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).kind, 'quota');
});

// ── 7) 连续三次 → 正好三行，每行都能 parse ──
ok('7  连续 appendQuota 三次 → 三行且都可 JSON.parse', () => {
  const file = path.join(tmp, 'three.jsonl');
  for (let i = 0; i < 3; i++) {
    appendQuota(file, quotaRecord({ agent: 'codebuddy', model: 'codebuddy', ok: i % 2 === 0, elapsedMs: i * 10 }));
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
});

// ── 8) 坏行跳过不抛 ──
ok('8  readQuota 跳过坏行、不抛异常', () => {
  const file = path.join(tmp, 'broken.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ kind: 'quota', points: 1 }),
    '{坏',
    JSON.stringify({ kind: 'quota', points: 2 }),
    '',
  ].join('\n'), 'utf8');
  const got = readQuota(file);
  assert.equal(got.length, 2);
  assert.equal(got[0].points, 1);
  assert.equal(got[1].points, 2);
});

// ── 9/10 的公共布景：假 orchestra + 临时任务目录 ──
function stage(name) {
  const base = path.join(tmp, name);
  const tasksDir = path.join(base, 'tasks');
  const taskId = '11-16-atwo-quota-test';
  const taskDir = path.join(tasksDir, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const prd = path.join(taskDir, 'prd.md');
  fs.writeFileSync(prd, '# 额度账本接线自检\n\n只用来验证接线，不会真的派活。\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({
    id: taskId, name: taskId, title: '额度账本接线自检', status: 'implement',
    size: 'S', relatedFiles: [], createdAtMs: 1,
  }, null, 2) + '\n', 'utf8');
  const orch = path.join(base, 'fake-orchestra.mjs');
  // 只打一行报告头：atwo 靠它认通道与耗时（与真 orchestra 的 renderReport 同形）
  fs.writeFileSync(orch, "console.log('## #1  ✓  codebuddy  120ms');\n", 'utf8');
  const modeFile = path.join(base, 'mode.json');
  fs.writeFileSync(modeFile, JSON.stringify({ mode: 'strict', since: '2026-11-16T00:00:00.000Z', by: 'test' }) + '\n', 'utf8');
  return { base, tasksDir, prd, orch, modeFile };
}

function runGo(s, logFile, extraArgs = []) {
  const r = spawnSync(process.execPath, [ATWO, 'go', s.prd, ...extraArgs], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: {
      ...process.env,
      ATWO_ORCH: s.orch,
      ATWO_TASKS_DIR: s.tasksDir,
      ATWO_MODE_FILE: s.modeFile,
      ATWO_LOG: logFile,
    },
  });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// ── 9) --json 的 data.quota 是数组且每条含 kind/points ──
ok('9  atwo go --json → data.quota 非空、含 kind 与 points', () => {
  const s = stage('json');
  const logFile = path.join(s.base, 'log.jsonl');
  const r = runGo(s, logFile, ['--json', '--size', 'S']);
  let json = null;
  try { json = JSON.parse(r.out); } catch { /* 下面断言会报 */ }
  assert.ok(json, 'stdout 不是合法 JSON：' + r.out.slice(0, 200));
  const quota = json.data && json.data.quota;
  assert.ok(Array.isArray(quota) && quota.length > 0, 'data.quota 不是非空数组：' + JSON.stringify(quota));
  for (const rec of quota) {
    assert.equal(rec.kind, 'quota');
    assert.equal(typeof rec.points, 'number');
    assert.equal(typeof rec.ok, 'boolean');
    assert.ok(rec.time);
  }
  // 同时真落了盘：一行一条
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, quota.length);
  assert.equal(JSON.parse(lines[0]).kind, 'quota');
  // 报告头里的 120ms 要被认出来，不能一律写 0
  assert.equal(quota[0].elapsedMs, 120);
  assert.equal(quota[0].ok, true);
});

// ── 10) 账本不可写（log.jsonl 是目录）→ 派活照常完成，只多一行失败提示 ──
ok('10 记忆日志不可写 → 派活完成，只多一行「! 额度账本写入失败」', () => {
  const s = stage('blocked');
  const logFile = path.join(s.base, 'blocked', 'log.jsonl');
  fs.mkdirSync(logFile, { recursive: true });
  const r = runGo(s, logFile, ['--size', 'S']);
  const all = r.out + r.err;
  assert.equal(r.code, 0, '派活被账本拖垮了，退出码 ' + r.code + '：' + all.slice(0, 300));
  const hits = all.split('\n').filter((l) => l.includes('! 额度账本写入失败')).length;
  assert.equal(hits, 1, '失败提示应正好一行，实际 ' + hits + ' 行');
});

console.log('');
console.log((bad.length ? 'quota-log FAILED: ' : 'quota-log: ') + pass + ' passed / ' + bad.length + ' failed');
if (bad.length) {
  console.log(bad.map((x) => '  - ' + x).join('\n'));
  process.exit(1);
}
