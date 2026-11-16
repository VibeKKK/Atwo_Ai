import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectEnvironment, quickSelfCheck, closureOf } from '../lib/bootstrap.mjs';

// 为什么单独建这个测试：atwo 的目标形态是「扔到另一台机器上，那个 AI 自己觉得好用」。
// 陌生 AI 的第一屏就是裸命令、doctor、try —— 这三样坏了，后面做得再好也没人看见。
// 所以它们必须是机器可判的，不是「看着还行」。

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ATWO = path.join(ROOT, 'atwo.mjs');

function run(args) {
  return spawnSync(process.execPath, [ATWO, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
}

let pass = 0, fail = 0;
const cases = [];
function it(n, f) { cases.push([n, f]); }

it('裸命令不是 usage，是「这台机器现在能干什么 + 下一步三个动作」', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /现在能做/);
  assert.match(r.stdout, /下一步/);
  assert.match(r.stdout, /atwo try/);
  assert.ok(!/^用法：/m.test(r.stdout), '裸命令不该退回 usage');
});

it('doctor 说清楚通道在不在，并给出每个缺失项怎么补', () => {
  const r = run(['doctor']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /通道/);
  assert.match(r.stdout, /codebuddy/);
});

it('doctor --json 有稳定的契约字段（陌生 AI 走这条，不解析中文）', () => {
  const r = run(['doctor', '--json']);
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.data.doctor.contract, 'atwo-doctor/1');
  assert.ok(Array.isArray(j.data.doctor.channelUp));
  assert.ok(Array.isArray(j.data.doctor.can));
  assert.equal(typeof j.data.doctor.ollama.ok, 'boolean');
});

it('try 2 秒内给出三连结果，且退出 0', () => {
  const r = run(['try']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /自检三连/);
  assert.match(r.stdout, /运行闭包/);
  assert.match(r.stdout, /三值判定/);
  assert.match(r.stdout, /并发上限/);
});

it('try --json 的每一步都可机器判', () => {
  const r = run(['try', '--json']);
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.data.try.contract, 'atwo-try/1');
  assert.equal(j.data.try.ok, true);
  assert.equal(j.data.try.steps.length, 3);
  for (const s of j.data.try.steps) {
    assert.equal(typeof s.ok, 'boolean');
    assert.equal(typeof s.detail, 'string');
  }
});

it('自检里的三值闸门是真断言：同值 9 个必须判不出', async () => {
  const r = await quickSelfCheck({ cwd: ROOT });
  const gate = r.steps.find((s) => s.name === '三值判定');
  assert.equal(gate.ok, true);
  assert.match(gate.detail, /-1/);
});

it('闭包检查能抓到缺失文件（否则它在陌生机器上等于瞎）', () => {
  const c = closureOf(path.join(ROOT, 'atwo.mjs'));
  assert.ok(c.files.length >= 20);
  assert.equal(c.missing.length, 0);
  const bad = closureOf(path.join(ROOT, '__not_exist__.mjs'));
  assert.equal(bad.missing.length, 1);
});

it('探测不启动任何客户端：doctor 必须秒回（真拉 GUI 会 >2s）', () => {
  const t0 = Date.now();
  const r = run(['doctor']);
  const ms = Date.now() - t0;
  assert.equal(r.status, 0);
  assert.ok(!/正在连接|spawn |ENOENT/.test(r.stdout), 'doctor 不该尝试连接通道');
  assert.ok(ms < 5000, 'doctor 花了 ' + ms + 'ms —— 大概率在启动客户端');
});

it('try 与 caps 里的 doctor/try 一致：动词表是唯一真源', () => {
  const r = run(['caps', '--json']);
  const j = JSON.parse(r.stdout);
  const verbs = (j.data && j.data.verbs) || j.data || {};
  const names = Object.keys(verbs);
  assert.ok(names.includes('doctor'), 'caps 里没有 doctor');
  assert.ok(names.includes('try'), 'caps 里没有 try');
});

for (const [name, fn] of cases) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
