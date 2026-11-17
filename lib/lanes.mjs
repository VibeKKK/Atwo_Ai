// lib/lanes.mjs —— 编队层：把「谁去干这一路」从代码里抽出来，变成可探测、可编排的表。
//
// 编队的三条硬约束（实测得来，不是设计偏好）：
//   1) 能真并行的只有 CLI/HTTP 通道；GUI 通道（trae/workbuddy/doubao）单窗口独占，parallel=1。
//   2) 通道质量不同：给一件机械活开 6 路本地 8B，比开 3 路云端慢；给一件要判断的活开本地，等于没审。
//   3) 通道可用性会变（服务没跑 / CLI 起不来 / 额度耗尽）→ 必须真探测，不能按「配置里有」就当能用。
import { rankByHealth } from './lane-health.mjs';
import { askCodeBuddy } from '../agents/codebuddy.mjs';
import { askOllama, probeOllama } from '../agents/ollama.mjs';
import { askDeepSeek, probeDeepSeek } from '../agents/deepseek.mjs';
import { askCodex, probeCodex } from '../agents/codex.mjs';

/**
 * parallel 来自实测：codebuddy 12 路时单路由 4.85s 涨到 11.05s、吞吐停在 0.96/s，所以取 6。
 * role：writer 可以出产物，review 只适合当评审（GUI 通道写文件容易和父会话抢同一窗口）。
 */
/**
 * GUI 通道的 ask 用**懒加载**包一层：import 时不碰 CDP，第一次调用才连。
 * 为什么必须接上来（2026-11-16）：父审一直是 codebuddy —— 主力也是 codebuddy，
 * 等于自己审自己。异源评审是这套系统唯一能拿到「不同厂商的语料」的地方，
 * 通道在编队表里却 ask=null，等于把这条路堵死了。
 * 返回形状与 codebuddy 对齐（{addedText, ...}），所以父审不需要知道对面是谁。
 */
/**
 * 占位回答：GUI 通道（Trae 尤其）会在答案还没出来时先把界面上那句「思考中」当答案返回。
 * 2026-11-17 实测：父审通道给 trae，REVIEW-RAW.md 全文 9 字节 = 「思考中」，
 * 于是两条票被记成「父会话没有对这条给票」—— 真正原因是通道没答完，不是父审漏答。
 * 这种「看起来像答案的界面文案」必须在这里拦掉：宁可报通道失败，也不能让它冒充判定。
 */
const PLACEHOLDER_RE = /^(?:思考中|正在思考|正在生成|生成中|Thinking|Analyzing|…|\.{2,})$/i;
export function looksPlaceholder(text) {
  const s = String(text == null ? '' : text).replace(/[\s\u200b~]+/g, '').trim();
  return s === '' || PLACEHOLDER_RE.test(s);
}

/**
 * 通道错误文案：GUI 通道把「服务端出错」当正常回答返回。
 * 2026-11-17 实测 WorkBuddy 当父审，整份输出是「抱歉，发生未知错误暂无响应。您可以稍后再试，
 * 或尝试新建任务、切换模型。 / Kimi-K3.1-Pro」—— 解析器当成「没给票」，于是两条票被记成
 * 「父会话没有对这条给票」。真正原因是通道没答，必须报通道失败。
 * 只认短文本 + 开头短语：长回答里出现「抱歉」是正常表达，不能一刀切。
 */
/**
 * 未完成：GUI 通道会先把半截答案吐出来，尾巴上挂着界面状态。
 * 2026-11-17 实测 WorkBuddy 当父审，正文是「读取 reviewer-ledger.mjs / [ / 生成回复中 / 已消耗 6.22」
 * —— JSON 数组只写了开头就断了，解析器得到 0 条票。这不是它不会审，是我们读得太早。
 */
