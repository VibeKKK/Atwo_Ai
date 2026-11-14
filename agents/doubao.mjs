// 豆包（火山方舟 / Volcengine Ark）适配层：纯 HTTP API，零浏览器、零 DOM 抓取。
//
// 为什么这条通道比 trae / workbuddy 干净：
//  1) 没有 DOM，就不存在「抓到上一轮残留」的回合隔离问题 —— trae 现在最大的坑
//     （elapsedMs=329ms，回答其实是页面上的旧内容）在这里从根上消失。
//  2) 没有 markdown 渲染，就不存在 ** 被当 bold 吃掉、JSDoc 开头变单个斜杠的损伤。
//  3) 返回是结构化 JSON，input/output tokens 直接可读，不用从界面文案里数字。
//  4) 不需要 GUI 常驻，可在无头环境并发跑。
//
// 唯一前提：ARK_API_KEY。没有就抛错，绝不静默降级返回空串。
//
// 环境变量：
//   ARK_API_KEY    必填，火山方舟控制台的 API Key
//   ARK_MODEL      模型或推理接入点 ID，默认 doubao-seed-1-6-250615
//   ARK_BASE       默认 https://ark.cn-beijing.volces.com/api/v3
//   ARK_TIMEOUT_MS 默认 180000
import { withLockPool } from '../lib/lock.mjs';
import { check, record } from '../lib/budget.mjs';
import { appendLog } from '../lib/memory.mjs';

const BASE = process.env.ARK_BASE || 'https://ark.cn-beijing.volces.com/api/v3';
const MODEL = process.env.ARK_MODEL || 'doubao-seed-1-6-250615';
const TIMEOUT_MS = Number(process.env.ARK_TIMEOUT_MS || 180000);
const NAME = 'doubao';

function apiKey() {
  const k = process.env.ARK_API_KEY;
  if (!k) {
    throw new Error(
      '缺 ARK_API_KEY：豆包走火山方舟 HTTP API，需要控制台的 API Key。\n' +
      '  临时：set ARK_API_KEY=xxx\n' +
      '  永久：在 config.local.json 里加 "arkApiKey"（也可写进用户环境变量）',
    );
  }
  return k;
}

/**
 * 问豆包一次。
 * @param {string} prompt 提示词
 * @param {object} opts { system, temperature, maxTokens, json }
 * @returns {{answer:string, code:string, notes:string[], confidence:string,
 *            raw:string, ms:number, inputTokens:number, outputTokens:number}}
 */
export async function askDoubao(prompt, opts = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt 为空');

  return withLockPool(NAME, Number(opts.slots || process.env.ARK_SLOTS || 2), async () => {
    check(NAME, Math.ceil(text.length / 2));

    const key = apiKey();
    const t0 = Date.now();
    const body = {
      model: opts.model || MODEL,
      messages: [
        ...(opts.system ? [{ role: 'system', content: String(opts.system) }] : []),
        { role: 'user', content: text },
      ],
      temperature: opts.temperature ?? 0.3,
    };
    if (opts.maxTokens) body.max_tokens = Number(opts.maxTokens);
    if (opts.json) body.response_format = { type: 'json_object' };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      appendLog({ agent: NAME, ms, ok: false, err: String(err && err.message || err), promptChars: text.length });
      if (err && err.name === 'AbortError') throw new Error('豆包请求超时 ' + TIMEOUT_MS + 'ms');
      throw new Error('豆包请求失败：' + (err && err.message || err));
    }
    clearTimeout(timer);

    const ms = Date.now() - t0;
    const rawBody = await resp.text();
    if (!resp.ok) {
      appendLog({ agent: NAME, ms, ok: false, status: resp.status, err: rawBody.slice(0, 300) });
      throw new Error('豆包 HTTP ' + resp.status + '：' + rawBody.slice(0, 500));
    }

    let data;
    try { data = JSON.parse(rawBody); } catch (err) {
      appendLog({ agent: NAME, ms, ok: false, err: 'JSON 解析失败' });
      throw new Error('豆包返回不是合法 JSON：' + rawBody.slice(0, 300));
    }

    const choice = (data.choices && data.choices[0]) || null;
    const content = choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content
      : '';
    if (!content.trim()) {
      appendLog({ agent: NAME, ms, ok: false, err: '空回答', finish: choice && choice.finish_reason });
      throw new Error('豆包返回空回答（finish_reason=' + (choice && choice.finish_reason) + '）');
    }

    const u = data.usage || {};
    const inputTokens = Number(u.prompt_tokens || 0);
    const outputTokens = Number(u.completion_tokens || 0);

    record(NAME, { input: inputTokens, output: outputTokens, ok: true });
    appendLog({ agent: NAME, ms, ok: true, promptChars: text.length, inputTokens, outputTokens, model: body.model });

    // 契约任务让上游自己给结构化 JSON；这里只做宽松拆解，不擅自判失败。
    let answer = content.trim();
    let code = '';
    let notes = [];
    let confidence = '';
    const fenced = answer.match(/```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)```/);
    if (fenced) code = fenced[1].replace(/^\s*\n/, '').replace(/\s*$/, '');
    try {
      const j = JSON.parse(answer);
      if (j && typeof j === 'object') {
        if (typeof j.code === 'string') code = j.code;
        answer = String(j.answer ?? j.summary ?? j.title ?? '').trim() || (code ? '' : answer);
        if (Array.isArray(j.notes)) notes = j.notes.map(String);
        if (j.confidence != null) confidence = String(j.confidence);
      }
    } catch { /* 不是 JSON 就用原文 */ }

    return { answer, code, notes, confidence, raw: content, ms, inputTokens, outputTokens };
  });
}

/** 供 orchestra doctor / stats 用的元信息 */
export const doubaoMeta = {
  name: NAME,
  label: '豆包（火山方舟 API）',
  kind: 'http',
  model: MODEL,
  base: BASE,
  ready: () => Boolean(process.env.ARK_API_KEY),
  reason: () => (process.env.ARK_API_KEY ? 'ARK_API_KEY 已设置' : '缺 ARK_API_KEY'),
};

/** doctor 用：探测 key 是否可用（发一次极小的请求） */
export async function doubaoDoctor() {
  if (!process.env.ARK_API_KEY) return { ok: false, detail: '缺 ARK_API_KEY' };
  try {
    const r = await askDoubao('只回复两个字：在', { maxTokens: 16 });
    return { ok: true, detail: '连通，回复 ' + JSON.stringify(r.answer.slice(0, 20)) + ' · ' + r.ms + 'ms' };
  } catch (err) {
    return { ok: false, detail: String(err.message || err).slice(0, 200) };
  }
}
