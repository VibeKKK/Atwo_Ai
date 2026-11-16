// agents/ollama.mjs —— 本地模型通道：免费、不用积分、可并发，但没有登录/工具能力。
//
// 为什么值得编进兵团：
//   1) 异源 —— 它与云端四通道不是同一个供应商，同源误判会被打散（父审要的正是这个）。
//   2) 免费 —— 机械活（抽取/归类/格式转换/粗筛）用它，把积分留给真需要判断的活。
//   3) 可并发 —— HTTP 走开就是 N 路，不受 GUI 单窗口独占限制。
// 弱点同样明确：8B 级判断力，不许拿它定验收，只许它当第一层粗筛或干机械活。
import http from 'node:http';

/** OLLAMA_HOST 在 ollama 服务端语义里是 "host:port"（bind 地址），不是 URL —— 必须规范化，否则 new URL 直接抛。 */
function normalizeBase(v, fallback) {
  const s = String(v || '').trim();
  if (!s) return fallback;
  if (/^https?:\/\//i.test(s)) return s;
  return 'http://' + s; // '127.0.0.1:11434' / ':11434' 这类
}
const HOST = normalizeBase(process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL, 'http://127.0.0.1:11434');
const MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';

export const meta = {
  name: 'ollama',
  kind: 'http-model',
  transport: 'http',
  port: new URL(HOST).port || '11434',
  strengths: ['免费无限', '可并发', '异源（不同供应商）', '离线可用'],
  costModel: '零（本地 GPU/CPU）',
  quality: 'low',
  recommended: '机械活 / 粗筛 / 格式转换；不用于最终验收',
};

function req(path, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const u = new URL(path, HOST);
    let settled = false;
    const finish = (out) => { if (!settled) { settled = true; resolve(out); } };
    const r = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { s += c; });
        res.on('end', () => {
          if (res.statusCode >= 400) return finish({ ok: false, error: 'HTTP ' + res.statusCode + ' ' + s.slice(0, 200) });
          try { finish({ ok: true, data: JSON.parse(s) }); }
          catch (e) { finish({ ok: false, error: '不是 JSON：' + s.slice(0, 120) }); }
        });
      },
    );
    r.on('error', (e) => finish({ ok: false, error: String(e && e.message || e) }));
    // 超时必须真断开：只 resolve 不 destroy，本地模型会继续算、把 GPU 占死。
    const timer = setTimeout(() => { try { r.destroy(); } catch {} finish({ ok: false, timedOut: true, error: 'timeout ' + timeoutMs + 'ms' }); }, timeoutMs);
    r.on('close', () => clearTimeout(timer));
    r.write(payload);
    r.end();
  });
}

/** 与 askCodeBuddy 同签名：ask(prompt, {cwd, timeoutMs, model, tools}) → {ok, addedText, ...} */
export async function askOllama(prompt, opts = {}) {
  const { timeoutMs = 180000, model = MODEL } = opts;
  const t0 = Date.now();
  const body = {
    model,
    prompt: String(prompt || ''),
    stream: false,
    // qwen3 是思考模型：不关 think 会把 num_predict 全花在 thinking 上、response 返回空串。
    think: false,
    options: { num_predict: opts.numPredict ?? 1200, temperature: opts.temperature ?? 0.3 },
  };
  if (opts.system) body.system = opts.system;
  const r = await req('/api/generate', body, timeoutMs);
  const elapsedMs = Date.now() - t0;
  if (!r.ok) return { ok: false, error: r.error, timedOut: !!r.timedOut, addedText: '', elapsedMs, model };
  const text = String((r.data && r.data.response) || '');
  return { ok: !!text.trim(), addedText: text, text, elapsedMs, model, evalCount: r.data.eval_count, raw: r.data };
}

/** 环境探测：服务在不在 + 目标模型有没有下载。不下载、不加载。 */
export async function probeOllama(timeoutMs = 4000) {
  const get = (p) => new Promise((resolve) => {
    const u = new URL(p, HOST);
    const r = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, method: 'GET' }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ ok: res.statusCode === 200, body: s }));
    });
    r.on('error', () => resolve({ ok: false, body: '' }));
    r.setTimeout(timeoutMs, () => { try { r.destroy(); } catch {} resolve({ ok: false, body: '' }); });
    r.end();
  });
  const v = await get('/api/version');
  if (!v.ok) return { lane: 'ollama', available: false, reason: 'ollama 服务没跑（' + HOST + ' 不通）' };
  let version = '';
  try { version = JSON.parse(v.body).version || ''; } catch {}
  const t = await get('/api/tags');
  let hasModel = false;
  try { hasModel = (JSON.parse(t.body).models || []).some((m) => String(m.name || '').startsWith(MODEL.split(':')[0])); } catch {}
  return { lane: 'ollama', available: true, version, model: MODEL, hasModel, reason: hasModel ? '' : '模型 ' + MODEL + ' 未下载（ollama pull ' + MODEL + '）' };
}

export const ask = askOllama;
