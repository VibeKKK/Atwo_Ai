import { humanVerdict, humanIssues, humanApispecFail, humanReason, humanReport } from '../lib/humanize.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + x); } };

// 一、三种共识
const two = (a, b) => [{ reviewer: 'codebuddy', verdict: a, issues: a === 'ACCEPT' ? 0 : 8 },
                       { reviewer: 'trae', verdict: b, issues: b === 'ACCEPT' ? 0 : 9 }];

const acc = humanVerdict({ consensus: 'all-accept', verdict: 'ACCEPT', votes: two('ACCEPT', 'ACCEPT'), degraded: false, issues: 0 });
ok('all-accept → 都说同意', /都看过了，都同意/.test(acc), acc);

const rev = humanVerdict({ consensus: 'all-revise', verdict: 'REVISE', votes: two('REVISE', 'REVISE'), degraded: false, issues: 17 });
ok('all-revise → 都要求改', /都认为还要改/.test(rev), rev);
// 这条防的是真事故：契约说 issues 是条数，实现按数组写，17 显示成 0
ok('all-revise 的问题数是 17 不是 0', /17 个问题/.test(rev), rev);

const split = humanVerdict({ consensus: 'split', verdict: 'REVISE', votes: two('ACCEPT', 'REVISE'), degraded: false, issues: 5 });
ok('split → 看法不一样，需要你定', /看法不一样，需要你定/.test(split), split);

// 二、没人看过
const none = humanVerdict({ consensus: null, verdict: null, votes: [], degraded: false, issues: null });
ok('没有投票 → 没有第三方看过', /没有第三方看过/.test(none), none);

// 三、降级
const deg = humanVerdict({ consensus: 'all-accept', verdict: 'ACCEPT', votes: [{ reviewer: 'codebuddy', verdict: 'ACCEPT', issues: 0 }], degraded: true, issues: 0 });
ok('degraded → 结论弱一点', /结论弱一点/.test(deg), deg);
// 单个评审者不能说「都」
ok('单个评审者不说「都看过了」', !/1 个 AI 都看过了/.test(deg), deg);

// 四、issues 两种形状都认
ok('issues 是数字 → 直接用', /7 个问题/.test(humanIssues(7)));
ok('issues 是 0 → 没发现问题', /没发现问题/.test(humanIssues(0)));
ok('issues 是 null → 未知', /问题数未知/.test(humanIssues(null)));
ok('issues 是数组 → 取长度', /3 个问题/.test(humanIssues([1, 2, 3])));

// 五、apispec 翻译
const api = humanApispecFail('loadTasks 参数不符：要 [filePath] 实为 [path]');
ok('apispec 报错翻成人话', api === '函数参数名对不上：要求 loadTasks(filePath)，实际写的是 path', api);
ok('apispec 解析不出就原样返回', humanApispecFail('随便一句话') === '随便一句话');
ok('apispec 非字符串不崩溃', humanApispecFail(null) === '');

// 六、reason
ok('reason unreviewed 有中文', /没有第三方看过/.test(humanReason('unreviewed')));
ok('reason fix-failed 有中文', /文件还是原样/.test(humanReason('fix-failed')));
ok('reason 未知值原样返回', humanReason('whatever') === 'whatever');

// 七、多行报告
const rep = humanReport({ file: 'lib/x.mjs', consensus: 'split', verdict: 'REVISE', votes: two('ACCEPT', 'REVISE'), degraded: false, issues: 5, ok: false, reason: null });
const repLines = rep.split('\n');
ok('报告第一行标明没通过', repLines[0].startsWith('没通过：'), repLines[0]);
ok('报告每个 AI 一行', repLines.length === 3, '共 ' + repLines.length + ' 行');
ok('每行带问题数不是未知', !/问题数未知/.test(rep), rep);

// 八、脏输入一律不抛
for (const bad of [null, undefined, 0, 'x', [], { votes: 'x' }, { votes: [null, 1] }]) {
  let threw = false;
  try { humanVerdict(bad); humanReport(bad); } catch { threw = true; }
  ok('脏输入不抛：' + JSON.stringify(bad), !threw);
}

console.log('');
console.log(fail === 0 ? `全部通过：${pass} 项` : `失败 ${fail} 项 / 通过 ${pass} 项`);
process.exit(fail === 0 ? 0 : 1);
