// file: test/triage.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { splitChild, readFanoutDir, triageOne, planTriage, formatTriage, ROUTE } from '../lib/triage.mjs';

// 坑：用 URL.pathname 会带 %20（仓库路径含空格）→ cwd 不存在 → spawnSync ENOENT。必须 fileURLToPath。
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; let fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' :: ' + ((e && e.message) || e)); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
const writeChild = (dir, n, body) => fs.writeFileSync(path.join(dir, 'child-' + n + '.md'), body, 'utf8');

// —— splitChild ——
t('splitChild 能切出 ANSWER / EVIDENCE', () => {
  const r = splitChild('# child-1\n\nANSWER:\n是 9 个。\n\nEVIDENCE:\n- lib/a.mjs:12 x');
  assert.equal(r.answer, '是 9 个。');
  assert.match(r.evidence, /lib\/a\.mjs:12/);
  assert.equal(r.malformed, false);
});
t('splitChild 缺标签时整段当 answer 且标 malformed', () => {
  const r = splitChild('随手一段话');
  assert.equal(r.answer, '随手一段话');
  assert.equal(r.evidence, '');
  assert.equal(r.malformed, true);
});
t('splitChild 空文本不炸', () => {
  const r = splitChild('');
  assert.equal(r.answer, '');
  assert.equal(r.evidence, '');
});

// —— readFanoutDir ——
const dOk = path.join(tmp, 'ok'); fs.mkdirSync(dOk);
writeChild(dOk, 1, 'ANSWER:\n一\n\nEVIDENCE:\n- lib/a.mjs:12 x');
writeChild(dOk, 2, 'ANSWER:\n二\n\nEVIDENCE:\n- lib/b.mjs:3 y');
t('readFanoutDir 按编号排序读出', () => {
  const kids = readFanoutDir(dOk);
  assert.deepEqual(kids.map((k) => k.id), ['child-1', 'child-2']);
  assert.equal(kids[0].answer, '一');
});
t('readFanoutDir 目录不存在要报错（不返回空数组糊过去）', () => {
  assert.throws(() => readFanoutDir(path.join(tmp, 'nope')), /目录不存在/);
});

// —— triageOne 两条路由 ——
t('EVIDENCE 为空 → reject', () => {
  const r = triageOne({ id: 'child-1', answer: '有答案', evidence: '' });
  assert.equal(r.route, ROUTE.reject);
  assert.match(r.reason, /EVIDENCE 为空/);
});
t('ANSWER 为空 → reject', () => {
  const r = triageOne({ id: 'child-1', answer: '', evidence: 'lib/a.mjs:12' });
  assert.equal(r.route, ROUTE.reject);
});
t('EVIDENCE 没有文件:行 → reject', () => {
  const r = triageOne({ id: 'child-1', answer: '答', evidence: '我读了代码，感觉没问题' });
  assert.equal(r.route, ROUTE.reject);
  assert.match(r.reason, /不可核对/);
});
t('形式齐全 → review（机械判不了语义，必须送父审）', () => {
  const r = triageOne({ id: 'child-1', answer: '9 个', evidence: '- lib/a.mjs:12 x' }, { cwd: HERE });
  assert.equal(r.route, ROUTE.review);
});

// —— planTriage 三种结局 ——
t('全部形式缺失 → settle-without-llm，省下全部调用', () => {
  const p = planTriage([{ id: 'c1', answer: 'x', evidence: '' }, { id: 'c2', answer: '', evidence: '' }]);
  assert.equal(p.verdict, 'settle-without-llm');
  assert.equal(p.llmCalls, 0);
  assert.equal(p.savedCalls, 2);
  assert.match(p.detail, /机械结帐/);
});
t('一半一半 → need-llm，省下一次', () => {
  const p = planTriage([
    { id: 'c1', answer: 'x', evidence: '' },
    { id: 'c2', answer: '9 个', evidence: '- lib/a.mjs:12 x' },
  ], { cwd: HERE });
  assert.equal(p.verdict, 'need-llm');
  assert.equal(p.llmCalls, 1);
  assert.equal(p.savedCalls, 1);
  assert.match(p.detail, /省下 1 次父审/);
});
t('空清单不许算通过（verdict 是结帐但 detail 说明没产物）', () => {
  const p = planTriage([]);
  assert.equal(p.counts.total, 0);
  assert.match(p.detail, /没什么可审/);
});
t('formatTriage 打出路由与目录', () => {
  const p = planTriage([{ id: 'c1', answer: 'x', evidence: '' }], { dir: 'D:/x' });
  const s = formatTriage(p);
  assert.match(s, /分诊：1 份/);
  assert.match(s, /✗ c1/);
  assert.match(s, /目录: D:\/x/);
});

// —— CLI：真跑子进程（不许只测函数）——
t('CLI atwo triage --dir 真跑，exit 0 且报路由', () => {
  const out = execFileSync(process.execPath, [path.join(HERE, 'atwo.mjs'), 'triage', '--dir', dOk], { cwd: HERE, encoding: 'utf8' });
  assert.match(out, /分诊：2 份/);
  assert.match(out, /送审 2/);
});
t('CLI --json 出机器可读 data', () => {
  const out = execFileSync(process.execPath, [path.join(HERE, 'atwo.mjs'), 'triage', '--dir', dOk, '--json'], { cwd: HERE, encoding: 'utf8' });
  // --json 是缩进过的整段 JSON，不能只取最后一行
  const body = out.slice(out.indexOf('{'));
  const j = JSON.parse(body);
  assert.equal(j.ok, true);
  assert.equal(j.data.counts.total, 2);
  assert.equal(j.data.verdict, 'need-llm');
});
t('CLI 目录不存在 → 退出码 3（前置条件），不是 0', () => {
  try {
    execFileSync(process.execPath, [path.join(HERE, 'atwo.mjs'), 'triage', '--dir', path.join(tmp, 'nope')], { cwd: HERE, encoding: 'utf8' });
    assert.fail('应该非 0 退出');
  } catch (e) {
    assert.equal(e.status, 3, '实际退出码 ' + e.status);
  }
});
t('CLI --help 只打规格、不跑分诊', () => {
  const out = execFileSync(process.execPath, [path.join(HERE, 'atwo.mjs'), 'triage', '--help'], { cwd: HERE, encoding: 'utf8' });
  assert.match(out, /atwo triage/);
  assert.doesNotMatch(out, /分诊：/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log('triage: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
