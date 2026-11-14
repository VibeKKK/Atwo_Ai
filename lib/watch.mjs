// 自检: node --check lib/watch.mjs
import process from 'node:process';

const COLORS = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  bold: 1,
};

const DEFAULT_AGENT = 'default';
const MAX_FAIL = 5;
const DEFAULT_THROTTLE_MS = 200;
const BAR_WIDTH = 20;

/**
 * 给文本套 ANSI 颜色，并集中处理「什么时候不该上色」的降级规则。
 * 之所以单独导出而不是塞进 render，是因为日志、单测、其它面板都要复用同一套判断，
 * 否则每处各写一遍 TTY 判断迟早会出现「有的地方带色、有的地方不带」的不一致。
 * enable=false 原样返回：调用方明确知道目标不是终端（写文件、写 CI 日志）时应能一键关掉。
 * 非 TTY 自动降级：进度屏常被管道重定向，硬塞 ANSI 转义序列只会变成乱码，因此以 stdout 为准，
 * 同时兼容 NO_COLOR 约定；未知颜色名也原样返回，避免把拼写错误变成不可见字符。
 *
 * @param {string} text 待着色文本
 * @param {string} color 颜色名
 * @param {boolean|undefined} enable 传 false 强制不上色；其余交给 TTY/环境判断
 * @returns {string} 着色后的文本，或原样文本
 */