const INCOMPLETE_RE = /(?:生成回复中|正在生成|正在搜索|正在读取|已消耗\s*[\d.]+)/;
export function looksIncomplete(text) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  if (INCOMPLETE_RE.test(s)) return true;
  // 括号不闭合也是「还在写」的强信号（只判数量，不解析内容）
  const opens = (s.match(/[\[{]/g) || []).length;
  const closes = (s.match(/[\]}]/g) || []).length;
  return opens > closes;
}

/**
 * 只回了过程状态：GUI 通道在「思考 + 搜代码」阶段会把界面行当正文吐出来。
 * 2026-11-17 实测 WorkBuddy 当父审，两次都只回：
 *   「正在搜索代码 EXIT / 已消耗 5.56 / 我嘞个豆，这题有点东西」
 * 里面一处判定都没有。把它当答案 → parseReview 得 0 票 → 记账成「父审弃权」，
 * 实际是「我们读得太早」。判据：剥掉状态行与纯数字后剩不下实质内容，且不含任何判定词。
 */
const STATUS_LINE_RE = /^(?:正在|已消耗|已思考|已读取|正在读取|正在搜索|搜索|读取|让我|我嘞|稍等|思考|Thinking|Analyzing)/i;
const VERDICT_WORD_RE = /(?:PASS|REVISE|ACCEPT|通过|退回|打回|重做|不能收|可以收|没问题)/i;
export function looksStatusOnly(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return false;
  if (VERDICT_WORD_RE.test(s)) return false;
  const rest = s.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !STATUS_LINE_RE.test(l) && !/^\d+(?:\.\d+)?$/.test(l));
  return rest.join('').length < 12;
}

