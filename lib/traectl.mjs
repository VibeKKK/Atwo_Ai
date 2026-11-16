// Trae 额度/用量读取：走 commercial/get_session_usage（同一个免费账号，不花钱）
//
// 背景（2026-11-15 实测）：
//   沟通 392 条流水里 inputTokens/outputTokens 全是 0，因为 CDP 层只从 DOM 猜文字，
//   从来没去取「这条消息花了多少 token」。用量一直存在，只是没人问。
//   接口：POST https://trae-api-cn.mchost.guru/api/v1/commercial/get_session_usage
//         body {"session_id": "<user_message_id>"}   ← 注意传的是「消息 id」，不是会话 id
//   返回带 input_token / output_token / cache_read_token / cache_write_token / credits_float
//        以及 user_input_preview（可以把账对回具体任务）
//
// 关键实测数字（一条「回复两个字：收到」）：
//   input_token 31300、output_token 24、cache_read_token 30976 → 缓存命中 98.9%
//   cost_money_float 0（不花钱，只扣 credits 0.18）
//
// 鉴权 Cloud-IDE-JWT 有效期 14 天，会自动过期，所以这里不写死 token，
// 而是从页面 hook 到的真实请求头里取；取不到再退回缓存文件。

import fs from 'node:fs';
import path from 'node:path';

const USAGE_URL = 'https://trae-api-cn.mchost.guru/api/v1/commercial/get_session_usage';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TraeCN/1.107.1 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36';

const CACHE_FILE = path.join(process.cwd(), '_probe', 'trae_headers.json');

/** 注入请求记录钩子（幂等）。只记录，不改行为。 */
export async function ensureHook(cdp) {
  const r = await cdp.js(`(() => {
    if (window.__traeReqs) return 'already';
    window.__traeReqs = [];
    const rec = (u, opts) => {
      try {
        const h = opts && opts.headers;
        let hs = null;
        if (h) { hs = {}; try { for (const [k, v] of Object.entries(h)) hs[k] = String(v).slice(0, 400); } catch {} }
        window.__traeReqs.push({ u: String(u).slice(0, 300), b: opts && opts.body ? String(opts.body).slice(0, 400) : null, h: hs, t: Date.now() });
        if (window.__traeReqs.length > 80) window.__traeReqs.shift();
      } catch {}
    };
    const of = window.fetch;
    window.fetch = function (...a) {
      try { rec(typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url), a[1]); } catch {}
      return of.apply(this, a);
    };
    const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; return oo.call(this, m, u, ...r); };
    XMLHttpRequest.prototype.send = function (b) { try { rec(this.__u, { body: b, headers: null }); } catch {} return os.call(this, b); };
    return 'hooked';
  })()`, 20000);
  return r;
}

