// 父审提示词的「核对方式」按通道能力分叉。
// 钉的是：读不到本仓库的通道（GUI / HTTP）不许被要求去 Read，判断只能落在内联原文上。
// 背景 2026-11-19：提示词原文写着「你必须真的去读那一行」，GUI 通道读不到，
// 于是它回「请提供文件」或者凭印象认可 —— 两种都等于没审。
import { buildReviewPrompt } from '../lib/fanout.mjs';
import { laneCanRead, LANE_DEFS } from '../lib/lanes.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const kids = [{ id: 'k1', answer: '闸门全绿', evidence: 'atwo.mjs:100 的 gate 调用' }];
const refs = '### atwo.mjs:100\n    const r = runGate();';

console.log('能力表');
ok('codebuddy 读得到仓库', laneCanRead('codebuddy') === true);
ok('codex 读得到仓库', laneCanRead('codex') === true);
ok('trae 读不到（GUI 的 Read 在它自己工作区）', laneCanRead('trae') === false);
ok('workbuddy 读不到', laneCanRead('workbuddy') === false);
ok('doubao 读不到', laneCanRead('doubao') === false);
ok('ollama 读不到（没有工具）', laneCanRead('ollama') === false);
ok('deepseek 读不到', laneCanRead('deepseek') === false);
ok('未知通道按读不到算', laneCanRead('nosuchlane') === false && laneCanRead('') === false && laneCanRead(undefined) === false);
ok('cli 与 gui/http 的 canRead 不重叠', Object.values(LANE_DEFS).every((d) => (d.kind === 'cli') === (d.canRead === true)));

console.log('canRead=true（缺省行为，不能变）');
const withRead = buildReviewPrompt('t', kids, '', refs);
ok('要求真的去读那一行', withRead.includes('你必须真的去读那一行'), withRead.slice(0, 80));
ok('给出 Read 工具', withRead.includes('你可以用 Read 工具读仓库文件'));
ok('不要出现「你没有工具」', !withRead.includes('你没有工具'));
ok('显式 canRead:true 与缺省一致', buildReviewPrompt('t', kids, '', refs, '', { canRead: true }) === withRead);

console.log('canRead=false（GUI / HTTP）');
const noRead = buildReviewPrompt('t', kids, '', refs, '', { canRead: false });
ok('明说没有工具', noRead.includes('你没有工具，别假装有'));
ok('不再要求它 Read', !noRead.includes('你必须真的去读那一行') && !noRead.includes('你可以用 Read 工具'));
ok('堵死「请提供文件」这类空转回复', noRead.includes('请提供文件') && noRead.includes('我是无法访问') === false);
ok('指向内联原文作为唯一证据', noRead.includes('唯一的证据') && noRead.includes('判断全部留在本提示词内'));
ok('判据换成「逐字出现在原文里」', noRead.includes('逐字出现在上面的原文里'));
ok('引不到的行 → 判 REVISE 而不是猜', noRead.includes('这一行没人替我读过，无法核对'));

console.log('两种模式都必须保留的骨架');
for (const [tag, p] of [['可读', withRead], ['不可读', noRead]]) {
  ok(tag + '：仍要求判 ANSWER 是否回答问题', p.includes('ANSWER 是否直接回答了任务问的东西'));
  ok(tag + '：仍保留 JSON 票面契约', p.includes('"verdict":"PASS 或 REVISE"') && p.includes('"id":"子会话 id"'));
  ok(tag + '：仍带原始任务', p.includes('## 原始任务') && p.includes('t'));
  ok(tag + '：仍带子会话正文', p.includes('### 子会话 #1') && p.includes('闸门全绿'));
  ok(tag + '：仍带内联原文段', p.includes('有人已经替你把被引用的行读好了') && p.includes('const r = runGate();'));
}

console.log('没有内联原文时不许假装有证据');
const noRefs = buildReviewPrompt('t', kids, '', '', '', { canRead: false });
ok('不出现「有人已经替你读好了」这一段', !noRefs.includes('有人已经替你把被引用的行读好了'));
ok('仍然不给 Read 措辞', !noRefs.includes('你可以用 Read 工具'));
ok('没有原文时判 REVISE 的依据仍在', noRefs.includes('这一行没人替我读过，无法核对'));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);