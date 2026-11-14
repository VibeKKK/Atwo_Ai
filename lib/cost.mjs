// node --check lib/cost.mjs

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 汇总多次运行的元信息。
 * 把「缺字段按 0」统一交给 num() 兜底，是为了让残缺的上报数据也能参与求和而不抛
 * 异常；按 agent 单独累计，是为了让成本表能定位到具体是谁最耗时、最费 token。
 * wallMs 为 0 时直接给 speedup=1，避免除零得到 Infinity 再污染后续格式化。
 * @param {Array<object>} metaList 运行元信息列表
 * @returns {{runs:number,tasks:number,ok:number,failed:number,wallMs:number,serialMs:number,savedMs:number,speedup:number,inputTokens:number,outputTokens:number,byAgent:Record<string,object>}} 汇总结果
 */
export function summarize(metaList) {
  const list = Array.isArray(metaList) ? metaList : [];
  const byAgent = new Map();
  let tasks = 0;
  let ok = 0;
  let failed = 0;
  let wallMs = 0;
  let serialMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const raw of list) {
    const run = isObj(raw) ? raw : {};
    wallMs += num(run.wallMs);
    serialMs += num(run.serialMs);
    const runTasks = Array.isArray(run.tasks) ? run.tasks : [];
    for (const rawTask of runTasks) {
      const task = isObj(rawTask) ? rawTask : {};
      const agent = typeof task.agent === 'string' && task.agent ? task.agent : 'unknown';
      const inT = num(task.inputTokens);
      const outT = num(task.outputTokens);
      const ms = num(task.ms);
      tasks += 1;
      inputTokens += inT;
      outputTokens += outT;
      if (task.ok) ok += 1;
      else failed += 1;
      let a = byAgent.get(agent);
      if (!a) {
        a = { tasks: 0, ok: 0, failed: 0, ms: 0, inputTokens: 0, outputTokens: 0 };
        byAgent.set(agent, a);
      }
      a.tasks += 1;
      a.ms += ms;
      a.inputTokens += inT;
      a.outputTokens += outT;
      if (task.ok) a.ok += 1;
      else a.failed += 1;
    }
  }

  return {
    runs: list.length,
    tasks,
    ok,
    failed,
    wallMs,
    serialMs,
    savedMs: serialMs - wallMs,
    speedup: wallMs > 0 ? serialMs / wallMs : 1,
    inputTokens,
    outputTokens,
    byAgent: Object.fromEntries(byAgent),
  };
}

/**
 * 把 token 数压成 K/M/B/T 短标签。
 * K 档保留 1 位、M 及以上保留 2 位小数，才能同时命中 1234->1.2K 与
 * 1234567->1.23M 两种示例精度；再用 Number(toFixed()) 去掉尾零，避免输出
 * 1.0K / 1.00M 这类读起来别扭的结果。
 * @param {number} n token 数量
 * @returns {string} 带单位的可读字符串
 */
export function fmtTokens(n) {
  const v = num(n);
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const tiers = [
    { unit: 1e12, suffix: 'T', digits: 2 },
    { unit: 1e9, suffix: 'B', digits: 2 },
    { unit: 1e6, suffix: 'M', digits: 2 },
    { unit: 1e3, suffix: 'K', digits: 1 },
  ];
  for (const { unit, suffix, digits } of tiers) {
    if (abs >= unit) return `${sign}${Number((abs / unit).toFixed(digits))}${suffix}`;
  }
  return `${sign}${abs}`;
}

/**
 * 格式化美元成本。
 * 单价按「每百万 token」计，单次调用常常不足 1 美分；若一律保留 2 位小数会显示成
 * $0.00 而掩盖真实开销，所以金额越小保留越多位小数。
 * @param {number} usd 美元金额
 * @returns {string} 带 $ 前缀的金额
 */
export function fmtCost(usd) {
  const v = num(usd);
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const digits = abs > 0 && abs < 0.01 ? 6 : 2;
  return `${sign}$${abs.toFixed(digits)}`;
}

/**
 * 按「每百万 token 单价」估算费用。
 * 默认 0.28 取自常见输入档单价，做成默认参数是为了只传 token 数就能用、同时保留
 * 覆盖单价的余地��返回未四舍五入的原始值，避免提前丢精度影响 fmtCost 的展示。
 * @param {number} tokens token 总数
 * @param {number} [pricePerM=0.28] 每百万 token 的美元单价
 * @returns {number} 估算的美元成本
 */
export function estimateCost(tokens, pricePerM = 0.28) {
  return (num(tokens) / 1e6) * num(pricePerM);
}

/**
 * 把汇总结果渲染成纯文本对齐表格。
 * 不引入终端库：先算每列最大宽度再 padStart/padEnd，保证等宽字体下数值右对齐、
 * agent 左对齐；额外补一行整体指标，是因为 speedup/savedMs 属于全局量，塞进按
 * agent 分列的表里会语义错位。
 * @param {object} summary summarize 的输出
 * @returns {string} 多行纯文本表格
 */
export function renderCostTable(summary) {
  const s = isObj(summary) ? summary : {};
  const byAgent = isObj(s.byAgent) ? s.byAgent : {};
  const head = ['Agent', 'Tasks', 'OK', 'Fail', 'Serial(ms)', 'In', 'Out', 'Cost'];
  const cells = [head];

  for (const [name, raw] of Object.entries(byAgent)) {
    const a = isObj(raw) ? raw : {};
    const i = num(a.inputTokens);
    const o = num(a.outputTokens);
    cells.push([
      name,
      String(num(a.tasks)),
      String(num(a.ok)),
      String(num(a.failed)),
      String(num(a.ms)),
      fmtTokens(i),
      fmtTokens(o),
      fmtCost(estimateCost(i + o)),
    ]);
  }

  const ti = num(s.inputTokens);
  const to = num(s.outputTokens);
  cells.push([
    'TOTAL',
    String(num(s.tasks)),
    String(num(s.ok)),
    String(num(s.failed)),
    String(num(s.serialMs)),
    fmtTokens(ti),
    fmtTokens(to),
    fmtCost(estimateCost(ti + to)),
  ]);

  const widths = head.map((_, c) => Math.max(...cells.map((r) => r[c].length)));
  const pad = (r) => r.map((v, c) => (c === 0 ? v.padEnd(widths[c]) : v.padStart(widths[c]))).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const lines = [pad(cells[0]), sep];
  for (let i = 1; i < cells.length - 1; i += 1) lines.push(pad(cells[i]));
  if (cells.length > 2) lines.push(sep);
  lines.push(pad(cells[cells.length - 1]));
  lines.push(sep);
  lines.push(`Runs ${num(s.runs)} | Wall ${num(s.wallMs)}ms | Saved ${num(s.savedMs)}ms | Speedup ${num(s.speedup).toFixed(2)}x`);
  return lines.join('\n');
}