const CHANNEL_ERROR_RE = /^(?:抱歉|对不起|很抱歉|发生未知错误|未知错误|服务繁忙|服务器繁忙|请求失败|网络异常|网络错误|no response|unknown error)/i;
export function looksChannelError(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return false;
  if (s.length > 120) return false;   // 120 字以上的「抱歉…」是正常表达（真评审常这么开头），不是通道错误
  return CHANNEL_ERROR_RE.test(s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 硬超时：适配层不认 timeoutMs 时，这一层负责到点就认输。
 * 为什么必须在外面兜：2026-11-17 实测 workbuddy 探活 120s 不返回，
 * 而 probeReviewer 传下去的 timeoutMs 只到适配层 —— 它不理会就等于没有超时。
 */
export function withHardTimeout(promise, ms, label = '通道') {
  const limit = Number(ms);
  if (!(limit > 0)) return promise;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, addedText: '', err: label + ' 在 ' + limit + 'ms 内没有返回（硬超时）' });
    }, limit);
    Promise.resolve(promise).then((v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    }).catch((e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, addedText: '', err: label + ' 抛错：' + String(e && e.message || e) });
    });
  });
}
const lazyAsk = (loader, name = '通道') => async (prompt, opts = {}) => {
  const fn = await loader();
  const once = async () => {
    const r = await fn(prompt, opts);
    return r && typeof r === 'object' ? r : { addedText: String(r == null ? '' : r) };
  };
  const limit = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : Number(process.env.ATWO_LANE_TIMEOUT_MS || 180000);
  let out = await withHardTimeout(once(), limit, name);
  // 硬超时不是「占位」——它已经明确失败了，别再等 15s 重试一次（那是双重浪费）。
  if (out && out.ok === false && /硬超时/.test(String(out.err || ''))) return out;
  // 占位只重试一次：GUI 通道常常「先答一句思考中、稍后才把答案吐出来」。
  // 重试一次能救回大多数情况；再拿不到就是通道真坏了，报失败比编一个判定强。
  // 重试时把静默窗口拉长：GUI 通道「思考中」的停顿常超过适配层默认的 3.5s，
  // 太短会把过程状态当成「答案已稳定」提前交卷（2026-11-17 实测两次都这样）。
  const guiOpts = { ...opts, settleMs: Math.max(Number(opts.settleMs) || 0, Number(process.env.ATWO_LANE_SETTLE_MS || 12000)) };
  const onceGui = async () => {
    const r = await fn(prompt, guiOpts);
    return r && typeof r === 'object' ? r : { addedText: String(r == null ? '' : r) };
  };
  if (looksPlaceholder(out.addedText) || looksIncomplete(out.addedText)) {
    // GUI 通道（尤其 WorkBuddy）会把半截答案连着「生成回复中」一起返回。
    // 默认等到 15s：实测它写完一段还要再花几秒收尾，6s 不够。
    await sleep(Number(process.env.ATWO_LANE_PLACEHOLDER_WAIT_MS || 15000));
    out = await withHardTimeout(onceGui(), limit, name);
  }
  // 只回了过程状态 → 再给它一次机会（换长静默窗口重问），两次都不给结论就如实报失败。
  if (looksStatusOnly(out.addedText)) {
    await sleep(Number(process.env.ATWO_LANE_PLACEHOLDER_WAIT_MS || 15000));
    out = await withHardTimeout(onceGui(), limit, name);
    if (looksStatusOnly(out.addedText)) {
      return {
        ...out, ok: false,
        err: '通道只回了过程状态（' + String(out.addedText || '').replace(/\s+/g, ' ').trim().slice(0, 60) + '），没有给出结论',
      };
    }
  }
  if (looksPlaceholder(out.addedText)) {
    return {
      ...out, ok: false,
      err: '通道返回的是界面占位文案（' + String(out.addedText || '').trim() + '），不是答案',
    };
  }
  // 通道失败原因必须能被上层看到：各适配层的字段名不统一（codex 用 error，其他人用 err），
  // 不归一就会出现「通道返回 ok:false 且没给 err」——排障时等于什么都没说。
  // 2026-11-18 实测：codex 明明返回「codex CLI 不存在：…」，父审退回行却只写「没给 err」。
  if (out && out.ok === false && !out.err && out.error) out = { ...out, err: String(out.error) };

  if (looksChannelError(out.addedText)) {
    return {
      ...out, ok: false,
      err: '通道返回的是错误文案（' + String(out.addedText || '').trim().slice(0, 80) + '），不是答案',
    };
  }
  return out;
};
const askTraeLane = lazyAsk(async () => (await import('../agents/trae.mjs')).askTrae, 'trae');
const askWorkbuddyLane = lazyAsk(async () => (await import('../agents/workbuddy.mjs')).ask, 'workbuddy');
const askDoubaoLane = lazyAsk(async () => {
  const m = await import('../agents/doubao.mjs');
  return m.ask || m.askDoubao;
});

export const LANE_DEFS = {
  codebuddy: { id: 'codebuddy', kind: 'cli', parallel: 6, quality: 3, cost: 'quota', roles: ['writer', 'review'], ask: askCodeBuddy },
  codex: { id: 'codex', kind: 'cli', parallel: 6, quality: 3, cost: 'quota', roles: ['writer', 'review'], ask: askCodex },
  trae: { id: 'trae', kind: 'gui', parallel: 1, quality: 2, cost: 'free', roles: ['review'], ask: askTraeLane },
  workbuddy: { id: 'workbuddy', kind: 'gui', parallel: 1, quality: 2, cost: 'free', roles: ['review'], ask: askWorkbuddyLane },
  doubao: { id: 'doubao', kind: 'gui', parallel: 1, quality: 2, cost: 'free', roles: ['review'], ask: askDoubaoLane },
  ollama: { id: 'ollama', kind: 'http', parallel: 4, quality: 1, cost: 'free', roles: ['writer', 'review'], ask: askOllama },
  // 第二父审（2026-11-17）：官方 API，不受 GUI 菜单/端口/会话条数影响，且天然异源。
  deepseek: { id: 'deepseek', kind: 'http', parallel: 4, quality: 3, cost: 'api', roles: ['writer', 'review'], ask: askDeepSeek },
};

