// test/army.test.mjs —— 三三制阵型（侦察 / 主力 / 评审）：准入、候选标记、票面结算、端到端。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARMY_LIMITS, CANDIDATE, buildArmyReviewPrompt, buildMainTask, buildScoutPrompt, estimateArmy,
  parseScout, pickUnits, renderArmy, renderScout, settleArtifacts, summarizeArmy, validateArmy,
} from '../lib/army.mjs';
import { finishArmy, runArmy } from '../lib/army-run.mjs';
import { takeOpt } from '../lib/fanout-cli.mjs';
import { spawnSync } from 'node:child_process';
import { VERBS } from '../lib/cli-spec.mjs';

let pass = 0, fail = 0;
const cases = [];
function it(name, fn) { cases.push([name, fn]); }

// ── 一 · 准入：三段串行只对批次划算，单任务必须被挡住 ──────────────
it('准入：<2 个单元直接拒（三三制对单任务净亏 72%）', () => {
  const r = validateArmy({ units: ['lib/a.mjs'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'units<2');
  assert.match(r.hint, /fanout/);
});

it('准入：0 个单元给出补单元的写法', () => {
  const r = validateArmy({ units: [] });
  assert.equal(r.ok, false);
  assert.match(r.hint, /--units/);
});

it('准入：>6 个单元要求先拆 PRD（并发拐点）', () => {
  const r = validateArmy({ units: Array.from({ length: 7 }, (_, i) => 'u' + i) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'units>max');
  assert.match(r.hint, /--split/);
});

it('准入：2-6 个单元通过；评审路数越界拒绝', () => {
  assert.equal(validateArmy({ units: ['a', 'b'] }).ok, true);
  assert.equal(validateArmy({ units: ['a', 'b', 'c', 'd', 'e', 'f'] }).ok, true);
  assert.equal(validateArmy({ units: ['a', 'b'], reviewers: 0 }).ok, false);
  assert.equal(validateArmy({ units: ['a', 'b'], reviewers: 4 }).ok, false);
});

// ── 二 · 定单元：能抠就抠，抠不出绝不猜 ────────────────────────────
it('单元：显式 --units 优先，去重保序', () => {
  const r = pickUnits('随便什么', { units: ['b.mjs', 'a.mjs', 'b.mjs'] });
  assert.deepEqual(r.units, ['b.mjs', 'a.mjs']);
  assert.equal(r.from, 'explicit');
});

it('单元：从 PRD 文本里抠出真实存在的文件（detectUnits 返回对象，要摊平成字符串）', () => {
  const cwd = path.resolve('.');
  const r = pickUnits('改 lib/army.mjs 和 lib/split.mjs', { cwd });
  assert.equal(r.from, 'detected');
  assert.ok(r.units.includes('lib/army.mjs'), '要拿到字符串路径，不是 [object Object]：' + JSON.stringify(r.units));
  assert.ok(r.units.every((u) => typeof u === 'string'));
});

it('单元：抠不出就是空，不猜', () => {
  const r = pickUnits('解释一下这东西是干嘛的', { cwd: path.resolve('.') });
  assert.equal(r.units.length, 0);
  assert.equal(r.from, 'none');
});

// ── 三 · 侦察：产出永远是候选，不靠模型自觉 ────────────────────────
it('侦察解析：三段都解析出来，每条强制带候选标记与来源', () => {
  const s = parseScout([
    'SKELETON:',
    '- 由 lib/army.mjs:30 负责',
    'RISKS:',
    '- ' + CANDIDATE + ' 可能会漏掉评审段',
    'CHECKS:',
    '- node test/all.mjs',
  ].join('\n'), { model: 'qwen3:8b' });
  assert.equal(s.skeleton.length, 1);
  assert.equal(s.risks.length, 1);
  assert.equal(s.checks.length, 1);
  for (const item of [...s.skeleton, ...s.risks, ...s.checks]) {
    assert.equal(item.candidate, true, '每条都必须是候选');
    assert.equal(item.source, 'qwen3:8b');
  }
  assert.equal(s.risks[0].text.includes(CANDIDATE), false, '剥掉模型自己写的标记，标记由解析层统一加');
});

it('侦察解析：空文本 → empty，不抛', () => {
  const s = parseScout('', { model: 'x' });
  assert.equal(s.empty, true);
  assert.equal(s.total, 0);
});

it('侦察渲染：没候选时明确让主攻自己读，不要假设', () => {
  const t = renderScout({ total: 0, skeleton: [], risks: [], checks: [] });
  assert.match(t, /不要假设/);
});

it('侦察渲染：过长要截断（喂给每一路主力，太长等于给三路各灌一次噪声）', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ text: 'x'.repeat(40) + i, candidate: true, source: 'm' }));
  const t = renderScout({ total: 400, skeleton: many, risks: [], checks: [] });
  assert.ok(t.length < ARMY_LIMITS.maxScoutChars + 400, '实际 ' + t.length);
  assert.match(t, /已截断/);
});

