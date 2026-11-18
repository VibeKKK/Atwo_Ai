// lib/cli-spec.mjs —— atwo 的「自描述表」：动词 / 参数 / 退出码 / 上限，全在这一个文件。
//
// 为什么单独成文件，而不是写在 usage() 里：
//   1. 人读的长文和机器读的规格是两份东西，混在一起就会漂移（已经漂过一次 ——
//      usage 写着「加 --help 看每个动词的全部参数」，而代码里根本没有分动词 help，
//      --help 被 fanout 当成任务文本，真派出三个子会话跑了 61 秒）。
//   2. 这张表同时驱动三件事：打印用法、校验参数、给 AI 自学的 caps JSON。
//      三处共用一个真源，就不会出现「文档说 A、代码做 B」。
//   3. 谁加参数只改这里 + 改实现，测试会用 caps 与实现互相对照。
//
// 纪律：这份表是给 AI 读的。summary 一句话说清「它会做什么、花不花钱」，
//      不要把营销话术写进来 —— AI 不需要被说服，需要知道代价。

/** 任何位置出现都算「求助」，永远不进入任务文本。 */
export const HELP_TOKENS = new Set(['help', '-h', '--help', '-?', '--usage']);

/** 机器判成败只看这个，别读文案。 */
export const EXIT_CODES = {
  0: '成功',
  2: '用法错（参数不认识 / 缺位置参数）',
  3: '前置条件不满足（没在做任务 / 通道没开）',
  4: '验收没过（活干砸了）',
  5: '通道失败（空文本 / 只成一部分）',
  6: '预算闸门',
};

/**
 * 动词表。
 *   pos      位置参数说明（没有就不写）
 *   flags    带值开关：名字 → 值形态
 *   switches 开关位（不带值）
 *   strict   true = 出现不认识的 --x 直接退出 2；false = 透传给下层（go/batch/raw）
 *   cost     会花多少钱：none（不派活）/ io（只读写本地）/ spawn（真派 AI，按次计）
 *   writes   会不会改仓库里的文件
 */
