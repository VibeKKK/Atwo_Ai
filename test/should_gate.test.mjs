import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shouldDelegate, formatShould, HOT_FILES } from '../lib/should.mjs';
import { runGate, formatGate } from '../lib/gate.mjs';

// 为什么要这些断言：should/gate 是「让工具自己开口」的两条腿。
// 它们错了不会崩，只会让 AI 悄悄退回「自己干」—— 静默失效，所以必须钉死方向。

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ATWO = path.join(ROOT, 'atwo.mjs');
const cli = (args) => spawnSync(process.execPath, [ATWO, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });

let pass = 0, fail = 0;
const cases = [];
const it = (n, f) => cases.push([n, f]);

// ── should ───────────────────────────────────────────────────────────────
it('批量 + 机械 → 派', () => {
  const r = shouldDelegate('把 lib/ 下 12 个文件的 import 统一改成 ESM 写法');
  assert.equal(r.verdict, 'delegate');
  assert.ok(r.score >= 3);
});

it('判断类 → 自己干（判定权不外借）', () => {
  for (const t of ['评估一下 atwo 的审查机制值几分', '该不该把 vm/ 提进 git', '权衡一下两种方案']) {
    assert.equal(shouldDelegate(t).verdict, 'self', t);
  }
});

it('热点文件命中的改动 → 自己干，且「加一个分支」不算批量', () => {
  const r = shouldDelegate('改 atwo.mjs 的 dispatch 加一个分支');
  assert.equal(r.verdict, 'self');
  assert.ok(r.signals.some((s) => s.key === 'hot-file'));
  assert.ok(!r.signals.some((s) => s.key === 'multi'), '「一个」被当成多份了');
});

it('依赖我脑里上下文 → 自己干', () => {
  const r = shouldDelegate('帮我看看刚才那个 fanout 为什么卡住');
  assert.equal(r.verdict, 'self');
  assert.ok(r.signals.some((s) => s.key === 'needs-context'));
});

it('veto 优先：提交 / 强推 / 删库 / 改契约一律不派，且不看分', () => {
  for (const t of ['git commit 一下这些改动', 'git push --force', 'rm -rf _probe', '改一下 authority.json']) {
    const r = shouldDelegate(t + ' 20 个文件 独立 批量');
    assert.equal(r.verdict, 'self', t);
    assert.equal(r.score, -99, t);
    assert.ok(r.vetoed.length >= 1, t);
    assert.equal(r.est, null);
  }
});

it('每条判据都能指出是哪个词触发的（不许黑箱打分）', () => {
  const r = shouldDelegate('3 个仓库分别调研它们的 CI 配置');
  assert.equal(r.verdict, 'delegate');
  for (const s of r.signals) {
    assert.ok(s.evidence && s.evidence.length, JSON.stringify(s));
    assert.ok(s.why && s.why.length > 6, JSON.stringify(s));
    assert.ok([-3, -2, 2, 3].includes(s.weight), JSON.stringify(s));
  }
});

it('只有 delegate 才估代价，且代价里有最坏情况', () => {
  const d = shouldDelegate('把 20 个测试文件里的 assert.ok 统一改成 assert.equal');
  assert.equal(d.verdict, 'delegate');
  assert.ok(d.est && d.est.totalSec > 0 && d.est.worstCaseSec > d.est.totalSec);
  const s = shouldDelegate('评估 atwo');
  assert.equal(s.est, null);
});

it('空输入不抛错，判 self', () => {
  for (const v of ['', null, undefined]) {
    const r = shouldDelegate(v);
    assert.equal(r.verdict, 'self');
  }
});

it('同输入两次结果完全一致（可复算，不是随机）', () => {
  const a = shouldDelegate('把 lib/ 下 12 个文件的 import 统一改成 ESM');
  const b = shouldDelegate('把 lib/ 下 12 个文件的 import 统一改成 ESM');
  assert.deepEqual(a, b);
  assert.equal(a.contract, 'atwo-should/1');
});

it('人读版给出结论 + 判据 + 代价，不是一句话营销', () => {
  const out = formatShould(shouldDelegate('把 lib/ 下 12 个文件的 import 统一改成 ESM 写法'));
  assert.match(out, /结论/);
  assert.match(out, /判据/);
  assert.match(out, /代价/);
});

it('hotFiles 可注入（别的仓库有自己的热点表）', () => {
  const r = shouldDelegate('改 src/main.ts 的一个函数', { hotFiles: ['src/main.ts'] });
  assert.equal(r.verdict, 'self');
  assert.ok(HOT_FILES.includes('atwo.mjs'));
});