/** 取走并清空记录（不清空会越积越多，且下次会重复读到旧消息的用量） */
export async function drain(cdp) {
  const raw = await cdp.js('(() => { const a = window.__traeReqs || []; window.__traeReqs = []; return JSON.stringify(a); })()', 20000);
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

/** 从一条记录的 body 里取 session_id 字段（其实是 user_message_id） */
function bodyMessageId(rec) {
  if (!rec || !rec.b) return null;
  try {
    const j = JSON.parse(rec.b);
    return j && typeof j.session_id === 'string' ? j.session_id : null;
  } catch { return null; }
}

/** 从一条记录的头里取 Authorization */
function headerAuth(rec) {
  if (!rec || !rec.h) return null;
  for (const [k, v] of Object.entries(rec.h)) {
    if (k.toLowerCase() === 'authorization') return v;
  }
  return null;
}

/** 读磁盘上最近一次抓到的 Authorization（兜底） */
export function readCachedAuth() {
  try {
    const arr = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const hit = arr.find((x) => x.headers && x.headers.Authorization);
    return hit ? hit.headers.Authorization : null;
  } catch { return null; }
}

/** 查一条消息的用量。返回 { ok, inputTokens, outputTokens, cacheRead, cacheWrite, credits, model, preview } 或 { ok:false, error } */
export async function fetchUsage(auth, messageId) {
  if (!auth) return { ok: false, error: '没有 Authorization' };
  if (!messageId) return { ok: false, error: '没有 message id' };
  try {
    const r = await fetch(USAGE_URL, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ session_id: messageId }),
    });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const j = await r.json();
    const g = (j && j.user_usage_group_by_session) || {};
    const e = g.extra_info || {};
    return {
      ok: true,
      inputTokens: Number(e.input_token || 0),
      outputTokens: Number(e.output_token || 0),
      cacheRead: Number(e.cache_read_token || 0),
      cacheWrite: Number(e.cache_write_token || 0),
      credits: Number(g.credits_float || 0),
      money: Number(g.cost_money_float || 0),
      model: String(g.model_name || ''),
      preview: String(g.user_input_preview || '').slice(0, 60),
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * 一步到位：从页面记录里找「最后一条 get_session_usage」，用它的 message id 和鉴权头查用量。
 * 找不到请求记录时退回磁盘缓存里的 Authorization，但仍需 messageId。
 * 返回 { ok, ... } 或 { ok:false, error }
 */
export async function latestUsage(cdp, opts = {}) {
  const recs = await drain(cdp);
  let auth = opts.auth || null;
  let messageId = opts.messageId || null;

  for (const rec of recs) {
    if (!rec.u || !rec.u.includes('get_session_usage')) continue;
    const id = bodyMessageId(rec);
    if (id) { messageId = id; auth = headerAuth(rec) || auth; }
  }
  if (!auth) auth = readCachedAuth();
  if (!messageId) return { ok: false, error: '这一轮没捕获到 get_session_usage 请求（页面可能没装钩子）' };
  return fetchUsage(auth, messageId);
}

/**
 * 监听网络等用量（推荐，实测唯一可靠的路径）。
 *
 * 为什么不能用注入 hook：Trae 的 get_session_usage 是内嵌模块发的，不经页面 window.fetch，
 * 所以 hook 里记录数永远是 0（对话正常、请求也真的发生了，就是看不见）。
 * CDP 的 Network 域能看见。
 *
 * 用法：先 watchUsage(cdp) 拿到 promise，再触发发送，最后 await 它。
 *   const w = watchUsage(c, { waitMs: 45000 });
 *   ...发消息...
 *   const usage = await w;
 */
export async function watchUsage(cdp, opts = {}) {
  const waitMs = Number(opts.waitMs || 45000);
  let auth = null;
  let messageId = null;
  let firstSeenAt = 0;

  const off = cdp.on('Network.requestWillBeSent', (p) => {
    try {
      const r = (p && p.request) || {};
      if (!String(r.url || '').includes('get_session_usage')) return;
      if (r.postData) {
        const j = JSON.parse(r.postData);
        if (j && typeof j.session_id === 'string') { messageId = j.session_id; firstSeenAt = Date.now(); }
      }
      for (const [k, v] of Object.entries(r.headers || {})) {
        if (String(k).toLowerCase() === 'authorization') auth = String(v);
      }
    } catch {}
  });

  await cdp.call('Network.enable', {}, 10000);

  const t0 = Date.now();
  const done = (async () => {
    while (Date.now() - t0 < waitMs) {
      await new Promise((r) => setTimeout(r, 400));
      if (messageId && Date.now() - firstSeenAt > 1200) {
        const a = auth || readCachedAuth();
        return fetchUsage(a, messageId);
      }
    }
    return { ok: false, error: '等了 ' + Math.round(waitMs / 1000) + ' 秒没等到 get_session_usage 请求' };
  })();

  done.finally(() => { try { off(); } catch {} });
  return done;
}

export const _internal = { USAGE_URL, bodyMessageId, headerAuth };
