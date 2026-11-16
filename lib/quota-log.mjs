// lib/quota-log.mjs
// 额度账本的落盘层：把一次派活的每一路写成一行可结算的账。
// 零依赖（只许 node: 内置）；倍率与积分一律由 lib/quota-ledger.mjs 推导，本文件不另存一份常量。

import fs from 'node:fs';
import path from 'node:path';
import { MULTIPLIERS, quotaEntry } from './quota-ledger.mjs';

// now 归一成 ISO 字符串；注入了坏值就退回当前时间 —— 账本不能因为一个坏参数写不出时间。
function isoTime(now) {
  if (now instanceof Date) {
    const t = now.getTime();
    if (Number.isFinite(t)) return new Date(t).toISOString();
  } else if (typeof now === 'number' && Number.isFinite(now)) {
    return new Date(now).toISOString();
  } else if (typeof now === 'string' && now.trim()) {
    const t = Date.parse(now);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

// 倍率表键是「通道/模型」，调用方只知道模型：先认「本通道/模型」，再按模型名兜底。
// 同一模型出现在多个通道时优先本通道那条；都没有就交给 quotaEntry 走 1 倍兜底。
function ledgerKeyFor(agent, model) {
  const a = typeof agent === 'string' ? agent : '';
  const m = typeof model === 'string' ? model : '';
  if (a && m && Object.prototype.hasOwnProperty.call(MULTIPLIERS, a + '/' + m)) {
    return { channel: a, model: m };
  }
  if (m) {
    for (const key of Object.keys(MULTIPLIERS)) {
      const i = key.indexOf('/');
      if (i >= 0 && key.slice(i + 1) === m) return { channel: key.slice(0, i), model: m };
    }
  }
  // quotaEntry 要求 channel/model 非空 —— 未知模型用占位名走它的 1 倍（100 分）兜底
  return { channel: a || 'unknown', model: m || 'unknown' };
}

/**
 * 造一条待写入的额度记录。
 * @param {{agent?: string, model?: string, ok?: boolean, elapsedMs?: number, now?: string|number|Date}} input
 * @returns {{kind: 'quota', time: string, agent: string, model: string, multiplier: number, points: number, ok: boolean, elapsedMs: number}}
 */
function quotaRecord(input) {
  const src = input || {};
  const agent = typeof src.agent === 'string' ? src.agent : '';
  const model = typeof src.model === 'string' ? src.model : '';
  // 倍率/积分只有一个出处：这里只把「模型」翻译成 quotaEntry 认识的「通道/模型」
  const key = ledgerKeyFor(agent, model);
  const q = quotaEntry({ channel: key.channel, model: key.model, ok: src.ok, elapsedMs: src.elapsedMs });
  return {
    kind: 'quota',
    time: isoTime(src.now),
    agent,
    model,
    multiplier: q.multiplier,
    points: q.points,
    ok: q.ok,
    elapsedMs: q.elapsedMs,
  };
}

/**
 * 追加一行 JSON + 换行（目录不存在就建）。写不进去会抛错，由调用方决定「只说话不阻断」。
 * @returns {{ok: boolean, file: string, line: string}}
 */
function appendQuota(file, rec) {
  const given = String(file);
  const target = path.resolve(given);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const line = JSON.stringify(rec);
  fs.appendFileSync(target, line + '\n', 'utf8');
  return { ok: true, file: given, line };
}

/**
 * 逐行读账本；文件不存在返回空数组，坏行跳过不抛。
 * @returns {object[]}
 */
function readQuota(file) {
  const target = path.resolve(String(file));
  let body;
  try { body = fs.readFileSync(target, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const raw of body.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw)); }
    catch { /* 坏行跳过：一行垃圾不能拖垮整本账 */ }
  }
  return out;
}

export { quotaRecord, appendQuota, readQuota };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { quotaRecord, appendQuota, readQuota };
}
