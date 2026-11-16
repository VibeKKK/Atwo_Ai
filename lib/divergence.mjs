/**
 * @file lib/divergence.mjs
 * @description 把多份 AI 产物在同一个模块上的行为差异，归并成人能直接回答的二选一清单。
 *              分歧只由用例执行结果（返回值 / 抛出的错误名）判定，不读源码、不猜意图；零依赖。
 */

/** 议题归类：按顺序匹配用例名，先命中先用。 */
const TOPICS = [
  { topic: '负数', words: ['负', 'minus', 'negative', '符号', 'sign'] },
  { topic: '非法输入', words: ['非法', '脏', '类型', '字符串', 'null', 'undefined', 'nan', 'invalid', 'type', '空'] },
  { topic: '超范围', words: ['超', '越界', '溢出', 'infinity', 'range', '上限', '大数'] },
];
const FALLBACK_TOPIC = '其他';
const NO_CLEAR = '两条路都有道理，取决于调用方。';
const PLACEHOLDERS = ['', '—', '--', 'n/a', 'null', 'undefined', 'nan', 'nil'];
const MAX_BRIEF = 28;

/** 安全转字符串：对象自带会抛错的 toString 也不让调用方崩。 */
function safeString(value) {
  try { return String(value); } catch { return '[无法转成字符串]'; }
}

/** 取错误名；抛出的不是 Error（字符串 / 数字 / null）时也给一个稳定名字。 */
function errorName(err) {
  if (err && typeof err.name === 'string' && err.name) return err.name;
  return err instanceof Error ? 'Error' : typeof err;
}

/**
 * 跑一个用例：返回值和抛错收敛成同一种形状，抛错属于正常结果，不许让调用崩。
 * fn 同时作为 this 与第一个实参传入，用例写 () => … 或 (fn) => … 都能用。
 * @param {Function} call 用例调用函数
 * @param {object} fn 被测函数对象
 * @returns {{ mark: string }} 短标记
 */
function runCase(call, fn) {
  try { return { mark: safeString(call.call(fn, fn)) }; } catch (err) { return { mark: `throw:${errorName(err)}` }; }
}

/**
 * 把字面输出压成「行为类别」。
 *
 * 为什么需要这一层：`-1 KB`、`-00:01:30`、`-1分30秒` 是三个不同函数的输出，
 * 字面完全不一样，但对「负数该怎么处理」这个问题它们是同一个答案 —— 保留符号。
 * 只按字面分组会把一个问题炸成九个选项，人就答不了了。
 * @param {string} mark runCase 的短标记
 * @returns {string} 行为类别
 */
function behaviorOf(mark) {
  const text = safeString(mark);
  if (text.startsWith('throw:')) return '报错 ' + text.slice(6);
  if (isPlaceholder(text)) return '占位符';
  if (isZeroish(text)) return '夹成 0';
  if (text.includes('-')) return '保留负号';
  return '正常值';
}

/**
 * 按同一组用例跑所有产物，行为相同的并成一组。
 * @param {Array<{agent: string, fn: object}>} products 各通道产物
 * @param {Array<{name: string, call: Function}>} cases 边界用例
 * @returns {{groups: Array, divergences: Array}} 逐用例分组；divergences 只含组数 > 1 的条目
 */
export function groupByBehavior(products, cases) {
  const live = (Array.isArray(products) ? products : []).filter((p) => p && typeof p.agent === 'string');
  const groups = [];
  const divergences = [];
  for (const item of Array.isArray(cases) ? cases : []) {
    if (!item || typeof item.call !== 'function') continue;
    const byMark = new Map();
    for (const product of live) {
      const { mark } = runCase(item.call, product.fn);
      byMark.set(mark, [...(byMark.get(mark) || []), product.agent]);
    }
    const caseGroups = [...byMark].map(([mark, agents]) => ({ mark, agents, behavior: behaviorOf(mark) }));
    const record = { case: safeString(item.name), groups: caseGroups };
    groups.push(record);
    if (caseGroups.length > 1) divergences.push(record);
  }
  return { groups, divergences };
}