export const VERBS = {
  doctor: {
    summary: '报这台机器现在能干什么：通道在不在、ollama 通不通、仓库有没有闸门。--reviewers 会真派一次父审探活（慢、费额度）。',
    pos: '',
    flags: { '--reviewers': '通道列表（逗号分隔；不带值=codebuddy,trae,workbuddy,ollama）。会给每条通道派一次「真假两条产物」的评审，判它能不能当父审' },
    switches: [],
    strict: true,
    cost: 'io',
    writes: false,
    examples: ['atwo doctor', 'atwo doctor --reviewers codebuddy', 'atwo doctor --reviewers trae,workbuddy,ollama --json'],
  },
  try: {
    summary: '零依赖自检三连（运行闭包 / 三值闸门 / 并发上限），2 秒内出结果，不花钱、不联网、不派活。',
    pos: '',
    flags: {},
    switches: [],
    strict: true,
    cost: 'none',
    writes: false,
    examples: ['atwo try'],
  },
  should: {
    summary: '判该不该派活：一句话进，delegate / self / either 出，附触发词与代价。不派活、不花钱。',
    pos: '"一句话任务（原文，别加工）"',
    flags: {},
    switches: [],
    strict: true,
    cost: 'none',
    writes: false,
    examples: ['atwo should "把 lib/ 下 12 个文件的 import 统一改成 ESM"', 'atwo should "改 atwo.mjs 的 dispatch 加一个分支" --json'],
  },
  gate: {
    summary: '一条命令跑完确定性检查（测试 / 运行闭包 / 契约未漂移 / 语法 / 未提交）。全绿才能说「改完了」。',
    pos: '',
    flags: { '--files': 'a.mjs,b.mjs（给了就对它们跑五层验收）' },
    switches: ['--no-tests'],
    strict: true,
    cost: 'io',
    writes: false,
    examples: ['atwo gate', 'atwo gate --files lib/should.mjs --no-tests'],
  },
  hooks: {
    summary: '装/查/卸 git 钩子：让 gate 每次提交自己跑，不靠人记得敲（本仓库无 CI，钩子是唯一自动点）。',
    pos: 'status | install | remove | run',
    flags: {},
    switches: ['--force', '--no-tests'],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo hooks status', 'atwo hooks install', 'atwo hooks run --no-tests'],
  },
  score: {
    summary: '看验收分数：从 memory/score.jsonl 算总通过率、按天趋势与近 N 天环比。不派活、不花钱。',
    pos: '',
    flags: { '--days': 'N（默认 7）' },
    switches: [],
    strict: true,
    cost: 'io',
    writes: false,
    examples: ['atwo score', 'atwo score --days 14', 'atwo score --json'],
  },
  attest: {
    summary: '审凭证：扫 memory/attest.jsonl 与 attest-judge.jsonl，重算每份凭证，列出因文件改动而失效的那些。不派活、不花钱。',
    pos: '',
    flags: { '--by': '按实现者过滤（谁实现、谁盖章）' },
    switches: [],
    strict: true,
    cost: 'io',
    writes: false,
    examples: ['atwo attest', 'atwo attest --by dsh-lead', 'atwo attest --json'],
  },
  pitfall: {
    summary: '坑账本：记下踩过的坑（现象/触发短语/修法），列出来看；派活时按 PRD 文本自动提示命中的坑。不派活、不花钱。',
    pos: '[add 「现象」]',
    flags: { '--trigger': '能被任务文本命中的短语（默认取现象前 24 字）', '--fix': '修法' },
    switches: [],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo pitfall', 'atwo pitfall add 「补丁里引号嵌套会闭合字符串」 --trigger 补丁', 'atwo pitfall --json'],
  },
  snapshot: {
    summary: '一眼看通道健康度：每条最近成功/失败、平均耗时、被拉黑的、以及该用哪个预算内模型。不派活、不花钱。',
    pos: '',
    flags: {},
    switches: ['--json'],
    strict: true,
    cost: 'io',
    writes: false,
    examples: ['atwo snapshot', 'atwo snapshot --json'],
  },

  tail: {
    summary: '看某次长任务跑到哪了（progress.log 最后 N 行 + 有没有 STOP）。不派活、不花钱。',
    pos: '[run-id]',
    flags: { '-n': '取最后多少行（默认 40）' },
    switches: ['--json'],
    strict: true,
    cost: 'io',
    writes: false,
    examples: ['atwo tail', 'atwo tail r1 -n 80', 'atwo tail --json'],
  },

  stop: {
    summary: '请求停止某次长任务（写 STOP 旗标，长任务下次派发前才看到）。不派活、不花钱。',
    pos: '<run-id>',
    flags: { '--reason': '写进旗标的原因', '--clear': '清掉已有的 STOP' },
    switches: ['--json'],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo stop r1 --reason 「方向错了」', 'atwo stop r1 --clear', 'atwo stop --json'],
  },
  health: {
    summary: '看每个通道最近真干活的成败（只读账本，不探活、不问模型）',
    usage: 'atwo health [--json]',
    flags: {},
    switches: ['--json'],
    strict: true,
    cost: 'io',
    writes: false,
    examples: ['atwo health', 'atwo health --json'],
  },
  board: {
    summary: '把流水、通道成功率、坑账本渲染成一页 HTML 看板（单文件、无外链、可离线打开）。不派活、不花钱。',
    pos: '',
    flags: { '--out': '输出路径（默认 docs/reports/board.html）', '--limit': '取最近多少条流水（默认 20）' },
    switches: ['--json'],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo board', 'atwo board --limit 50', 'atwo board --out /d/tmp/board.html'],
  },
  selfcheck: {
    summary: '五项体检：动词数 / 测试文件 / 图龄 / 通道健康 / 账本与预算',
    strict: true,
    usage: 'atwo selfcheck [--json]',
    cost: 'io',
    writes: false,
    flags: { '--json': '机器可读的体检结果' },
    switches: ['--json'],
    examples: ['atwo selfcheck', 'atwo selfcheck --json'],
    note: '只数测试文件、不跑测试；图龄过期会明确告诉你要先跑 graft index',
  },
  models: {
    summary: '看/清模型不可用名单（订阅到期、模型下架这类「今天用不了」的模型，12 小时自动过期）。不派活、不花钱。',
    pos: '[clear [通道] [模型]]',
    flags: {},
    switches: ['--clear', '--json'],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo models', 'atwo models clear workbuddy Hy3', 'atwo models clear', 'atwo models --json'],
  },
  new: {
    summary: '开一个任务（写 .atw/tasks/ 记录）。不派活、不花钱。',
    pos: '"一句话说清要做什么"',
    flags: { '--size': 'S|M|L（默认 M）' },
    switches: [],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo new "给 lib/report.mjs 加一个失败原因列" --size S'],
  },
  go: {
    summary: '按档位派活：并行跑 → 落盘 → 程序验收 → 异源评审。会真派 AI，最贵的一条。',
    pos: '<任务源：.md 或一句话>',
    flags: { '--size': 'S|M|L' },
    switches: ['--plan', '--all-lanes', '--no-canary', '--two-phase'],
    passThrough: true,
    strict: false,
    cost: 'spawn',
    writes: true,
    examples: ['atwo go prd.md --size M', 'atwo go "把 README 的安装段重写" --plan  # 只算参数不派活'],
  },
  check: {
    summary: '只跑验收器，不派活。改完文件先跑这个比派活便宜一万倍。',
    pos: '<文件> [更多文件...]',
    flags: { '--lines': '120-180', '--exports': 'a,b', '--sections': '9' },
    switches: [],
    strict: true,
    cost: 'io',
    writes: false,
    examples: ['atwo check lib/humanize.mjs --lines 120-180 --exports humanVerdict'],
  },
  diff: {
    summary: '几份产物跑同一组用例，把分歧变成选择题（机器版 decisions.json + 人话版 md）。',
    pos: '<用例文件.mjs>',
    flags: { '--out': '输出目录' },
    switches: [],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo diff _probe/div_cases.mjs'],
  },
  judge: {
    summary: '三值裁决：这组证据够不够下结论（可判 / 存疑 / 别判）。纯计算，不派活。',
    pos: '',
    flags: { '--z': '3.1,2.9,3.4', '--input': '含 z 值的 json', '--votes': 'A,R,A', '--expect': '应评名额', '--url': '判定服务地址', '--timeout': '毫秒' },
    switches: ['--remote', '--attest'],
    strict: true,
    cost: 'io',
    writes: true,   // --attest 时写 memory/attest-judge.jsonl
    examples: ['atwo judge --z 3.1,2.9,3.4', 'atwo judge --votes A,A,A --expect 3', 'atwo judge --votes A,A,R --expect 3 --remote --url http://ORACLE_HOST:8731'],
  },
  cost: {
    summary: '每任务成本账：读 memory/cost.jsonl，按通道/模型/任务三个维度聚合（token 未采集时只报墙钟与调用数）。',
    pos: '',
    flags: { '--since': 'ISO 时间，只看这之后' },
    switches: [],
    strict: true,
    cost: 'io',
    writes: false,
  },
  review: {
    summary: '对已有的 fanout 目录补做一次父审（可排进队列用 GUI 通道慢慢跑，不占前台）。',
    pos: '',
    flags: { '--dir': '要补审的 .atw/fanout/<时间戳> 目录', '--lane': '用哪个通道当父审（默认 codebuddy）', '--task': '原任务文本（缺省注明没写）', '--timeout': '毫秒' },
    switches: [],
    strict: true,
    cost: 'io',
    writes: true,
  },
  pool: {
    summary: '多池并发跑队列：按通道硬上限分池（codebuddy 6 / GUI 1），某通道连续失败自动改派。',
    pos: 'run|plan',
    flags: { '--max': '一次领几条（1-12，默认 4）', '--lanes': 'codebuddy,codex,ollama 指定池子' },
    switches: [],
    strict: true,
    cost: 'spawn',
    writes: true,
  },
  queue: {
    summary: '把任意 atwo 命令排进落盘队列，掉电/爆窗/进程被杀都不丢；supervisor 每 5 分钟领活跑。',
    pos: 'add|list|run|requeue',
    flags: { '--args': 'JSON 数组：这条作业要传给动词的参数', '--note': '备注（写进作业文件）', '--max': '一次领几条（1-6，默认 2）' },
    switches: [],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo queue add fanout --args \'["给 lib 补边界用例","--parts","3"]\'', 'atwo queue run --max 2', 'atwo queue list'],
  },
  fanout: {
    summary: '父会话派 N 个子会话（独立上下文），子干父审、父只审不干。会真派 AI。',
    pos: '"要让子会话干什么"',
    flags: { '--parts': '2-14（默认 3；≤6 走单通道，>6 溢出到免费本地通道）', '--timeout': '毫秒（默认 180000）', '--review-model': '父审模型', '--review-lane': '父审通道（codebuddy/trae/workbuddy/doubao/ollama；默认同主力=同源）', '--child-model': '子通道模型', '--fix': '0|1|2 自愈轮数（默认 0）', '--task-file': '从文件读任务（长文本走这个，避免 shell 转义变形）', '--lanes': 'codebuddy,ollama 指定通道（默认 auto 真探测后编队）', '--child-tools': '子会话可用工具（默认 Read,Grep,Glob = 只读）', '--split': 'N 长尾切分：把最慢那一路按可枚举单元切成 N 片（不带值=自动，上限 4）', '--review-tier': 'cheap|std|high（cheap=换便宜父审模型，实测 19.5s 同分；high=每片 1 份逐份对引文）', '--review-chunk': 'N（一片放几份；0=全部攒到最后一起审）' },
    switches: ['--dry-run', '--follow', '--active', '--no-lanes', '--no-pregate', '--allow-write', '--allow-run', '--no-resend', '--force-should'],
    strict: true,
    cost: 'spawn',
    writes: true,
    examples: ['atwo fanout --active --parts 3', 'atwo fanout "atwo.mjs 里 EXIT 有哪几个码" --parts 3 --follow', 'atwo fanout --task-file _probe/audit-task.md --parts 3', 'atwo fanout --task-file _probe/audit-task.md --parts 3', 'atwo fanout "..." --dry-run  # 只打印计划不派活'],
  },
  drain: {
    summary: '无人值守入口：把 .atw/inbox/*.task.json 里的任务一条条认领、执行、验收、归档 —— 人不在场也能推进。',
    pos: '',
    flags: { '--limit': '这一轮最多干几条（默认 5）' },
    switches: ['--dry-run'],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo drain --dry-run', 'atwo drain --limit 3'],
  },
  edit: {
    summary: '结构化改文件：指令走 JSON 文件（--spec），字面量匹配、唯一命中、原子提交；改完自动 node --check，语法红则整批回滚。替代手拼补丁脚本与整文件重写。',
    pos: '',
    flags: { '--spec': '指令文件路径（JSON：{ops:[{file,find,replace}]} 或 {ops:[{file,anchor,insert,where}]}）' },
    switches: ['--dry-run', '--no-check'],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo edit --spec _probe/edit.json', 'atwo edit --spec _probe/edit.json --dry-run'],
  },
  stage: {
    summary: '只暂存「我改的那些 hunk」：按 .atw/edits.jsonl 里的片段认领，别人的改动一个都不碰。共享仓库里替代 git add <file>。',
    pos: '',
    flags: { '--assume': '这些文件的所有 hunk 都算我的（显式声明；没走 atwo edit 的改动只能这样认领）' },
    switches: ['--dry-run'],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo stage --dry-run', 'atwo stage', 'atwo stage --assume atwo.mjs,lib/cli-spec.mjs'],
  },
  patch: {
    summary: '让子会话真的动手改代码 —— 但在 git worktree 副本里改，过了验收才出 patch，主仓库零改动。',
    pos: '"要改什么"',
    flags: { '--test': '验收命令（在副本里跑；不给就只做语法检查）', '--parts': '1-3 路写入（默认 1；串行，多路各建一份副本）', '--lane': '写手通道（codebuddy/codex/ollama，默认 codebuddy）', '--model': '写手模型', '--max-turns': '回合上限（默认 24）', '--timeout': '毫秒（默认 600000）' },
    switches: ['--dry-run', '--follow'],
    strict: true,
    cost: 'spawn',
    writes: true,
    examples: ['atwo patch "给 test/split.test.mjs 加一条核 MAX_LOAD_RATIO 的测试" --test "node test/split.test.mjs"', 'atwo patch "..." --dry-run'],
  },
  triage: {
    summary: '分诊台：一批子产物先过机械闸门，判出「机械判死（不送父审）」与「要送父审」，报出这轮真正要花的 LLM 次数。只读、不派活、不花钱。',
    pos: '',
    flags: { '--dir': '产物目录（含 child-N.md）；默认最近一批 .atw/fanout 或 .atw/army' },
    switches: [],
    strict: true,
    cost: 'io',
    writes: false,
    examples: ['atwo triage', 'atwo triage --dir .atw/fanout/20261116-154619'],
  },
  blind: {
    summary: '盲测：用客观标签（引用是否真存在、引文是否真对得上）重算父审的漏判与误杀',
    pos: '',
    flags: { '--manifest': '清单路径（默认 eval/blind-manifest.json）', '--lane': '父审通道（不给就只打标签、不花 LLM 的钱）', '--limit': '只跑前 N 份', '--timeout': '单份父审超时毫秒', '--parts': '并发路数（默认 4；串行 34 份要十几分钟且看不到进度）' },
    switches: [],
    strict: true,
    cost: 'spawn',
    writes: true,
    examples: ['atwo blind', 'atwo blind --lane codebuddy --limit 4', 'atwo blind --lane codebuddy --parts 6'],
  },
  army: {
    summary: '三三制阵型（侦察/主力/评审三段串行）：PRD 批次专用，单元 2-6 个。侦察产出全是候选，主力异题并行，评审只找反例，票面过 judgeVotes 到票率闸门。会真派 AI。',
    pos: '"PRD 文本（能拆出多个单元的那种；一句话任务用 fanout）"',
    flags: { '--units': 'a.mjs,b.mjs 显式指定单元（默认从 PRD 文本抠）', '--reviewers': '1-3 路评审（默认 1；多路才谈得上到票率与分歧）', '--task-file': '从文件读 PRD', '--scout-lane': 'auto|ollama|codebuddy（默认 auto：本地通就用本地快模型）', '--scout-model': '侦察模型名', '--main-lane': '主力通道（默认 codebuddy）', '--main-model': '主力模型名', '--review-lane': '评审通道（默认 codebuddy）', '--review-model': '评审模型名', '--timeout': '毫秒（默认 180000）', '--note': '给评审的批注（优先级高于默认口径）' },
    switches: ['--dry-run', '--follow', '--active', '--no-pregate'],
    strict: true,
    cost: 'spawn',
    writes: true,
    examples: ['atwo army --task-file prd.md --units a.mjs,b.mjs --follow', 'atwo army --active --reviewers 2', 'atwo army --task-file prd.md --dry-run'],
  },
  batch: {
    summary: '一次跑多个任务，最后只出一份汇总报告。会真派 AI，按任务数计。',
    pos: '<任务源1> <任务源2> ...',
    flags: { '--size': 'S|M|L', '--out': '报告目录', '--model': '模型', '--timeout': '毫秒', '--max-fix': 'N', '--label': '标签' },
    switches: ['--dry-run'],
    passThrough: true,
    strict: false,
    cost: 'spawn',
    writes: true,
    examples: ['atwo batch a.md b.md --size S'],
  },
  done: {
    summary: '收工：先验收、再全量回归、再看评审票，任一不过不许结。不派活。',
    pos: '',
    flags: { '--task': '任务目录名', '--expect': '应评名单', '--expect-n': '应评票数' },
    switches: ['--yes', '--force'],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo done', 'atwo done --task 11-16-ternary-vm --yes'],
  },
  state: {
    summary: '现在停在哪、谁在干。只读。',
    pos: '',
    flags: {},
    switches: [],
    strict: true,
    cost: 'io',
    writes: false,
    examples: ['atwo state --json'],
  },
  mode: {
    summary: '看/切运行档位（strict / crazy / off）。只改档位，不派活。',
    pos: '[strict|crazy|off]',
    flags: {},
    switches: [],
    strict: true,
    cost: 'io',
    writes: true,
    examples: ['atwo mode', 'atwo mode crazy'],
  },
  raw: {
    summary: '转发给 orchestra 的老命令（stats / list / health 等 21 个）。',
    pos: '<原命令> ...',
    flags: {},
    switches: [],
    passThrough: true,
    strict: false,
    cost: 'spawn',
    writes: true,
    examples: ['atwo raw stats'],
  },
};