/**
 * 按 id 取 ask。取不到就抛（调用方必须看见），不静默退回 codebuddy ——
 * 静默退回正好制造「以为异源、其实同源」这种最难查的假象。
 */
/**
 * sync 判「这条通道在静态层面值不值得一试」——只排掉**明知不可用**的，不做真探活（探活贵）。
 * 2026-11-18 实测：静态挑选默认落到 codex，而本机 codex app-server 初始化被拒（os error 5），
 * 每次干净 clone 的第一次 fanout 都要白等 5s 才退回主力。
 * GUI 通道不探（探活要碰用户窗口，成本远大于收益）→ 一律 true，起不来由退回机制兜。
 */
export function laneReady(id) {
  const def = LANE_DEFS[id];
  if (!def) return false;
  if (id === 'codex') {
    const p = probeCodex();
    return !!p.available && String(process.env.CODEX_LANE || '') === '1';
  }
  // ollama 要 HTTP 探活才能判，sync 层不赌它：8B 当父审编过引文（2026-11-17 实测）。
  if (id === 'ollama') return false;
  return true;
}

export function resolveAsk(laneId) {
  const id = String(laneId || '').trim();
  if (!id) throw new Error('resolveAsk：没有通道 id');
  const def = LANE_DEFS[id];
  if (!def) throw new Error('resolveAsk：没有这个通道 ' + JSON.stringify(id) + '（可选 ' + Object.keys(LANE_DEFS).join(' / ') + '）');
  if (typeof def.ask !== 'function') throw new Error('resolveAsk：通道 ' + id + ' 没有 ask 实现');
  return def.ask;
}

/** 写手优先级：高质量的在前，免费的本地通道作为溢出兜底（它慢且笨，但不消耗额度）。 */
const WRITER_ORDER = ['codebuddy', 'deepseek', 'codex', 'ollama']; // deepseek 是 HTTP 直连通道，roles 里写了 writer 却不在写手顺序里 —— 多通道并行一直是假的
export const REVIEW_ORDER = ['codebuddy', 'codex', 'deepseek', 'trae', 'workbuddy', 'doubao', 'ollama'];

export function laneIds() {
  return Object.keys(LANE_DEFS);
}

/** 真探测：不可用的通道必须能被编队自动跳过，而不是派出去再失败。 */
export async function probeLanes(opts = {}) {
  const { only } = opts;
  const out = [];
  for (const id of laneIds()) {
    if (only && !only.includes(id)) continue;
    const def = LANE_DEFS[id];
    if (id === 'ollama') {
      const p = await probeOllama(opts.timeoutMs || 4000);
      out.push({ ...p, parallel: def.parallel, quality: def.quality, roles: def.roles, ready: p.available && p.hasModel !== false });
      continue;
    }
    if (id === 'codex') {
      // 本机 codex 已知跑不起来（app-server 初始化被拒，os error 5，2026-11-16 两次实测）。
      // 默认判不可用，避免编队把活派给一个必然失败的通道；换机器时用 CODEX_LANE=1 打开并真跑一次验。
      const p = probeCodex();
      const forced = String(process.env.CODEX_LANE || '') === '1';
      out.push({
        ...p,
        parallel: def.parallel,
        quality: def.quality,
        roles: def.roles,
        ready: !!p.available && forced,
        unverified: true,
        reason: p.available && !forced ? '本机 codex app-server 起不来（os error 5）；要启用设 CODEX_LANE=1 并先 atwo doctor 深探' : p.reason || '',
      });
      continue;
    }
    if (def.kind === 'gui') {
      // GUI 通道要靠 CDP/窗口探测，成本高且会打扰用户窗口 —— 标 unknown，不主动探，编队时默认不当写手。
      out.push({ lane: id, available: null, ready: false, reason: '未探测（GUI 通道需要客户端在跑；默认不当写手）', parallel: def.parallel, quality: def.quality, roles: def.roles });
      continue;
    }
    out.push({ lane: id, available: true, ready: true, parallel: def.parallel, quality: def.quality, roles: def.roles });
  }
  return out;
}