/**
 * 把分歧按「同一类输入」并成决策点。id 依次为 D1 / D2 …，推不出推荐时 recommend 为 null。
 * @param {Array} divergences groupByBehavior 的第二项
 * @returns {Array<{id: string, topic: string, covers: string[], options: Array, recommend: ?string, why: string, cost: string}>}
 */
export function mergeDecisions(divergences) {
  return splitByBehavior(divergences).decisions;
}

/**
 * 把分歧拆成「要人拍板的决策点」和「只是格式不同的差异」。
 *
 * 归并键是议题，选项是行为类别而不是字面值：
 * `-1 KB`、`-00:01:30`、`-1分30秒` 字面全不一样，但对「负数怎么处理」它们是同一个答案。
 * 只按字面分组会把一个问题炸成九个选项 —— 那不是选择题，是列表。
 * @param {Array} divergences groupByBehavior 的第二项
 * @returns {{decisions: Array, formatOnly: Array}} formatOnly 里是行为一致、只是写法不同的用例
 */
export function splitByBehavior(divergences) {
  // 第一步：按「函数名 + 议题」分桶，保证不同函数的证据不会互相顶替。
  // 只按议题归并会把 formatBytes(-1024)（保留负号）和 formatPercent(-0.5)（报错）混成一个问题，
  // 于是「报错」被推成全局答案 —— 但那份产物对 formatBytes 其实保留了负号，推荐语会误导人。
  const buckets = new Map();
  for (const item of Array.isArray(divergences) ? divergences : []) {
    if (!item || !Array.isArray(item.groups) || item.groups.length < 2) continue;
    const groups = item.groups.map((g) => ({ ...g, behavior: g.behavior || behaviorOf(g.mark) }));
    const topic = topicOf(item.case);
    const key = scopeOf(item.case) + ' :: ' + topic;
    if (!buckets.has(key)) buckets.set(key, { topic, scope: scopeOf(item.case), items: [] });
    buckets.get(key).items.push({ ...item, groups });
  }
  // 第二步：先剔掉「只有一种行为」的桶（那是写法差异，不进决策点），
  // 再把「同一议题 + **推荐答案相同**」的桶合成一个决策点。
  //
  // 判据用「议题 + 推荐答案」，不用函数名，也不用选项集合：
  // - `formatBytes` 与 `formatDuration` 的负数都推荐「保留负号」→ 对提问的人是同一个问题，问一次就够；
  // - `formatPercent` 的负数推荐的是「报错」，跟「保留负号」不是一个答案 → 合并会让推荐语答非所问，必须分开；
  // - 非法输入里「多出一个正常值选项」不影响推荐答案（都是报错）→ 仍算同一个问题，不该再问第二遍。
  // 这条判据来自实测：par7 四份产物按函数名分桶是 4 个决策点，A4 要求 ≤3。
  const formatOnly = [];
  const candidates = [];
  for (const { topic, scope, items } of buckets.values()) {
    const options = collectBehaviorOptions(items);
    // 行为只有一种 = 字面不同但语义一致（`1h 1m 1s` vs `01:01:01`）。
    // 那不算要人拍板的问题，不进决策点；但也不静默丢 —— 单独列出来给人看。
    if (options.length < 2) {
      for (const item of items) {
        formatOnly.push({ topic, case: item.case, marks: item.groups.map((g) => ({ mark: g.mark, agents: g.agents })) });
      }
      continue;
    }
    const { index } = recommendBehavior(options);
    candidates.push({ topic, scope, items, answer: index === -1 ? '' : options[index].behavior });
  }
  const merged = new Map();
  for (const { topic, scope, items, answer } of candidates) {
    const key = topic + ' :: ' + answer;
    if (!merged.has(key)) merged.set(key, { topic, scopes: [], items: [] });
    const bucket = merged.get(key);
    if (scope && !bucket.scopes.includes(scope)) bucket.scopes.push(scope);
    bucket.items.push(...items);
  }
  const decisions = [];
  for (const { topic, scopes, items } of merged.values()) {
    const options = collectBehaviorOptions(items);
    const { index, why } = recommendBehavior(options);
    decisions.push({
      id: `D${decisions.length + 1}`, topic, scope: scopes.join(' / '), covers: items.map((item) => item.case), options,
      recommend: index === -1 ? null : options[index].label, why, cost: costOfBehavior(options, index),
    });
  }
  return { decisions, formatOnly };
}