/** 全局开关：每个动词都认。 */
export const GLOBAL_FLAGS = {
  '--json': 'stdout 只出一个 JSON（人话进 log 字段）',
  '--help': '打这个动词的完整规格，绝不派活',
  '--dry-run': '只打印将要做什么，不执行（未实现的动词会明说）',
};

/** 上限与常量：改实现要同时改这里，测试会两边对照。 */
export const LIMITS = {
  maxParts: 6,
  minParts: 2,
  defaultParts: 3,
  defaultTimeoutMs: 180000,
  maxFixRounds: 2,
  childOutputChars: 4000,
};

const isSwitchLike = (a) => typeof a === 'string' && a.length > 1 && a.startsWith('-');

/** 任意位置出现都算求助。 */
export function isHelp(a) {
  return HELP_TOKENS.has(String(a || '').toLowerCase());
}

/** 该动词认哪些带值开关（值可能以 - 开头，例如 --z -0.5）。 */
export function valueFlagsOf(verb) {
  const v = VERBS[verb];
  return new Set(v && v.flags ? Object.keys(v.flags) : []);
}

/**
 * 检查参数里有没有不认识的开关。
 * 返回 { ok, unknown: [...] }。
 *
 * 关键行为：带值开关会把它后面那个 token 一起吃掉 —— 否则
 * `judge --z -0.5,1` 里的 -0.5,1 会被当成「不认识的开关」误拦。
 */