/**
 * 把 N 路活分给可用通道。返回 [{lane, count}] 或抛错（一路都派不出去时要说清为什么）。
 * parts 超过所有通道 parallel 之和时按上限截断 —— 多出来的路不会更快的实测曲线见 LANE_DEFS 注释。
 */
export function planLanes(parts, opts = {}) {
  const n = Math.max(1, Math.floor(Number(parts) || 1));
  const role = opts.role || 'writer';
  const order = role === 'review' ? REVIEW_ORDER : WRITER_ORDER;
  const wanted = opts.lanes && opts.lanes.length ? opts.lanes : order;
  const probes = opts.probes || null;

  // 先校验用户给的名字：写错通道名不能被「过滤后什么都不剩」吞掉，那会变成
  // 一句含糊的「没有可用通道」，让人以为是服务没起。
  if (opts.lanes && opts.lanes.length) {
    for (const id of opts.lanes) {
      if (!LANE_DEFS[id]) throw new Error('未知通道：' + id + '（可用：' + laneIds().join(' / ') + '）');
    }
  }

  const explicit = !!(opts.lanes && opts.lanes.length);
  const usable = [];
  for (const id of order) {
    if (!wanted.includes(id)) continue;
    const def = LANE_DEFS[id];
    if (!def) throw new Error('未知通道：' + id + '（可用：' + laneIds().join(' / ') + '）');
    if (!def.roles.includes(role)) continue;
    if (probes) {
      const p = probes.find((x) => x.lane === id);
      // 探测说不行就跳过，别派了再失败。但用户显式点名的通道要放行：
      // GUI 三条（trae / workbuddy / doubao）默认不探测、ready 恒为 false，
      // 不放行等于「显式指定也永远派不出去」，这三条通道形同不存在（2026-11-17 查实）。
      if (p && p.ready === false && !explicit) continue;
    }
    usable.push({ lane: id, parallel: def.parallel, quality: def.quality, cost: def.cost });
  }
  // 健康度来自账本（最近 7 天真干活的成败），不探活、不发请求。
  // 口径：健康的排前面、没有样本的保持原序、明显不行的沉底但**不删**
  // （删了就没法解释「为什么这一路没被用」，也可能只是样本过期）。
  if (opts.health && opts.health.length && usable.length > 1) {
    const ranked = new Set(rankByHealth(usable, opts.health, { minCalls: opts.healthMinCalls || 5, minRate: opts.healthMinRate || 0.25 }).map((u) => u.lane));
    usable.sort((a, b) => {
      const ia = [...ranked].indexOf(a.lane);
      const ib = [...ranked].indexOf(b.lane);
      return ia - ib;
    });
  }
  if (!usable.length) {
    // 显式指定了通道但角色不匹配时，别报「没有可用通道」—— 那会被读成「服务没起」。
    // 2026-11-17 实测：--lanes workbuddy 直接抛栈、退出码 1，看不出 workbuddy 本来只能当评审。
    if (opts.lanes && opts.lanes.length) {
      const wrong = opts.lanes.filter((id) => LANE_DEFS[id] && !LANE_DEFS[id].roles.includes(role));
      if (wrong.length) {
        const can = laneIds().filter((id) => (LANE_DEFS[id].roles || []).includes(role));
        throw new Error(wrong.join(' / ') + ' 不能当 ' + role + '（它的角色：' + wrong.map((id) => id + '=' + LANE_DEFS[id].roles.join('+')).join('、') + '）；能当 ' + role + ' 的：' + can.join(' / '));
      }
    }
    const why = (probes || []).filter((p) => p.ready === false && p.reason).map((p) => p.lane + '：' + p.reason);
    throw new Error('没有可用通道（role=' + role + '）' + (why.length ? '；' + why.join('；') : ''));
  }

  // 填充策略分两种，因为「没有探测信息」和「探测说都行」是两件事：
  // - 有探测：异源优先 —— 先给每条 ready 通道各一路，剩下的按并行上限填。
  //   原实现一律「填满第一条」，而 codebuddy parallel=6，于是 planLanes(4) 返回 codebuddy×4，
  //   deepseek 明明 ready 却闲置。这就是「多通道并行一直是假的」的机制级原因（2026-11-17 查实）。
  // - 没探测：保持「填满第一条」的老行为。不知道别人能不能用就先把活摊出去，
  //   等于把失败概率乘以路数（codex 在本机必挂，摊到它就是把整批拖死）。
  const plan = [];
  const capacity = usable.reduce((s, u) => s + u.parallel, 0);
  const want = Math.min(n, capacity);
  const placed = new Map();
  if (!probes) {
    let left = want;
    for (const u of usable) {
      if (left <= 0) break;
      const take = Math.min(left, u.parallel);
      placed.set(u.lane, take);
      left -= take;
    }
  } else {
    let left = want;
    for (const u of usable) {
      if (left <= 0) break;
      placed.set(u.lane, 1);
      left -= 1;
    }
    while (left > 0) {
      // 每轮挑「还能再装最多」的那条；同容量时保留 order 的先后（usable 已按顺序）。
      let best = null;
      for (const u of usable) {
        const have = placed.get(u.lane) || 0;
        if (have >= u.parallel) continue;
        if (!best || u.parallel - have > best.parallel - (placed.get(best.lane) || 0)) best = u;
      }
      if (!best) break;
      placed.set(best.lane, (placed.get(best.lane) || 0) + 1);
      left -= 1;
    }
  }
  let total = 0;
  for (const u of usable) {
    const c = placed.get(u.lane) || 0;
    if (c > 0) { plan.push({ lane: u.lane, count: c, quality: u.quality, cost: u.cost }); total += c; }
  }
  // unassigned 是「因为并行上限装不下的路」，不是「内部还剩多少」—— 调用方要用它判断要不要降级。
  return { plan, unassigned: Math.max(0, n - total) };
}

