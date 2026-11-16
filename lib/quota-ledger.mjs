// lib/quota-ledger.mjs
// 额度账本：把每次派活记成一行可结算的账（通道×模型×倍率×折算积分×成败×耗时）
// 零依赖纯函数：不读文件、不联网、不读环境变量、不打印日志。

// 已知倍率表（快照；调用方可通过入参 multiplier 覆盖）
const MULTIPLIERS = {
  'workbuddy/Hy3': 0,
  'workbuddy/GLM-5.3-Flash': 0.08,
  'workbuddy/DeepSeek-V4.1-Flash': 0.11,
  'workbuddy/Kimi-K3.1-Pro': 0.97,
  'workbuddy/Kimi-K3': 1.62,
  'codebuddy/codebuddy': 1,
};

// 造一行账
function quotaEntry(input) {
  const src = input || {};
  const channel = src.channel;
  const model = src.model;
  // 通道与模型必须是非空字符串
  if (typeof channel !== 'string' || channel.length === 0 ||
      typeof model !== 'string' || model.length === 0) {
    throw new TypeError('channel/model required');
  }
  // 倍率优先级：入参数字 > 倍率表 > 1（未知模型按基准价，宁可高估）
  let multiplier;
  if (typeof src.multiplier === 'number' && Number.isFinite(src.multiplier)) {
    multiplier = src.multiplier;
  } else {
    const key = channel + '/' + model;
    const known = Object.prototype.hasOwnProperty.call(MULTIPLIERS, key)
      ? MULTIPLIERS[key] : undefined;
    multiplier = (typeof known === 'number' && Number.isFinite(known)) ? known : 1;
  }
  // 积分先取整，保证永远是整数
  const points = Math.round(multiplier * 100);
  // 耗时：非有限数或负数一律归零，否则取整
  let elapsedMs = 0;
  if (typeof src.elapsedMs === 'number' && Number.isFinite(src.elapsedMs) && src.elapsedMs >= 0) {
    elapsedMs = Math.round(src.elapsedMs);
  }
  // 只有严格 true 才算成功
  return { channel, model, multiplier, points, ok: src.ok === true, elapsedMs };
}

// 汇总账目
function summarizeQuota(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('entries must be array');
  }
  let total = 0, ok = 0, failed = 0;
  let points = 0, pointsOk = 0, pointsFailed = 0;
  const byChannel = {};
  const byModel = {};
  let slowest = null;
  for (const e of entries) {
    const p = Math.round(e.points); // 先各自取整再相加
    total += 1;
    points += p;
    if (e.ok === true) { ok += 1; pointsOk += p; }
    else { failed += 1; pointsFailed += p; }
    const c = e.channel;
    if (!Object.prototype.hasOwnProperty.call(byChannel, c)) byChannel[c] = { count: 0, points: 0 };
    byChannel[c].count += 1;
    byChannel[c].points += p;
    const mk = c + '/' + e.model;
    if (!Object.prototype.hasOwnProperty.call(byModel, mk)) byModel[mk] = { count: 0, points: 0 };
    byModel[mk].count += 1;
    byModel[mk].points += p;
    if (slowest === null || e.elapsedMs > slowest.elapsedMs) {
      slowest = { channel: c, model: e.model, elapsedMs: e.elapsedMs }; // 并列取先出现的
    }
  }
  return { total, ok, failed, points, pointsOk, pointsFailed, byChannel, byModel, slowest };
}

// 按倍率选路：先挑倍率最低且合法的一条，再校验其可靠度；不可靠则返回 null 交给调用方降级
function pickCheapest(candidates, options) {
  const opts = options || {};
  const minOkRate = (typeof opts.minOkRate === 'number' && Number.isFinite(opts.minOkRate))
    ? opts.minOkRate : 0.5;
  let best = null;
  let bestMul = Infinity;
  const list = Array.isArray(candidates) ? candidates : [];
  for (const c of list) {
    // 只认有限非负倍率；严格小于才替换，保证并列取先出现的
    if (typeof c.multiplier !== 'number' || !Number.isFinite(c.multiplier) || c.multiplier < 0) continue;
    if (c.multiplier < bestMul) { bestMul = c.multiplier; best = c; }
  }
  // 最便宜的一条若可靠度不达标，不选更贵的，直接返回 null 让调用方降档
  if (best === null || !(best.okRate >= minOkRate)) return null;
  return best;
}

export { MULTIPLIERS, quotaEntry, summarizeQuota, pickCheapest };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MULTIPLIERS, quotaEntry, summarizeQuota, pickCheapest };
}