it('侦察提示词：只读、必须照抄候选前缀、不许出方案', () => {
  const p = buildScoutPrompt('PRD 正文', ['lib/a.mjs', 'lib/b.mjs']);
  assert.match(p, /侦察兵/);
  assert.match(p, /PRD 正文/);
  assert.ok(p.includes('2. lib/b.mjs'), '单元清单要带序号');
  assert.match(p, /SKELETON:/);
  assert.match(p, /不要写方案/);
});

// ── 四 · 主力与评审的提示词契约 ───────────────────────────────────
it('主力任务：一个单元、契约块头、候选警告都在', () => {
  const scout = parseScout('SKELETON:\n- lib/a.mjs:1 负责入口', { model: 'm' });
  const t = buildMainTask('lib/a.mjs', 'PRD 正文', scout);
  assert.match(t, /你这一路只负责一个单元/);
  assert.ok(t.includes('// file: lib/a.mjs'), '契约块头必须是 // file: <unit>');
  assert.match(t, /候选，不是事实/);
  assert.match(t, /不要越界/);
});

it('评审提示词：只找反例 + JSON 票格式 + id 是 unit-N', () => {
  const p = buildArmyReviewPrompt('PRD', [{ id: 'unit-1', unit: 'lib/a.mjs', answer: 'A', evidence: 'lib/a.mjs:1' }], { note: '重点看越界' });
  assert.match(p, /只干一件事：找反例/);
  assert.match(p, /不许重写/);
  assert.match(p, /\"id\":\"unit-1\"/);
  assert.match(p, /重点看越界/);
});

// ── 五 · 票面结算：到票率闸门（这是「票面」，不是「一张票说了算」）──
const arts = [
  { id: 'unit-1', unit: 'lib/a.mjs' },
  { id: 'unit-2', unit: 'lib/b.mjs' },
];

it('结算：2 路评审都 PASS → ACCEPT', () => {
  const passes = [
    [{ id: 'unit-1', verdict: 'PASS', reason: '' }, { id: 'unit-2', verdict: 'PASS', reason: '' }],
    [{ id: 'unit-1', verdict: 'PASS', reason: '' }, { id: 'unit-2', verdict: 'PASS', reason: '' }],
  ];
  const s = settleArtifacts(arts, passes);
  assert.equal(s[0].value, 1);
  assert.equal(s[0].state, 'ACCEPT');
  assert.equal(s[0].expected, 2);
});

it('结算：一路 PASS 一路 REVISE → 僵局，判 unreviewed（不替任何一方下结论）', () => {
  const passes = [
    [{ id: 'unit-1', verdict: 'PASS', reason: '' }],
    [{ id: 'unit-1', verdict: 'REVISE', reason: '这一行对不上' }],
  ];
  const s = settleArtifacts([{ id: 'unit-1', unit: 'lib/a.mjs' }], passes);
  assert.equal(s[0].state, 'unreviewed');
  assert.equal(s[0].value, 0);
});

it('结算：两路都 REVISE → REVISE（这时 value 必须是 -1，不是 judge 的「可判」值 1）', () => {
  const passes = [
    [{ id: 'unit-1', verdict: 'REVISE', reason: 'a' }],
    [{ id: 'unit-1', verdict: 'REVISE', reason: 'b' }],
  ];
  const s = settleArtifacts([{ id: 'unit-1', unit: 'lib/a.mjs' }], passes);
  assert.equal(s[0].state, 'REVISE');
  assert.equal(s[0].value, -1);
  assert.equal(s[0].judgeValue, 1, 'judge 的 value 是「判得出来」，不是「认可」');
});

it('结算：声明 2 路只到 1 路 → unreviewed（到票 0.5 < arity 0.8）', () => {
  // 这是放行侧漏洞的回归：缺席的评审不许被当成同意。
  const passes = [
    [{ id: 'unit-1', verdict: 'PASS', reason: '' }],
    [{ id: 'unit-1', verdict: 'unreviewed', reason: '这一路没给票' }],
  ];
  const s = settleArtifacts([{ id: 'unit-1', unit: 'lib/a.mjs' }], passes);
  assert.equal(s[0].value, 0);
  assert.equal(s[0].state, 'unreviewed');
  assert.match(String(s[0].reason), /insufficient/);
});

it('结算：一路评审都没给票 → unreviewed，绝不默认通过', () => {
  const s = settleArtifacts([{ id: 'unit-1', unit: 'lib/a.mjs' }], [[]]);
  assert.equal(s[0].value, 0);
  assert.equal(s[0].state, 'unreviewed');
});

it('汇总：有 REVISE → REVISE；有没票 → unreviewed；全过才 ACCEPT', () => {
  assert.equal(summarizeArmy([{ value: 1 }, { value: 1 }]).state, 'ACCEPT');
  assert.equal(summarizeArmy([{ value: 1 }, { value: -1 }]).state, 'REVISE');
  assert.equal(summarizeArmy([{ value: 1 }, { value: 0 }]).state, 'unreviewed');
  assert.equal(summarizeArmy([]).state, 'unreviewed');
  assert.equal(summarizeArmy([{ value: 1 }]).confidence, null, '阵型级不许编一个合并置信度出来');
});

it('预估：155s vs 只跑主力 90s，多出 72%（这就是「只对批次划算」的那个数）', () => {
  const e = estimateArmy({ units: 3, reviewers: 1 });
  assert.equal(e.totalMs, 155000);
  assert.equal(e.mainOnlyMs, 90000);
  assert.equal(Math.round(e.overheadRatio * 100), 72);
});

it('渲染：ARMY.md 三段都有，票面表逐产物一行', () => {
  const md = renderArmy({
    prd: 'PRD', units: ['lib/a.mjs'],
    scout: parseScout('SKELETON:\n- lib/a.mjs:1', { model: 'm' }),
    artifacts: [{ id: 'unit-1', unit: 'lib/a.mjs', answer: 'A', evidence: 'lib/a.mjs:1' }],
    settled: [{ id: 'unit-1', unit: 'lib/a.mjs', state: 'ACCEPT', confidence: 0.9, counts: { ACCEPT: 1, REVISE: 0, unreviewed: 0 }, expected: 1, reason: 'consensus-accept' }],
    summary: { state: 'ACCEPT', counts: { ACCEPT: 1, REVISE: 0, unreviewed: 0 } },
    elapsed: { scoutMs: 1000, mainMs: 2000, reviewMs: 3000, totalMs: 6000 },
    sources: { scout: 'ollama', main: 'codebuddy', review: 'codebuddy', reviewers: 1, homogeneous: true },
  });
  assert.match(md, /一 · 侦察/);
  assert.match(md, /二 · 主力产物/);
  assert.match(md, /三 · 票面结算/);
  assert.match(md, /\| unit-1 \| lib\/a\.mjs \| ACCEPT \|/);
  assert.match(md, /同源/);
});

// ── 六 · 端到端（注入 ask，不起真 CLI）──────────────────────────
function fakeAsk(behave) {
  return async (prompt) => {
    if (/你是侦察兵/.test(prompt)) return { ok: true, addedText: behave.scout };
    if (/你是评审/.test(prompt)) return { ok: true, addedText: behave.review(prompt) };
    return { ok: true, addedText: behave.main(prompt) };
  };
}

it('端到端：3 单元 → 侦察 1 + 主力 3 + 评审 1，全过 → ACCEPT', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'army-'));
  const seen = { scout: 0, main: 0, review: 0 };
  const res = await runArmy({
    task: 'PRD', cwd, units: ['lib/a.mjs', 'lib/b.mjs', 'lib/c.mjs'], reviewers: 1, timeoutMs: 5000,
    ask: async (prompt) => {
      if (/你是侦察兵/.test(prompt)) { seen.scout++; return { ok: true, addedText: 'SKELETON:\n- lib/a.mjs:1 入口' }; }
      if (/你是评审/.test(prompt)) {
        seen.review++;
        const ids = [...prompt.matchAll(/### (unit-\d+)/g)].map((m) => m[1]);
        return { ok: true, addedText: JSON.stringify(ids.map((id) => ({ id, verdict: 'PASS', reason: '' }))) };
      }
      seen.main++;
      const unit = (prompt.match(/\/\/ file: (\S+)/) || [])[1] || 'x';
      return { ok: true, addedText: 'ANSWER:\n// file: ' + unit + '\n这个单元没问题\nEVIDENCE:\n' + unit + ':1 读到了实现' };
    },
  });
  assert.equal(seen.scout, 1);
  assert.equal(seen.main, 3);
  assert.equal(seen.review, 1);
  assert.equal(res.summary.state, 'ACCEPT');
  assert.equal(res.settled.length, 3);
  assert.equal(res.sources.homogeneous, true);
  assert.ok(res.scout.total >= 1);
  assert.ok(res.scout.skeleton.every((x) => x.candidate === true));
});