/** 按计划把 children（每路的 prompt）分派到具体通道；lane 内并行，lane 间并行。 */
export async function dispatchLanes(planned, children, opts = {}) {
  const { cwd, timeoutMs, model, onProgress } = opts;
  const jobs = [];
  let k = 0;
  for (const p of planned) {
    for (let i = 0; i < p.count && k < children.length; i += 1) {
      jobs.push({ lane: p.lane, child: children[k], index: k });
      k += 1;
    }
  }
  // 计划比 children 多时按 children 截断；比 children 少时剩下的仍走首选通道（宁可派出，不要静默丢活）
  while (k < children.length) {
    jobs.push({ lane: planned[0].lane, child: children[k], index: k });
    k += 1;
  }
  const results = await Promise.all(jobs.map(async (j) => {
    const def = LANE_DEFS[j.lane];
    // opts.asks 只为测试注入：验证「哪一路落到哪个通道」不需要真起 10 个进程。
    const ask = (opts.asks && opts.asks[j.lane]) || def.ask;
    if (!ask) throw new Error('通道 ' + j.lane + ' 没有 ask 实现（GUI 通道请走 orchestra）');
    if (onProgress) onProgress({ phase: 'lane-start', lane: j.lane, index: j.index });
    const r = await ask(j.child.prompt, { cwd, timeoutMs, model: j.child.model || model });
    if (onProgress) onProgress({ phase: 'lane-done', lane: j.lane, index: j.index, ok: !!(r && r.ok) });
    return { ...r, lane: j.lane, index: j.index };
  }));
  return results.sort((a, b) => a.index - b.index);
}

/** 一行摘要，给 --json 与父审用：每个通道给了几路、谁没上。 */
export function describePlan(planned) {
  return planned.map((p) => p.lane + '×' + p.count).join(' + ');
}