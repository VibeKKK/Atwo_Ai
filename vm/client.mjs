// file: vm/client.mjs
/**
 * @file vm/client.mjs
 * @description 判定服务的客户端：让 atwo（以及任何别的进程）通过 HTTP 拿到三态判定。
 *
 * 三条纪律（都是为了「不可用时不许假装"):
 *   1. **fail-closed**：远程拿不到就返回 ok:false，绝不偷偷用本地现算的结果冒名顶替。
 *      要不要降级是调用方的事，客户端不替它做决定 —— 否则「服务挂了」和「服务说别判」
 *      会被压成同一个返回值，这正是两态系统最典型的失败方式。
 *   2. **有时限**：默认 1500ms。判定服务只算几十次浮点，超时就是链路问题，等下去没有意义。
 *   3. **只读**：不缓存、不重试（重试会把瞬时故障伪装成稳定结论；要重试的人自己写循环）。
 *
 * 地址优先级：opts.url > 环境变量 TERNARY_ORACLE_URL > http://127.0.0.1:8731
 */

import { judge as localJudge } from './judge.mjs';
import { judgeVotes as localVotes } from './votes.mjs';

export const DEFAULT_URL = 'http://127.0.0.1:8731';
export const DEFAULT_TIMEOUT = 1500;

/** 当前该用哪个地址（不连，只算）。 */
export function oracleUrl(opts = {}) {
  return String(opts.url || process.env.TERNARY_ORACLE_URL || DEFAULT_URL).replace(/\/+$/, '');
}

async function post(pathname, body, opts = {}) {
  const url = oracleUrl(opts) + pathname;
  const timeout = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, error: '响应不是 JSON: ' + text.slice(0, 120), url, status: res.status }; }
    if (!res.ok || data.ok === false) return { ok: false, error: String(data.error || ('HTTP ' + res.status)), url, status: res.status, data };
    return { ok: true, url, status: res.status, data };
  } catch (e) {
    const msg = String((e && e.message) || e);
    // AbortSignal.timeout 在 node 里报 TimeoutError / AbortError，统一成一句人话。
    const error = /abort|timeout/i.test(msg) ? ('判定服务 ' + timeout + 'ms 内没回话（' + url + '）') : ('判定服务连不上（' + url + '）：' + msg.slice(0, 120));
    return { ok: false, error, url };
  }
}

/** 远程判定一组 z 值。拿不到就 ok:false，不给任何替代结论。 */
export async function remoteJudge(zValues, opts = {}) {
  if (!Array.isArray(zValues) || !zValues.length) return { ok: false, error: 'zValues 不能为空', url: oracleUrl(opts) };
  const r = await post('/judge', { zValues, expected: opts.expected }, opts);
  if (!r.ok) return r;
  return { ok: true, url: r.url, source: 'remote', ...r.data };
}

/** 远程判定一组票。 */
export async function remoteVotes(votes, opts = {}) {
  if (!Array.isArray(votes) || !votes.length) return { ok: false, error: 'votes 不能为空', url: oracleUrl(opts) };
  const r = await post('/votes', { votes, expected: opts.expected }, opts);
  if (!r.ok) return r;
  return { ok: true, url: r.url, source: 'remote', ...r.data };
}

/**
 * 探活。返回 ok:false 时 error 里能看出是「没起」还是「起了但不是这个服务」。
 * @returns {Promise<{ok:boolean, url:string, service?:string, version?:string, cut?:object, error?:string}>}
 */
export async function health(opts = {}) {
  const url = oracleUrl(opts) + '/health';
  const timeout = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    const data = await res.json().catch(() => null);
    if (!data || data.service !== 'ternary-oracle') return { ok: false, url, error: '该地址在应但不像判定服务（缺 service 字段）' };
    return { ok: true, url, service: data.service, version: data.version, cut: data.cut, uptimeMs: data.uptimeMs };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, url, error: /abort|timeout/i.test(msg) ? ('探活超时（' + url + '）') : ('连不上（' + url + '）：' + msg.slice(0, 120)) };
  }
}

/**
 * 远程优先、本地兜底的显式版本。source 字段如实写「这次结论是谁给的」。
 * 只有调用方明确要降级时才用它；默认路径用 remoteJudge。
 */
export async function judgeWithFallback(zValues, opts = {}) {
  const r = await remoteJudge(zValues, opts);
  if (r.ok) return r;
  const local = localJudge({ zValues, expected: opts.expected });
  return { ok: true, source: 'local', degraded: true, remoteError: r.error, value: local.value, confidence: local.confidence, reason: local.reason, stats: local.details ? local.details.stats : null };
}