/** 从用例名取被测函数名（`formatBytes 负数 -1024` → `formatBytes`），取不到给空串。 */
function scopeOf(name) {
  const m = String(name || '').match(/^([A-Za-z_$][\w$]*)/);
  return m ? m[1] : '';
}

/** 从用例名判断它属于哪类输入，只用于归并，不参与分歧判定。 */
function topicOf(name) {
  const text = safeString(name).toLowerCase();
  const hit = TOPICS.find((entry) => entry.words.some((word) => text.includes(word)));
  return hit ? hit.topic : FALLBACK_TOPIC;
}

/** 取出标记里的数字部分（保留小数点），不依赖正则。 */
function digitsOf(mark) {
  let out = '';
  for (const ch of mark) if ((ch >= '0' && ch <= '9') || ch === '.') out += ch;
  return out;
}

/** 返回值是不是「零」（0、0 B、0.00%、0秒 之类），说明信息被夹掉了。 */
function isZeroish(mark) {
  const digits = digitsOf(mark);
  return digits !== '' && Number(digits) === 0;
}

/** 返回值是不是占位符（不给数字，只给一个「没有」的记号）。 */
function isPlaceholder(mark) {
  return PLACEHOLDERS.includes(mark.trim().toLowerCase());
}

/** 把一个议题下的所有分歧摊平成选项：mark 相同的合并，agents 取并集。 */
function collectBehaviorOptions(items) {
  const seen = new Map();
  for (const item of items) for (const group of item.groups || []) {
    const behavior = group.behavior || behaviorOf(group.mark);
    if (!seen.has(behavior)) seen.set(behavior, { behavior, agents: [], examples: [] });
    const option = seen.get(behavior);
    for (const agent of group.agents || []) if (!option.agents.includes(agent)) option.agents.push(agent);
    // 例子最多留 3 条：足够看出「谁写了什么」，多了就把选择题变成长文
    if (option.examples.length < 3) option.examples.push(item.case + ' → ' + group.mark);
  }
  return [...seen.values()].map((option, index) => ({ ...option, label: String.fromCharCode(65 + index) }));
}

/**
 * 按「保留信息 > 吞掉信息」推一个选项：抛错、保留符号、给真实值的优先。
 * 只有恰好两种行为时才推；规则打架或都推不出就返回 -1，把选择交还给人。
 * @param {Array} options 选项表
 * @returns {{index: number, why: string}}
 */
/** 信息保留度：越靠上越不藏信息。多选项时靠它排序，而不是只认「恰好两种」。 */
const KEEP_RANK = [
  { test: (b) => b.startsWith('报错'), rank: 5,
    why: '报错把「输入不对劲」明确还给调用方，不藏；代价是调用方必须接住，漏接就崩。' },
  { test: (b) => b === '保留负号', rank: 4,
    why: '带符号保留了方向；抹平的一方让「欠了」和「没有」看起来一样。' },
  { test: (b) => b === '正常值', rank: 3,
    why: '照实算没伪装；代价是脏输入会一路流到界面上去。' },
  { test: (b) => b === '占位符', rank: 2,
    why: '占位符让下游一眼看出「这里没值」；代价是展示和累加都要额外判断。' },
  { test: (b) => b === '夹成 0', rank: 1,
    why: '夹成 0 丢掉了输入里原有的信息，下游分不清「确实是 0」和「算不出来」。' },
];

function rankOf(behavior) {
  const hit = KEEP_RANK.find((entry) => entry.test(behavior));
  return hit ? hit.rank : 0;
}

function recommendBehavior(options) {
  if (options.length < 2) return { index: -1, why: NO_CLEAR };
  const sorted = options.slice().sort((a, b) => rankOf(b.behavior) - rankOf(a.behavior));
  if (rankOf(sorted[0].behavior) === rankOf(sorted[1].behavior)) return { index: -1, why: NO_CLEAR };
  const whyEntry = KEEP_RANK.find((entry) => entry.test(sorted[0].behavior));
  return { index: options.indexOf(sorted[0]), why: whyEntry ? whyEntry.why : NO_CLEAR };
}

