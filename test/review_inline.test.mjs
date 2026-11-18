// inlineEvidence + 父审提示词的形状测试。
// 钉的是：证据必须内联在提示词里、编号成段，且提示词不许要求父审去碰仓库。
import { inlineEvidence, buildReviewPrompt, VERDICT_RE } from '../lib/review.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

console.log('inlineEvidence');
const two = [
  { file: 'lib/a.mjs', range: '12-14', text: 'const a = 1;' },
  { file: 'lib/b.mjs', line: 7, quote: 'return b;' },
];
const out = inlineEvidence(two);
ok('两条引用 → 两个 <<<EVIDENCE 标记', (out.match(/<<<EVIDENCE /g) || []).length === 2, JSON.stringify(out));
ok('两条引用 → 两段 text', (out.match(/text:/g) || []).length === 2, JSON.stringify(out));
ok('依次编号 1 / 2', /<<<EVIDENCE 1 \//.test(out) && /<<<EVIDENCE 2 \//.test(out));
ok('range 与 line 都落到 file:loc', out.includes('lib/a.mjs:12-14') && out.includes('lib/b.mjs:7'), JSON.stringify(out));
ok('引文原文原样带出（text 与 quote 两种字段）', out.includes('const a = 1;') && out.includes('return b;'));
ok('每条以 EVIDENCE>>> 收尾', (out.match(/EVIDENCE>>>/g) || []).length === 2);
ok('空数组 → 空字符串', inlineEvidence([]) === '' && inlineEvidence() === '');

console.log('父审提示词');
const prompt = buildReviewPrompt('a.mjs', 'const a = 1;\n', { author: 'trae', answer: 'a 是 1', evidence: two });
ok('提示词内联了 EVIDENCE', prompt.includes('<<<EVIDENCE 1 /') && prompt.includes('const a = 1;'));
ok('提示词不含「请打开」', !prompt.includes('请打开'));
ok('提示词不含「请读」', !prompt.includes('请读'));
ok('提示词不含「Read 工具」', !prompt.includes('Read 工具'));
ok('提示词含「逐字」', prompt.includes('逐字'));
ok('提示词含「超出」', prompt.includes('超出'));
ok('保留 VERDICT 契约', /VERDICT: ACCEPT/.test(prompt) && /VERDICT: REVISE/.test(prompt));
ok('VERDICT_RE 仍能解析末尾裁决', [...('x\nVERDICT: ACCEPT\n'.matchAll(VERDICT_RE))].length === 1);

// 无证据时也不能要求父审去仓库补
const bare = buildReviewPrompt('a.mjs', 'x', {});
ok('无证据时仍不提仓库访问', !/请打开|请读|Read 工具/.test(bare));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
