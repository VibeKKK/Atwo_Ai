import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = readFileSync(path.join(HERE, 'lib/fanout-cli.mjs'), 'utf8');
const spec = readFileSync(path.join(HERE, 'lib/cli-spec.mjs'), 'utf8');
let pass = 0; let fail = 0;
const t = (name, fn) => { try { fn(); pass += 1; console.log('✓ ' + name); } catch (e) { fail += 1; console.log('✗ ' + name + ' —— ' + e.message); } };
const runCli = (args) => spawnSync(process.execPath, [path.join(HERE, 'atwo.mjs'), 'fanout', ...args], { cwd: HERE, encoding: 'utf8', timeout: 120000 });

// 分级表本身
t('三档已定义，cheap 指向实测过的便宜模型', () => {
  assert.match(cli, /const REVIEW_TIERS = \{ cheap: 'deepseek-v4\.1-flash', std: null, high: null \}/);
});
t('未知档位直接拒跑（不派活、不写盘）', () => {
  const r = runCli(['随便一个任务', '--dry-run', '--review-tier', 'turbo']);
  assert.strictEqual(r.status, 2, 'exit=' + r.status);
  assert.match(r.stdout, /只能是 cheap \/ std \/ high/);
  assert.match(r.stdout, /没有派出任何子会话/);
});
t('cheap 档把父审模型换成便宜模型', () => {
  const r = runCli(['把 lib 下 12 个互不相同的 .mjs 各自补一组边界用例', '--dry-run', '--review-tier', 'cheap']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /deepseek-v4\.1-flash（--review-tier cheap）/);
});
t('显式 --review-model 优先于档位（用户说了算）', () => {
  const r = runCli(['把 lib 下 12 个互不相同的 .mjs 各自补一组边界用例', '--dry-run', '--review-tier', 'cheap', '--review-model', 'glm-5.3-flash']);
  assert.match(r.stdout, /glm-5\.3-flash/);
});
t('high 档把片大小压到 1（逐份对引文）', () => {
  assert.match(cli, /reviewChunk: oReviewChunk\.val != null \? Number\(oReviewChunk\.val\) : \(reviewTier === 'high' \? 1 : undefined\)/);
});
t('--review-tier 与 --review-chunk 都登记进 cli-spec（否则 checkFlags 会当未知参数）', () => {
  assert.match(spec, /'--review-tier'/);
  assert.match(spec, /'--review-chunk'/);
});
t('试跑 JSON 里带 reviewTier（机器可读）', () => {
  const r = runCli(['把 lib 下 12 个互不相同的 .mjs 各自补一组边界用例', '--dry-run', '--review-tier', 'high', '--json']);
  // --json 的输出是美化过的多行 JSON，整段 parse（早期测试按行取最后一行会炸）
  const data = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.strictEqual(data.data.reviewTier, 'high');
  assert.strictEqual(data.data.reviewModel, null);
});
t('默认档位是 std，不改父审模型（无参数不动现状）', () => {
  const r = runCli(['把 lib 下 12 个互不相同的 .mjs 各自补一组边界用例', '--dry-run']);
  assert.match(r.stdout, /父审模型\s+通道默认/);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
