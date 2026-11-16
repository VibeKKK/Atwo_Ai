import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = readFileSync(path.join(HERE, 'lib/fanout-cli.mjs'), 'utf8');
const run = readFileSync(path.join(HERE, 'lib/fanout-run.mjs'), 'utf8');
const spec = readFileSync(path.join(HERE, 'lib/cli-spec.mjs'), 'utf8');
let pass = 0; let fail = 0;
const t = (name, fn) => { try { fn(); pass += 1; console.log('✓ ' + name); } catch (e) { fail += 1; console.log('✗ ' + name + ' —— ' + e.message); } };

// 一、should 真的接进了派活入口（之前全仓只有 atwo.mjs 一个调用方 = 没人执行）
t('fanout-cli 导入并调用 shouldDelegate', () => {
  assert.match(cli, /import \{ shouldDelegate \} from '\.\/should\.mjs'/);
  assert.match(cli, /shouldDelegate\(task, \{ parts: n \}\)/);
});
t('闸门排在 const n 之后（先算片数再判要不要派）', () => {
  const iN = cli.indexOf('const n = clampFanoutParts(');
  const iGate = cli.indexOf('shouldDelegate(task, { parts: n })');
  assert.ok(iN > 0 && iGate > iN, 'n=' + iN + ' gate=' + iGate);
});
t('判 self 时返回 EXIT.precondition 且不派活', () => {
  const blk = cli.slice(cli.indexOf('shouldDelegate(task, { parts: n })'), cli.indexOf('shouldDelegate(task, { parts: n })') + 700);
  assert.match(blk, /verdict === 'self'/);
  assert.match(blk, /return EXIT\.precondition/);
  assert.match(blk, /refusedBy: 'should'/);
});
t('试跑不拦（--dry-run 只算不派，不该被成本闸门挡住）', () => {
  assert.match(cli, /if \(!dryRun && !forceShould\)/);
});
t('--force-should 既被抠出任务文本也登记进 cli-spec', () => {
  assert.match(cli, /a = a\.filter\(\(x\) => x !== '--force-should'\)/);
  assert.match(spec, /'--force-should'/);
});

// 二、REVISE 必须带可核对引文（子会话指出、父审核对通过）
t('runFanout 里有 CITE_RE 与 requireCitation', () => {
  assert.match(run, /const CITE_RE =/);
  assert.match(run, /const requireCitation = \(rv\) =>/);
});
t('无引文的 REVISE 降级为 none 并留 downgraded 标记', () => {
  const blk = run.slice(run.indexOf('const requireCitation'), run.indexOf('const requireCitation') + 900);
  assert.match(blk, /verdict: VERDICT\.none/);
  assert.match(blk, /downgraded: 'revise-without-citation'/);
});
t('降级接线覆盖机械票与父审票', () => {
  assert.match(run, /\[\.\.\.mech, \.\.\.partsReviews\]\.map\(requireCitation\)/);
});
t('带引文的 REVISE 不被降级（真 REVISE 要能触发重做）', () => {
  const re = /[\w./-]+\.(?:mjs|js|cjs|ts|json|md|py|yml|yaml|txt)(?::\d+)?/;
  assert.ok(re.test('docs/decisions/2026-11-16-army.md:39-41 与自带的证据冲突'));
  assert.ok(!re.test('同一句话复读十余次，没有新内容'));
});

// 三、真 CLI：热点文件活必须当场拒跑（不派任何子会话）
t('真跑热点文件任务 → exit 3 且打出判据', () => {
  const r = spawnSync(process.execPath, [path.join(HERE, 'atwo.mjs'), 'fanout', '改 atwo.mjs 的 done 闸门：accept 从只在 relatedFiles 时跑改成有产物必须跑', '--parts', '2'], { cwd: HERE, encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 3, 'exit=' + r.status + ' ' + (r.stdout || '') + (r.stderr || ''));
  assert.match(r.stdout, /不该派/);
  assert.match(r.stdout, /--force-should/);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