it('端到端：主力交空证据 → 机械闸门毙掉，评审不花那份钱', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'army-'));
  let reviewSaw = -1;
  const res = await runArmy({
    task: 'PRD', cwd, units: ['lib/a.mjs', 'lib/b.mjs'], reviewers: 1, timeoutMs: 5000,
    ask: async (prompt) => {
      if (/你是侦察兵/.test(prompt)) return { ok: true, addedText: '' };
      if (/你是评审/.test(prompt)) {
        reviewSaw = [...prompt.matchAll(/### (unit-\d+)/g)].length;
        const ids = [...prompt.matchAll(/### (unit-\d+)/g)].map((m) => m[1]);
        return { ok: true, addedText: JSON.stringify(ids.map((id) => ({ id, verdict: 'PASS', reason: '' }))) };
      }
      const unit = (prompt.match(/\/\/ file: (\S+)/) || [])[1] || 'x';
      if (unit === 'lib/b.mjs') return { ok: true, addedText: 'ANSWER:\n// file: lib/b.mjs\n我觉得挺好的\nEVIDENCE:\n' };
      return { ok: true, addedText: 'ANSWER:\n// file: lib/a.mjs\nok\nEVIDENCE:\nlib/a.mjs:1 原文' };
    },
  });
  const b = res.settled.find((s) => s.id === 'unit-2');
  assert.equal(b.value, -1);
  assert.equal(b.reason, 'pre-gate');
  assert.match(String(b.reasonText), /机械闸门/);
  assert.equal(reviewSaw, 1, '被机械闸门毙掉的产物不该送评审（实际送审 ' + reviewSaw + '）');
});

it('端到端：声明 2 路评审但只回 1 路票 → 全部 unreviewed（到票率 0.5）', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'army-'));
  let n = 0;
  const res = await runArmy({
    task: 'PRD', cwd, units: ['lib/a.mjs', 'lib/b.mjs'], reviewers: 2, timeoutMs: 5000,
    ask: async (prompt) => {
      if (/你是侦察兵/.test(prompt)) return { ok: true, addedText: '' };
      if (/你是评审/.test(prompt)) {
        n++;
        if (n === 2) return { ok: true, addedText: '' }; // 第二路返回空内容
        const ids = [...prompt.matchAll(/### (unit-\d+)/g)].map((m) => m[1]);
        return { ok: true, addedText: JSON.stringify(ids.map((id) => ({ id, verdict: 'PASS', reason: '' }))) };
      }
      const unit = (prompt.match(/\/\/ file: (\S+)/) || [])[1] || 'x';
      return { ok: true, addedText: 'ANSWER:\n// file: ' + unit + '\nok\nEVIDENCE:\n' + unit + ':1 原文' };
    },
  });
  assert.equal(res.summary.state, 'unreviewed');
  assert.ok(res.settled.every((s) => s.value === 0), '一路 PASS 不许放行');
});

it('端到端：单元不足 2 个 → 抛错且带 reason，不静默降级', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'army-'));
  await assert.rejects(
    () => runArmy({ task: 'PRD', cwd, units: ['lib/a.mjs'], ask: async () => ({ ok: true, addedText: '' }) }),
    (e) => /units<2/.test(String(e.message)) && e.reason === 'units<2',
  );
});

