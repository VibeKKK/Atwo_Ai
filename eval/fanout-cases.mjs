// eval/fanout-cases.mjs —— 父审的金标准题集：每道题的真值已用命令核过，子产物里 c2 是植入错误。
// 用途只有一个：改提示 / 换模型 / 改解析之后，回放一遍，看漏判率有没有变。
export const CASES = [
  {
    id: 'e1-exit',
    task: 'atwo.mjs 里 EXIT 常量定义了哪几个退出码？给出每个码的名字和数字。',
    truth: 'ok:0 usage:2 precondition:3 accept:4 channel:5 budget:6（共 6 个）',
    children: [
      { id: 'c1', answer: '六个：ok=0 usage=2 precondition=3 accept=4 channel=5 budget=6', evidence: 'atwo.mjs:190 const EXIT = {...}' },
      { id: 'c2', answer: '五个：ok=0 usage=2 precondition=3 accept=4 channel=5', evidence: "grep 'EXIT' atwo.mjs 的常量段" },
      { id: 'c3', answer: 'ok 0 / usage 2 / precondition 3 / accept 4 / channel 5 / budget 6，共六个', evidence: '读了 atwo.mjs' },
    ],
  },
  {
    id: 'e2-maxparts',
    task: 'lib/fanout-run.mjs 里 MAX_PARTS 的值是多少？注释里说它来自什么实测？',
    truth: 'MAX_PARTS = 6；注释说来自并发拐点 6–8 路，超过 6 只增加单路耗时、不增加吞吐',
    children: [
      { id: 'c1', answer: 'MAX_PARTS = 6；注释写「实测并发拐点 6–8 路，超过 6 只增加每路变慢不增加吞吐」', evidence: 'lib/fanout-run.mjs:5' },
      { id: 'c2', answer: 'MAX_PARTS = 8；来自 8 路并发测试的拐点', evidence: 'lib/fanout-run.mjs 里的常量' },
      { id: 'c3', answer: '值是 6，理由是并发拐点在 6 到 8 之间', evidence: '看了 fanout-run.mjs' },
    ],
  },
  {
    id: 'e3-arity',
    task: 'vm/oracle-contract.json 里 votes.arity 是多少？它约束什么？',
    truth: 'arity = 0.8；到票率 (ACCEPT+REVISE)/expected < 0.8 时一律 unreviewed/insufficient，不看 confidence',
    children: [
      { id: 'c1', answer: 'arity = 0.8；到票率低于 0.8 一律判 unreviewed/insufficient，不看置信度', evidence: 'vm/oracle-contract.json:17-18' },
      { id: 'c2', answer: 'arity = 0.9；到票率低于 0.9 判不足', evidence: 'vm/oracle-contract.json 的 votes 段' },
      { id: 'c3', answer: '0.8，表示至少要八成的应评票到齐才算数', evidence: '翻了契约文件' },
    ],
  },
  {
    id: 'e4-cut',
    task: 'vm/oracle-contract.json 的 cut 里 high 和 mid 各是多少？',
    truth: 'high = 0.45，mid = 0.22',
    children: [
      { id: 'c1', answer: 'high = 0.45，mid = 0.22', evidence: 'vm/oracle-contract.json:6-7' },
      { id: 'c2', answer: 'high = 0.5，mid = 0.3', evidence: 'vm/oracle-contract.json 的 cut 字段' },
      { id: 'c3', answer: 'high 是 0.45，mid 是 0.22，两个都是置信度阈值', evidence: '读了契约' },
    ],
  },
  {
    id: 'e5-verbs',
    task: 'atwo.mjs 的 table 里一共有几个动词？把它们列出来。',
    truth: '22 个：doctor try should gate hooks score attest pitfall models new go check diff judge fanout triage army batch done state mode raw',
    children: [
      { id: 'c1', answer: '22 个：doctor try should gate hooks score attest pitfall models new go check diff judge fanout triage army batch done state mode raw', evidence: "atwo.mjs 里 const table = { ... }" },
      { id: 'c2', answer: '10 个：new / batch / go / check / diff / judge / done / state / mode / raw', evidence: 'atwo.mjs 的动词表' },
      { id: 'c3', answer: '共 22 个，包含后来加的 fanout / army / triage / doctor', evidence: '看了 atwo.mjs' },
    ],
  },
  {
    id: 'e6-zlimit',
    task: 'vm/judge.mjs 里把 z 值截断到多少？为什么要截？',
    truth: 'Z_LIMIT = 3；不截断时单个指标能算出 -180 之类的值，一个指标绑架全部结论',
    children: [
      { id: 'c1', answer: 'Z_LIMIT = 3（±3）；不截断时延迟倍率这类指标能算出 -180，一个指标就能绑架整份结论', evidence: 'vm/judge.mjs 的 Z_LIMIT 常量' },
      { id: 'c2', answer: '截断到 ±5；为了抑制离群值', evidence: 'vm/judge.mjs 的常量定义' },
      { id: 'c3', answer: '截到正负 3', evidence: '看了 judge.mjs' },
    ],
  },
];