// ── gate ─────────────────────────────────────────────────────────────────
it('gate 结构稳定：契约 / 每步可判 / 失败清单 / 下一步', () => {
  const r = runGate({ skipTests: true });
  assert.equal(r.contract, 'atwo-gate/1');
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(r.steps.length >= 5);
  for (const s of r.steps) {
    assert.equal(typeof s.name, 'string');
    assert.equal(typeof s.ok, 'boolean');
    assert.equal(typeof s.ms, 'number');
  }
  assert.ok(Array.isArray(r.failed));
  assert.ok(r.next.length > 4);
});

it('当前仓库：运行闭包与契约必须过（否则这仓库已经坏了）', () => {
  const r = runGate({ skipTests: true });
  const by = Object.fromEntries(r.steps.map((s) => [s.name, s]));
  assert.equal(by.closure.ok, true, by.closure.detail);
  assert.equal(by.contract.ok, true, by.contract.detail);
  assert.equal(by.syntax.ok, true, by.syntax.detail);
});

it('没给文件时 accept 是 skip，不是假通过', () => {
  const r = runGate({ skipTests: true });
  const acc = r.steps.find((s) => s.name === 'accept');
  assert.equal(acc.skip, true);
});

it('嵌套调用跳过回归（闸门在测试里被调不能无限递归）', () => {
  const old = process.env.ATWO_GATE_NESTED;
  process.env.ATWO_GATE_NESTED = '1';
  try {
    const r = runGate({});
    const t = r.steps.find((s) => s.name === 'tests');
    assert.equal(t.skip, true);
    assert.equal(r.nested, true);
  } finally {
    if (old === undefined) delete process.env.ATWO_GATE_NESTED; else process.env.ATWO_GATE_NESTED = old;
  }
});

it('语法层真能抓坏文件（给它一个坏 .mjs 必须红）', () => {
  const bad = path.join(os.tmpdir(), 'atwo-gate-bad-' + Date.now() + '.mjs');
  fs.writeFileSync(bad, 'const x = ;\n');
  try {
    const r = runGate({ skipTests: true, files: [bad, 'lib/should.mjs'] });
    const syn = r.steps.find((s) => s.name === 'syntax');
    assert.equal(syn.ok, false, '坏文件没被抓到');
    assert.equal(r.ok, false);
    assert.ok(r.failed.includes('syntax'));
  } finally { fs.unlinkSync(bad); }
});

it('人读版一行结论 + 每步耗时 + 下一步', () => {
  const out = formatGate(runGate({ skipTests: true }));
  assert.match(out, /闸门/);
  assert.match(out, /closure/);
  assert.match(out, /可以提交|先修/);
});

// ── CLI ──────────────────────────────────────────────────────────────────
it('atwo should 无参 → 退出 2，并说明没派活', () => {
  const r = cli(['should']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /没有派活/);
});

it('atwo should --json 是合法 JSON 且带 verdict', () => {
  const r = cli(['should', '把 lib/ 下 12 个文件的 import 统一改成 ESM', '--json']);
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.data.verdict, 'delegate');
  assert.equal(j.data.contract, 'atwo-should/1');
});

it('atwo gate --no-tests 能跑到终态（0 或 4 都算跑通）', () => {
  const r = cli(['gate', '--no-tests']);
  // 退出码 4 是「跑成了、结论是红」，不是崩。这个工作区可能同时有别人在改文件，
  // 所以「整体绿」不能当这条测试的判据（2026-11-16 起它抖了三次假红，全是并发编辑）。
  // 真正「这个仓库干净 checkout 是绿的」由 CI 与收工前的 node test/all.mjs 断言
  // （污染检测默认就判失败，--no-strict 才降级为只报告）。
  assert.ok([0, 4].includes(r.status), '退出码 ' + r.status + '：' + r.stdout + r.stderr);
  assert.match(r.stdout, /闸门/);
});

it('caps 里有 should 与 gate，代价标对（should 不花钱，gate 真跑测试）', () => {
  const r = cli(['caps', '--json']);
  const j = JSON.parse(r.stdout);
  const caps = j.data && j.data.verbs ? j.data.verbs : j.data;
  assert.ok(caps.should && caps.gate, 'caps 缺动词');
  const cost = (v) => caps[v].cost || (caps[v].spec && caps[v].spec.cost);
  assert.equal(cost('should'), 'none');
  // gate 会真跑 test/all.mjs —— 必须标成「有代价」，标 none 等于骗 AI 免费
  assert.notEqual(cost('gate'), 'none');
});

for (const [name, fn] of cases) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
