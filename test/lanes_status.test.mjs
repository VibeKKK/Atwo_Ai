import assert from 'node:assert/strict';
import { looksStatusOnly, looksIncomplete, looksPlaceholder } from '../lib/lanes.mjs';

// 2026-11-17 实测原文：WorkBuddy 当父审两次都只回了这段，一处判定都没有。
const REAL_STATUS = '正在搜索代码 EXIT\n已消耗\n5.56\n我嘞个豆，这题有点东西';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('过程状态被认出（真原文）', () => assert.equal(looksStatusOnly(REAL_STATUS), true));
t('含判定词就不算过程状态', () => assert.equal(looksStatusOnly('正在搜索代码\nchild-1 PASS'), false));
t('空串不是过程状态（空是另一类问题）', () => assert.equal(looksStatusOnly(''), false));
t('纯数字行剥掉后剩不下东西', () => assert.equal(looksStatusOnly('已消耗\n12.34\n5'), true));
t('正文够长就不是', () => assert.equal(looksStatusOnly('这两份产物的引用行都对得上，结论一致。'), false));
t('思考型英文状态也算', () => assert.equal(looksStatusOnly('Thinking\nAnalyzing'), true));
t('「正在搜索」现在也进 looksIncomplete', () => assert.equal(looksIncomplete('正在搜索代码 EXIT'), true));
t('占位文案仍单列', () => assert.equal(looksPlaceholder('思考中'), true));

let bad = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log('  ✓ ' + name); } catch (e) { bad++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}
console.log(bad ? '✗ 失败 ' + bad + ' / ' + cases.length : '✓ 通过 ' + cases.length);
process.exit(bad ? 1 : 0);
