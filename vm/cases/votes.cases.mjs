// accept --behave 用例：票 → 三态的判定边界。
// 这里只钉「判得对不对」的边界，全套在 test/vm_votes.test.mjs。
export const cases = [
  { name: 'A → ACCEPT', call: (m) => m.parseVote('A'), expect: 'ACCEPT' },
  { name: '+1 → ACCEPT', call: (m) => m.parseVote('+1'), expect: 'ACCEPT' },
  { name: 'R → REVISE', call: (m) => m.parseVote('R'), expect: 'REVISE' },
  { name: '空串 = 没评成（null，不是认不出）', call: (m) => m.parseVote(''), expect: null },
  { name: 'unreviewed = 没评成', call: (m) => m.parseVote('unreviewed'), expect: null },
  { name: 'MAYBE = 认不出（undefined，调用方要报错）', call: (m) => m.parseVote('MAYBE'), expect: undefined },
  { name: '全认 → ACCEPT', call: (m) => m.judgeVotes({ votes: ['ACCEPT', 'ACCEPT', 'ACCEPT'], expected: 3 }).state, expect: 'ACCEPT' },
  { name: '全改 → REVISE', call: (m) => m.judgeVotes({ votes: ['REVISE', 'REVISE', 'REVISE'], expected: 3 }).state, expect: 'REVISE' },
  { name: '2:1 不能定调（既不通过也不否决）', call: (m) => m.judgeVotes({ votes: ['ACCEPT', 'ACCEPT', 'REVISE'], expected: 3 }).state, expect: 'unreviewed' },
  { name: '全没评成 → reason 是机器码 insufficient', call: (m) => m.judgeVotes({ votes: [null, null], expected: 2 }).reason, expect: 'insufficient' },
  { name: '人话另放 reasonText（不许污染 reason）', call: (m) => typeof m.judgeVotes({ votes: [null, null], expected: 2 }).reasonText === 'string' },
  { name: '有一票没评成就不是全票结论', call: (m) => m.judgeVotes({ votes: ['ACCEPT', null, null], expected: 3 }).state, expect: 'unreviewed' },
];