it('契约：cli-spec 里有 army，且声明会派活', () => {
  assert.ok(VERBS.army, 'army 必须登记进 VERBS（attest 漏登记那天就是这么被抓的）');
  assert.equal(VERBS.army.cost, 'spawn');
  assert.ok(VERBS.army.switches.includes('--dry-run'));
  assert.ok(VERBS.army.flags['--units']);
  assert.ok(VERBS.army.flags['--reviewers']);
});


it('takeOpt：负数是值不是开关（--reviewers -1 曾经被当成没给值，静默变 1 路）', () => {
  assert.equal(takeOpt(['--reviewers', '-1'], '--reviewers').val, '-1');
  assert.equal(takeOpt(['--z', '-0.5,1'], '--z').val, '-0.5,1');
  // 开关仍然不许被当成值吃掉（这条是 --split --dry-run 试跑变真派活的旧坑）
  assert.equal(takeOpt(['--split', '--dry-run'], '--split').val, '');
});

it('runArmy：reviewers=0 必须直接拒，不许被夹成 1 路', async () => {
  await assert.rejects(
    () => runArmy({ task: 'PRD 里提到 lib/a.mjs 和 lib/b.mjs', units: ['lib/a.mjs', 'lib/b.mjs'], reviewers: 0, ask: async () => ({ ok: true, addedText: '' }) }),
    (e) => /reviewers/.test(String(e.message)),
  );
});