export function checkFlags(verb, args) {
  const v = VERBS[verb];
  if (!v) return { ok: true, unknown: [] };
  // 透传型动词（go / batch / raw）不拦未知开关：它们底层是 orchestra，随时可能加参数，
  // 在这里拦死等于让「atwo go x --新参数」永远用不了新能力。
  if (v.strict === false) return { ok: true, unknown: [] };
  const known = new Set([...Object.keys(v.flags || {}), ...(v.switches || []), ...Object.keys(GLOBAL_FLAGS)]);
  const takesValue = valueFlagsOf(verb);
  const unknown = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!isSwitchLike(a) || !a.startsWith('--')) continue;
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (!known.has(name)) {
      unknown.push(a);
      continue;
    }
    if (takesValue.has(name) && !a.includes('=') && i + 1 < args.length) i++;
  }
  return { ok: unknown.length === 0, unknown };
}

/** 位置参数（去掉开关与其值）。给调用方做「缺参数」提示时用。 */
export function positional(verb, args) {
  const takesValue = valueFlagsOf(verb);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!isSwitchLike(a)) { out.push(a); continue; }
    if (!a.startsWith('--')) continue;
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (takesValue.has(name) && !a.includes('=')) i++;
  }
  return out;
}

/** 单动词规格（机器版）。 */
export function specOf(verb) {
  const v = VERBS[verb];
  if (!v) return null;
  return {
    verb,
    summary: v.summary,
    usage: 'atwo ' + verb + (v.pos ? ' ' + v.pos : '') + Object.entries(v.flags || {}).map(([k, d]) => ' [' + k + ' ' + d + ']').join('') + (v.switches || []).map((s) => ' [' + s + ']').join(''),
    positional: v.pos || null,
    flags: { ...(v.flags || {}) },
    switches: [...(v.switches || [])],
    strict: !!v.strict,
    passThrough: !!v.passThrough,
    cost: v.cost,
    writes: !!v.writes,
    examples: [...(v.examples || [])],
  };
}

