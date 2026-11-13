// 派活前的前置体检：界面改版时「立刻断得响亮」，而不是等 4 分钟超时。
// 三条断言都是廉价 DOM 查询，缓存 60 秒（同一批任务只体检一次）。
import { SEL, snapshotTrae } from '../agents/trae.mjs';

const CACHE_MS = Number(process.env.ORCH_PREFLIGHT_MS || 60000);
const cache = new Map();

export async function preflightTrae() {
  const hit = cache.get('trae');
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.res;

  let snap;
  try {
    snap = await snapshotTrae();
  } catch (e) {
    // Trae 没在跑 ≠ 界面改版：适配层的 ensureTrae 会把它拉起来。
    // 只有「端口通但页面取不到」才算真异常，那种情况上面的检查会逐项报出来。
    const msg = String(e.message || e);
    const notRunning = /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg);
    if (notRunning) {
      const res = { ok: true, skipped: true, reason: 'Trae 未运行，交由适配层拉起', checks: [{ name: 'cdp', ok: true, detail: '未监听（将自动启动）' }] };
      cache.set('trae', { ts: Date.now(), res });
      return res;
    }
    const res = { ok: false, reason: 'CDP 异常：' + msg, checks: [{ name: 'cdp', ok: false, detail: msg }] };
    cache.set('trae', { ts: Date.now(), res });
    return res;
  }

  const checks = [
    { name: 'body-readable', ok: snap.textLen > 200, detail: '页面文本 ' + snap.textLen + ' 字符' },
    // 注意：每次派活会开新对话，所以「0 条回合」是正常状态，不能当改版信号。
    // 这里只要求选择器能返回结构（元素存在或为空但选择器本身没抛错）。
    { name: 'turn-container', ok: true, detail: 'agentTurns=' + snap.agentTurns + (snap.agentTurns === 0 ? '（空对话，正常）' : '') + ' · SEL.turn 候选 ' + SEL.turn.length },
    { name: 'input-box', ok: snap.editable > 0, detail: 'contenteditable=' + snap.editable + '（SEL.edit 候选 ' + SEL.edit.length + '）' },
  ];
  const bad = checks.filter(c => !c.ok);
  const res = {
    ok: bad.length === 0,
    reason: bad.length
      ? '界面已变：' + bad.map(b => b.name + '(' + b.detail + ')').join(' · ') + ' → 改 SEL 或跑 node orchestra.mjs probe'
      : '',
    checks,
  };
  cache.set('trae', { ts: Date.now(), res });
  return res;
}

export function clearPreflightCache() { cache.clear(); }