export function colorize(text, color, enable) {
  const raw = String(text);
  if (enable === false) return raw;
  if (!process.stdout.isTTY || process.env.NO_COLOR !== undefined) return raw;
  const code = COLORS[color];
  if (code === undefined) return raw;
  return `\x1b[${code}m${raw}\x1b[0m`;
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const secs = Math.round(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m${s}s`;
}

function oneLine(value, limit = 60) {
  const s = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

function normalizeTasks(tasks) {
  const agents = new Map();
  if (typeof tasks === 'number' && Number.isFinite(tasks)) {
    return { total: Math.max(0, Math.floor(tasks)), agents };
  }
  for (const t of tasks ?? []) {
    if (t !== null && typeof t === 'object') {
      agents.set(String(t.id), t.agent || DEFAULT_AGENT);
    } else {
      agents.set(String(t), DEFAULT_AGENT);
    }
  }
  return { total: agents.size, agents };
}

/**
 * 创建实时进度渲染器：onProgress 收集事件、render 返回一屏文本、done 收尾强制刷新。
 * 之所以把收集与渲染拆开并加节流，是因为事件频率由调度器决定（可能一秒上千次），
 * 但终端没必要跟着刷；拆开后 onProgress 永不丢事件（计数始终准确），昂贵的字符串拼接
 * 每 throttleMs 才做一次，render 在窗口内直接复用上次快照。
 * render 只返回字符串、绝不 print：输出目标可能是终端、SSE、UI 面板或测试断言，应由调用方决定；
 * 返回完整一屏而不是逐行移动光标，也能避免重定向/并发写时的半屏残影。
 * 进度分子取「已完成 + 已失败」而非仅成功数：失败若被 retry 会回到运行中并回退分子，
 * 这样进度条才不会卡在某个任务永远到不了 100%。
 *
 * @param {Array<{id?:string|number,agent?:string}|string|number>|number} tasks 初始任务列表，或仅给任务总数
 * @param {{throttleMs?:number, color?:boolean}} [opts] throttleMs 默认 200；color 透传给 colorize 的 enable
 * @returns {{onProgress:(ev:object)=>void, render:()=>string, done:()=>string}}
 */
export function createWatch(tasks, opts = {}) {
  const throttleMs = Number.isFinite(opts.throttleMs)
    ? Math.max(0, opts.throttleMs)
    : DEFAULT_THROTTLE_MS;
  const color = opts.color;

  const { total: initialTotal, agents } = normalizeTasks(tasks);
  let total = initialTotal;

  const running = new Set();
  const completed = new Set();
  const failed = new Set();
  const errors = new Map();

  const startedAt = Date.now();
  let frozenAt = null;
  let cached = null;
  let lastBuildAt = -Infinity;

  const rememberAgent = (id, agent) => {
    if (agent) agents.set(id, agent);
    else if (!agents.has(id)) agents.set(id, DEFAULT_AGENT);
  };

  const onProgress = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    const id = String(ev.id ?? '');
    rememberAgent(id, ev.agent);
    switch (ev.type) {
      case 'start':
        failed.delete(id);
        running.add(id);
        break;
      case 'retry':
        // 重试即重新在跑，清掉旧失败与旧错误，避免同一 id 被重复计入失败清单。
        failed.delete(id);
        completed.delete(id);
        errors.delete(id);
        running.add(id);
        break;
      case 'done':
        running.delete(id);
        failed.delete(id);
        errors.delete(id);
        completed.add(id);
        break;
      case 'fail':
        running.delete(id);
        completed.delete(id);
        failed.add(id);
        errors.set(id, ev.error);
        break;
      case 'split':
        // 任务被拆成子任务，分母增大；ev 未带 count 时按净增 1 处理。
        total += Number.isFinite(ev.count) ? Math.max(1, Math.floor(ev.count)) : 1;
        break;
      default:
        break;
    }
  };

  const build = (endMs) => {
    const elapsed = Math.max(0, endMs - startedAt);
    const settled = completed.size + failed.size;
    const ratio = total > 0 ? Math.min(1, Math.max(0, settled / total)) : 0;
    const eq = Math.min(BAR_WIDTH, Math.floor(ratio * BAR_WIDTH));
    const arrow = eq < BAR_WIDTH ? '>' : '';
    const bar = `[${('='.repeat(eq) + arrow).padEnd(BAR_WIDTH, ' ')}]`;
    const rate = elapsed > 0 ? settled / elapsed : 0;
    const eta = rate > 0 ? Math.max(0, total - settled) / rate : null;

    const head = `${colorize(bar, 'cyan', color)} ${colorize(`${settled}/${total}`, 'bold', color)}` +
      ` 已用 ${formatMs(elapsed)} 预计剩余 ${eta === null ? '--' : formatMs(eta)}`;
    const lines = [head];

    const sections = new Map();
    for (const [id, agent] of agents) {
      if (!sections.has(agent)) sections.set(agent, { running: [], done: [], failed: [] });
      const sec = sections.get(agent);
      if (running.has(id)) sec.running.push(id);
      else if (failed.has(id)) sec.failed.push(id);
      else if (completed.has(id)) sec.done.push(id);
    }

    let failShown = 0;
    let failHidden = 0;
    for (const [agent, sec] of sections) {
      const block = [];
      if (sec.running.length) {
        block.push(`  ${colorize('▶ 运行中', 'yellow', color)} ${sec.running.join(' ')}`);
      }
      if (sec.done.length) {
        block.push(`  ${colorize('✓ 完成', 'green', color)} ${sec.done.join(' ')}`);
      }
      for (const id of sec.failed) {
        if (failShown >= MAX_FAIL) {
          failHidden += 1;
          continue;
        }
        const err = errors.get(id);
        const tail = err ? ` ${oneLine(err)}` : '';
        block.push(`  ${colorize('✗ 失败', 'red', color)} ${id}${tail}`);
        failShown += 1;
      }
      if (block.length) lines.push(colorize(agent, 'cyan', color), ...block);
    }
    if (failHidden > 0) lines.push(`  ${colorize(`另有 ${failHidden} 条`, 'gray', color)}`);
    return lines.join('\n');
  };

  const snapshot = (force) => {
    const now = Date.now();
    if (!force && cached !== null && now - lastBuildAt < throttleMs) return cached;
    cached = build(frozenAt ?? now);
    lastBuildAt = now;
    return cached;
  };

  const render = () => snapshot(false);
  const done = () => {
    // 收尾时冻结时钟并强制重算，绕过节流，保证返回的是最终态而不是窗口内的旧快照。
    frozenAt = Date.now();
    return snapshot(true);
  };

  return { onProgress, render, done };
}
