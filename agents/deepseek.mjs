/**
 * DeepSeek 官方 API 通道 —— 「第二父审」。
 *
 * 为什么需要它（2026-11-17）：所有父审都落在 codebuddy 上 = 同源，等于自说自话。
 * 异源评审要成立，必须有一条**不同厂商、不同模型、不依赖桌面客户端**的通道；
 * 官方 API 正好满足：一个 key、一个 HTTP POST，不受 GUI 菜单/端口/会话条数影响。
 *
 * 三条硬规矩：
 *   1. key 不进仓库。只从 env DEEPSEEK_API_KEY 或 ~/.dsh/deepseek.key 读（后者在仓库外）。
 *   2. 没 key 就是「不可用」，不是「静默退回 codebuddy」—— 静默退回正好制造「以为异源、其实同源」。
 *   3. 思考模型的 content 可能为空（思考吃光 max_tokens）：content 空且有 reasoning_content 时，
 *      把 reasoning 的尾部当答案并**标记 degraded**，让上层知道这次票的分量。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOST = 'https://api.deepseek.com';
export const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';

/** key 解析顺序：env → ~/.dsh/deepseek.key（仓库外）。找不到返回空串，绝不抛。 */
export function loadKey() {
  const env = String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (env) return env;
  try {
    const p = path.join(os.homedir(), '.dsh', 'deepseek.key');
    if (fs.existsSync(p)) return String(fs.readFileSync(p, 'utf8')).trim();
  } catch {}
  return '';
}

export function hasKey() { return !!loadKey(); }

/** 真实对话。返回形状与 agents/ollama.mjs 对齐，便于 lib/lanes.mjs 直接当 ask 用。 */
export async function askDeepSeek(prompt, opts = {}) {
  const key = loadKey();
  if (!key) return { ok: false, error: '没有 DeepSeek key（env DEEPSEEK_API_KEY 或 ~/.dsh/deepseek.key）', err: '没有 DeepSeek key', addedText: '', elapsedMs: 0, model: opts.model || MODEL };
  const model = opts.model || MODEL;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000;
  const t0 = Date.now();
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: String(opts.system) });
  messages.push({ role: 'user', content: String(prompt == null ? '' : prompt) });
  const body = { model, messages, stream: false, max_tokens: Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : 2400, temperature: Number(opts.temperature) >= 0 ? Number(opts.temperature) : 0 };
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);
  try {
    const res = await fetch(HOST + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body), signal: ac.signal });
    const elapsedMs = Date.now() - t0;
    const raw = await res.text();
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = JSON.parse(raw); msg += ' ' + (j.error && (j.error.message || j.error.code) || ''); } catch {}
      return { ok: false, error: msg, err: msg, addedText: '', elapsedMs, model, status: res.status };
    }
    let j = null;
    try { j = JSON.parse(raw); } catch { return { ok: false, error: '返回不是 JSON', err: '返回不是 JSON', addedText: '', elapsedMs, model }; }
    const ch = (j.choices && j.choices[0]) || {};
    const content = String((ch.message && ch.message.content) || '');
    const reasoning = String((ch.message && ch.message.reasoning_content) || '');
    const finish = ch.finish_reason || '';
    let text = content.trim();
    let degraded = false;
    if (!text && reasoning.trim()) { text = reasoning.trim(); degraded = true; }
    return { ok: !!text, addedText: text, text, elapsedMs, model, finish, degraded, usage: j.usage || null, raw: j };
  } catch (e) {
    const elapsedMs = Date.now() - t0;
    const timedOut = /abort/i.test(String(e && e.name || '') + String(e && e.message || ''));
    const msg = timedOut ? ('DeepSeek 在 ' + Math.round(elapsedMs / 1000) + 's 内没有返回（硬超时）') : String((e && e.message) || e);
    return { ok: false, error: msg, err: msg, timedOut, addedText: '', elapsedMs, model };
  } finally {
    clearTimeout(timer);
  }
}

/** 环境探测：验 key（拿模型列表，不烧 token）。 */
export async function probeDeepSeek(timeoutMs = 8000) {
  const key = loadKey();
  if (!key) return { lane: 'deepseek', available: false, reason: '没有 key（env DEEPSEEK_API_KEY 或 ~/.dsh/deepseek.key）' };
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);
  try {
    const res = await fetch(HOST + '/models', { headers: { authorization: 'Bearer ' + key }, signal: ac.signal });
    const txt = await res.text();
    if (!res.ok) return { lane: 'deepseek', available: false, reason: 'key 被拒（HTTP ' + res.status + '）' };
    let ids = [];
    try { ids = (JSON.parse(txt).data || []).map((m) => m.id); } catch {}
    return { lane: 'deepseek', available: ids.length > 0, model: MODEL, models: ids, reason: ids.length ? '' : '模型列表为空' };
  } catch (e) {
    return { lane: 'deepseek', available: false, reason: '连不上（' + String((e && e.message) || e) + '）' };
  } finally {
    clearTimeout(timer);
  }
}

export const ask = askDeepSeek;