/** 全量规格：AI 自学用，一条命令拿全。 */
export function capsJson() {
  return {
    contract: 'atwo-caps/1',
    name: 'atwo',
    // 三条自我说明，防止 AI 把「帮助」当成任务
    note: [
      'atwo 是给 AI 用的编排 CLI。人只看结论，机器只读 --json。',
      '任何位置的 -h / --help / help 都是求助，不会变成任务文本、不会派活。',
      '不认识的参数一律退出 2 并列出可用参数 —— 不会静默忽略。',
    ],
    globalFlags: { ...GLOBAL_FLAGS },
    exitCodes: { ...EXIT_CODES },
    limits: { ...LIMITS },
    verbs: Object.fromEntries(Object.keys(VERBS).map((k) => [k, specOf(k)])),
  };
}

/** 人读的紧凑规格（终端里一眼看完，不刷屏）。 */
export function formatSpec(verb) {
  const s = specOf(verb);
  if (!s) return null;
  const L = [];
  L.push('atwo ' + verb + ' — ' + s.summary);
  L.push('');
  L.push('用法：' + s.usage);
  if (s.positional) L.push('位置参数：' + s.positional);
  const fl = Object.entries(s.flags);
  if (fl.length) {
    L.push('带值开关：');
    for (const [k, d] of fl) L.push('  ' + k.padEnd(16) + d);
  }
  if (s.switches.length) L.push('开关位：' + s.switches.join(' '));
  L.push('代价：' + (s.cost === 'spawn' ? '会真派 AI（按次计）' : s.cost === 'io' ? '只读写本地' : '不做事') + (s.writes ? ' · 会改文件' : ' · 不改文件'));
  if (!s.strict) L.push('参数：不通用的开关会原样透传给下层');
  if (s.examples.length) {
    L.push('例：');
    for (const e of s.examples) L.push('  ' + e);
  }
  L.push('');
  L.push('（机器版：atwo ' + verb + ' --help --json）');
  return L.join(String.fromCharCode(10));
}