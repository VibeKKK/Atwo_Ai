/**
 * DeepSeek HTTP 通道（agents/deepseek.mjs）的离线测试。
 *
 * 为什么不打真网络：这几条判据全是「请求长什么样、回包怎么解释」，
 * 桩掉 fetch 就够了；真打会烧额度、还会让测试依赖网络是否通。
 * 唯一必须靠真跑才能定的（能不能真出 VERDICT），记在 docs 里而不是这里。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askDeepSeek, hasKey, probeDeepSeek } from '../agents/deepseek.mjs';

// 这个文件桩掉了 fetch，压根不会打网络 —— 所以不受 DEEPSEEK_DISABLE 影响。
// （全量跑时外层会设 DEEPSEEK_DISABLE=1 防止别的测试真联网，这里要显式关掉它）
delete process.env.DEEPSEEK_DISABLE;
if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = 'test-key-not-real';

const realFetch = globalThis.fetch;
function stubFetch(handler) {
  globalThis.fetch = async (url, init = {}) => handler(url, init);
}
function restore() { globalThis.fetch = realFetch; }

function fakeJson(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj), json: async () => obj };
}

test('默认请求关掉思考（thinking:disabled）且 max_tokens 给到 8000', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  let seen = null;
  stubFetch((url, init) => { seen = JSON.parse(init.body); return fakeJson({ choices: [{ message: { content: 'VERDICT: ACCEPT' }, finish_reason: 'stop' }] }); });
  const r = await askDeepSeek('hi');
  restore();
  assert.equal(r.ok, true);
  assert.deepEqual(seen.thinking, { type: 'disabled' }, '不关思考的话 reasoning 会吃光 max_tokens，content 恒空');
  assert.equal(seen.max_tokens, 8000);
  assert.equal(seen.temperature, 0);
});

test('显式 opts.thinking=true 时把思考放回来（不写 thinking 字段）', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  let seen = null;
  stubFetch((url, init) => { seen = JSON.parse(init.body); return fakeJson({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }); });
  await askDeepSeek('hi', { thinking: true });
  restore();
  assert.equal('thinking' in seen, false);
});

test('content 空但有 reasoning 时退回思考内容并标 degraded（不能当成正常答案）', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  stubFetch(() => fakeJson({ choices: [{ message: { content: '', reasoning_content: '我们需要审查…' }, finish_reason: 'length' }] }));
  const r = await askDeepSeek('hi');
  restore();
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.equal(r.finish, 'length');
  assert.match(r.text, /我们需要审查/);
});

test('HTTP 401 要报错且带上状态码与正文片段', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  stubFetch(() => ({ ok: false, status: 401, text: async () => '{"error":{"message":"Authentication Fails"}}', json: async () => ({}) }));
  const r = await askDeepSeek('hi');
  restore();
  assert.equal(r.ok, false);
  assert.match(String(r.err), /401/);
});

test('probeDeepSeek：能列出模型就 available，401 就不可用（不烧 token）', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  stubFetch(() => fakeJson({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }));
  const good = await probeDeepSeek();
  restore();
  assert.equal(good.available, true);
  assert.deepEqual(good.models, ['deepseek-flash', 'deepseek-v4-pro']);

  stubFetch(() => ({ ok: false, status: 401, text: async () => 'nope', json: async () => ({}) }));
  const bad = await probeDeepSeek();
  restore();
  assert.equal(bad.available, false);
});

test('有 key 时 hasKey() 为真（env 与文件任一即可）', () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  assert.equal(hasKey(), true);
});
