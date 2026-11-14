// test/self_patch.mjs —— A0 就地补丁的离线单测（不连 agent、不写盘）
import { extractPatches, applyPatch } from '../lib/selfparse.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ← ' + extra : ''}`); }
}

// ── 1. 标准 unified diff（带 ---/+++ 与 context）──
const d1 = [
  '改这一行就行：',
  '```diff',
  '--- a/lib/subagent.mjs',
  '+++ b/lib/subagent.mjs',
  '@@ -20,5 +20,5 @@',
  ' const brief = String((sub && sub.brief) || "").trim();',
  '-const head = brief.slice(0, 500);',
  '+const head = brief.slice(0, 100);',
  ' return `目标：${head}`;',
  ' ',
  '```',
].join('\n');
const p1 = extractPatches(d1);
ok('抽出 1 个补丁', p1.length === 1, JSON.stringify(p1));
ok('路径取 +++ 那行', p1[0] && p1[0].file === 'lib/subagent.mjs', p1[0] && p1[0].file);
ok('抽出 1 个 hunk', p1[0] && p1[0].hunks.length === 1);

const src1 = [
  'line0',
  ' const brief = String((sub && sub.brief) || "").trim();',
  'const head = brief.slice(0, 500);',
  ' return `目标：${head}`;',
  '',
  'line5',
].join('\n');
const r1 = applyPatch(src1, p1[0]);
ok('应用成功', r1.ok, r1.reason);
ok('替换生效', r1.text.includes('slice(0, 100)') && !r1.text.includes('slice(0, 500)'));
ok('上下文没丢', r1.text.includes('line0') && r1.text.includes('line5'));

// ── 2. 模型省略 ---/+++ 的裸 hunk（只给 @@ 和内容）──
const d2 = [
  '在 orchestra.mjs 里这么改：',
  '```',
  '@@ -3,3 +3,3 @@',
  ' import a from "a";',
  '-import b from "b";',
  '+import b from "b";',
  '+import c from "c";',
  '```',
].join('\n');
const p2 = extractPatches(d2);
ok('裸 hunk 也能抽到', p2.length === 1, JSON.stringify(p2));

// ── 3. 围栏外裸 diff ──
const d3 = [
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,2 +1,2 @@',
  ' # 标题',
  '-旧的一行',
  '+新的一行',
].join('\n');
const p3 = extractPatches(d3);
ok('裸 diff 也能抽到', p3.length === 1, JSON.stringify(p3));
const r3 = applyPatch('# 标题\n旧的一行\n', p3[0]);
ok('裸 diff 应用成功', r3.ok && r3.text.includes('新的一行'), r3.reason);

// ── 4. 定位失败要明确报错，不能静默改坏 ──
const r4 = applyPatch('完全不相干的内容\n', p1[0]);
ok('定位失败返回 ok=false', r4.ok === false);
ok('失败时原文不动', r4.text === '完全不相干的内容\n', JSON.stringify(r4.text));
ok('失败原因可读', /hunk 定位失败/.test(r4.reason), r4.reason);

// ── 5. 不含 diff 的散文不该被当成补丁 ──
const prose = '我建议只替换那一行，注意别改坏缩进。(confidence 0.90)';
ok('散文不产生补丁', extractPatches(prose).length === 0);

// ── 6. 非白名单扩展名要拒掉 ──
const d6 = ['--- a/run.exe', '+++ b/run.exe', '@@ -1,1 +1,1 @@', '-x', '+y'].join('\n');
ok('非白名单扩展名被拒', extractPatches(d6).length === 0);

// ── 7. 多 hunk 顺序应用 ──
const d7 = [
  '```diff',
  '--- a/x.md',
  '+++ b/x.md',
  '@@ -1,1 +1,1 @@',
  '-A1',
  '+B1',
  '@@ -3,1 +3,1 @@',
  '-A3',
  '+B3',
  '```',
].join('\n');
const p7 = extractPatches(d7);
ok('多 hunk 抽出', p7.length === 1 && p7[0].hunks.length === 2, p7[0] && p7[0].hunks.length);
const r7 = applyPatch('A1\nkeep\nA3\n', p7[0]);
ok('多 hunk 都应用', r7.ok && r7.text === 'B1\nkeep\nB3\n', JSON.stringify(r7.text));

console.log(`\nself_patch.mjs: ${pass} checks passed${fail ? `，${fail} 失败` : ''}`);
if (fail) process.exit(1);