it('CLI：--reviewers 0 退出 2 且明说没派活（实测曾经静默跑成 1 路）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'army-cli-'));
  const prd = path.join(dir, 'prd.md');
  fs.writeFileSync(prd, '审 lib/a.mjs 与 lib/b.mjs，逐条带文件:行', 'utf8');
  const r = spawnSync(process.execPath, ['atwo.mjs', 'army', '--task-file', prd, '--units', 'lib/a.mjs,lib/b.mjs', '--reviewers', '0', '--dry-run'], { encoding: 'utf8', cwd: process.cwd() });
  assert.equal(r.status, 2, '用法错必须退出 2，实际：' + r.status + ' ' + r.stdout + r.stderr);
  assert.ok(/不派活/.test(r.stdout + r.stderr), '要说清没派活');
  assert.ok(/1-3/.test(r.stdout + r.stderr), '要给出合法区间');
});

it('finishArmy 落 REVIEW-RAW.md：误杀要从评审原文里查，票面只有机器码', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'army-raw-'));
  const result = {
    artifacts: [], units: [], scout: parseScout(''),
    settled: [], summary: { value: 0, state: 'unreviewed', counts: { ACCEPT: 0, REVISE: 0, unreviewed: 0 }, total: 0, confidence: null },
    elapsed: { scoutMs: 0, mainMs: 0, reviewMs: 0, totalMs: 0 },
    sources: { scout: 'x', main: 'x', review: 'x', reviewers: 1, homogeneous: true },
    reviewRaw: [{ reviewer: 1, ok: true, err: null, chars: 9, text: '理由在此：第 3 条错' }],
  };
  finishArmy(result, dir, 'PRD');
  const raw = fs.readFileSync(path.join(dir, 'REVIEW-RAW.md'), 'utf8');
  assert.ok(raw.includes('理由在此：第 3 条错'), '评审原文必须落盘');
  assert.ok(fs.existsSync(path.join(dir, 'ARMY.md')));
});
for (const [name, fn] of cases) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
console.log('\narmy.test.mjs: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
