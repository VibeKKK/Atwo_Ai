// 派活守护：纯函数，只做判断与格式化，不 spawn、不 kill、不读文件、不打印日志。

// 1) 把流式输出切成完整行；换行符不保留在行内。
export function parseLines(chunk) {
  if (typeof chunk !== 'string') throw new TypeError('chunk must be string');
  const lines = [];
  const parts = chunk.split('\n');
  for (let i = 0; i < parts.length - 1; i++) {
    let line = parts[i];
    if (line.endsWith('\r')) line = line.slice(0, -1); // 容忍 \r\n
    lines.push(line);
  }
  const rest = parts[parts.length - 1];
  return { lines, rest };
}

// 2) 生成带时间的进度行；时间右对齐宽 6，空文本只输出时间头。
export function progressLine({ elapsedMs, text } = {}) {
  let ms = Number(elapsedMs);
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const head = `[${(ms / 1000).toFixed(1).padStart(6, ' ')}s]`;
  const s = typeof text === 'string' ? text.trim() : '';
  return s ? `${head} ${s}` : head;
}

// 3) 判断一行输出的类别；大小写不敏感，按表顺序先命中先返回。
export function classifyLine(text) {
  const s = (typeof text === 'string' ? text : '').toLowerCase();
  // '0 字符' 需排除 '3980 字符' 这类正常返回，故要求 0 前不是数字。
  const zero = /(^|\D)0\s*字符/;
  if (zero.test(s) || ['ok=false', '空文本', 'rate limit', 'max turns', '通道失败'].some((k) => s.includes(k))) return 'channel-dead';
  if (['ok=true', '已返回', '落地'].some((k) => s.includes(k))) return 'channel-ok';
  if (['评审', 'review', 'verdict'].some((k) => s.includes(k))) return 'review';
  if (['验收', 'accept', '形状', '语法', '判定'].some((k) => s.includes(k))) return 'accept';
  return 'noise';
}

// 4) 决定是否立刻收尾；exitCode 只用 0/4/5，这里只会用到 5。
export function decideAbort(state = {}) {
  const { deadlineReached, lastLine, sawReview, channels = [], expectedChannels = 1 } = state;
  let elapsedMs = Number(state.elapsedMs);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) elapsedMs = 0;
  const deadlineMs = Number(state.deadlineMs);
  const hasDeadline = Number.isFinite(deadlineMs) && deadlineMs > 0;
  const chans = Array.isArray(channels) ? channels : [];
  const success = chans.filter((c) => c && c.ok === true).length;
  let expected = Number(expectedChannels);
  if (!Number.isFinite(expected) || expected < 1) expected = 1;

  if (deadlineReached === true || (hasDeadline && elapsedMs >= deadlineMs)) {
    return { abort: true, exitCode: 5, reason: '超时' };
  }
  // 已进入评审时交给下一条更具体的规则，避免抢在“评审无意义”之前返回。
  if (!sawReview && success === 0 && expected >= 1 && chans.length >= expected) {
    return { abort: true, exitCode: 5, reason: '全部通道失败' };
  }
  if (sawReview && success === 0) {
    return { abort: true, exitCode: 5, reason: '没有可用产物，评审无意义' };
  }
  if (classifyLine(lastLine) === 'channel-dead' && success === 0 && expected === 1) {
    return { abort: true, exitCode: 5, reason: '唯一通道已失败' };
  }
  return { abort: false, exitCode: 0, reason: '' };
}

// 5) 一句话总结；有任意一路成功即视为可用，括号列出失败通道。
export function summarizeRun({ channels = [], elapsedMs } = {}) {
  const chans = Array.isArray(channels) ? channels : [];
  const total = chans.length;
  const success = chans.filter((c) => c && c.ok === true).length;
  let ms = Number(elapsedMs);
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const secs = (ms / 1000).toFixed(1);
  const failed = chans.filter((c) => c && c.ok !== true);
  const tail = failed.length
    ? `（${failed.map((c) => `${c.name || '?'} ${c.reason || '失败'}`).join(', ')}）`
    : '';
  const text = `${success}/${total} 路成功${tail} · 用时 ${secs}s`;
  return { ok: success > 0, total, text };
}

// 同时兼容 CommonJS：ESM 下 module 未定义，typeof 守卫可安全跳过。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseLines, progressLine, classifyLine, decideAbort, summarizeRun };
}