/** 把 mark 压成一句话能读完的短串。 */
function brief(mark) {
  if (!mark) return '空字符串';
  return mark.length > MAX_BRIEF ? `${mark.slice(0, MAX_BRIEF)}…` : mark;
}

/** 选了这个返回值要付什么代价。 */
function consequence(behavior) {
  if (behavior.startsWith('报错')) return '调用方必须接住这个错，漏接就把一次普通调用变成崩溃。';
  if (behavior === '占位符') return '下游拿到的是占位符而不是数字，展示和累加都要额外判断。';
  if (behavior === '夹成 0') return '真实值被抹成 0，下游分不清「确实是 0」和「算不出来」。';
  if (behavior === '保留负号') return '展示层会看到负号，得上游保证不会把负数喂进来。';
  return '调用方拿到格式化的字符串后要自己判断它是否符合预期。';
}

/** 写清选另一边的代价。 */
function costOfBehavior(options, index) {
  if (options.length < 2) return '只有一种行为，没有另一边可选。';
  if (index === -1) return options.map((o) => `选 ${o.label}（${o.behavior}）就要接受：${consequence(o.behavior)}`).join('；');
  const other = options.find((o) => o !== options[index]);
  return `选 ${other.label}（${other.behavior}）的代价：${consequence(other.behavior)}`;
}

/** 通道名列表 → 「trae、doubao 」。 */
function agentsText(agents) {
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  return list.length ? `${list.join('、')} ` : '没跑到的通道 ';
}

/** 把 mark 翻成一句人话。 */
function describe(option) {
  const behavior = option.behavior || behaviorOf(option.mark);
  const sample = (option.examples || [])[0];
  return sample ? `${behavior}（例：${sample}）` : behavior;
}

/**
 * 渲染成 markdown：每个决策点一段，含现象、两边各是谁、推荐与代价。
 * @param {Array} decisions mergeDecisions 的结果
 * @returns {string} markdown；没有决策点时是一句「没有分歧」
 */
export function renderDecisions(decisions, opts = {}) {
  const list = (Array.isArray(decisions) ? decisions : []).filter(Boolean);
  const formatOnly = Array.isArray(opts.formatOnly) ? opts.formatOnly.filter(Boolean) : [];
  const parts = [];
  if (list.length) parts.push(list.map(renderOne).join('\n\n'));
  else parts.push('没有需要你拍板的分歧：所有产物行为一致');
  if (formatOnly.length) {
    const lines = formatOnly.map((item) => '- ' + item.case + '：' + item.marks.map((m) => m.agents.join('/') + ' = ' + brief(m.mark)).join('  |  '));
    parts.push('## 只是写法不同（不用回答）\n\n下面这些用例各产物给的字符串不一样，但行为一致，不影响你怎么用：\n\n' + lines.join('\n'));
  }
  return parts.join('\n\n');
}

/** 单个决策点的一段 markdown。 */
function renderOne(decision, seq) {
  const id = decision.id || `D${seq + 1}`;
  const options = Array.isArray(decision.options) ? decision.options : [];
  const covers = Array.isArray(decision.covers) ? decision.covers : [];
  const recommended = options.find((option) => option.label === decision.recommend);
  const bullets = options.map((o) => `- ${o.label}（${agentsText(o.agents)}这样写）：${describe(o)}`);
  const tail = recommended ? `${recommended.label} ${describe(recommended)}` : '两种都行';
  return [
    `## ${id} ${decision.scope ? decision.scope + ' · ' : ''}${decision.topic || FALLBACK_TOPIC}`,
    `现象：${covers.length} 个用例上分成 ${options.length} 种行为${covers.length ? `（${covers.join('、')}）` : ''}。`,
    ...bullets,
    `推荐：${tail}（${decision.why || NO_CLEAR}）`,
    `代价：${decision.cost || '未评估'}`,
  ].join('\n\n');
}
