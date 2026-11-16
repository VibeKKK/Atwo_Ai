/**
 * 按档位换模型（atwo-i2ilfe）：strict 花小钱，crazy 用最强。
 *
 * 四条通道的真实能力，全部是 2026-11-16 实测出来的，不是推测：
 *  · WorkBuddy  能切。点 trigger → 120ms 短轮询抓菜单（菜单只活几百毫秒，
 *               先 sleep(900) 再查必然拿到空数组）→ 点中文字包含名字的那项 → 读回 trigger 校验。
 *  · codebuddy  能切。CLI 的 --model / CODEBUDDY_MODEL / opts.model，--help 里列了 17 个 id。
 *  · Trae       不能切。下拉是 Electron 原生菜单：el.click() / svg dispatchEvent /
 *               CDP 真实鼠标 / 键盘 ArrowDown+Enter 四种都只打到应用菜单栏；
 *               改 state.vscdb 的 recent_user_selection_by_agent_label，重启后问「你是哪个模型」
 *               仍答豆包 —— 不生效。
 *  · 豆包       不能切。输入框附近 19 个可点元素里没有任何模型名，客户端不暴露入口。
 *
 * 所以真实范围是 2/4 通道。另两个在表里显式写 null 并写明原因 —— 不写空函数骗调用方。
 *
 * 两条硬约束：
 *  1) 换模型是优化，不是前置条件。任何通道切不动都只记一行警告，绝不抛异常、绝不阻断派活。
 *     （今天已经出现过「为了修一个次要问题把主流程弄挂」）
 *  2) --plan 只算不切：动一下界面状态就违背了「只算参数、不派活」的约定。
 *
 * 本文件不 import 任何东西：验收器会静态读源码，而 agents/workbuddy.mjs 在模块顶层
 * require('ws')。真正要切的那一刻才动态 import，拿不到就当成「这一路切不了」。
 */

/** 打印顺序 = 用户读的顺序，不随对象键序变化。 */
const AGENTS = ['workbuddy', 'codebuddy', 'trae', 'doubao'];

/**
 * 切不动的通道。2026-11-16 之后这张表是**空的** —— 四个通道全都能换模型了。
 *
 * 两次误判都是同一个错：把「我没找到」当成「它没有」。
 *   · doubao：入口是输入框右下角那个按钮，显示当前选中值，模型名要点开才看得见。
 *   · trae：入口是 button.core-model-select-trigger，但默认开着「Auto」自动挑模型，
 *     此时列表里只有 Auto 一行；把那个 switch 关掉，18 个模型才出来（用户一句话点破）。
 *
 * 留这张表是因为以后可能真有通道切不动 —— 但要写事实，不要写猜测。
 */
const NO_SWITCH = {};

/**
 * 三档模型表。mult 是 WorkBuddy 菜单里的真实积分倍率（0.00x 也要写出来，
 * 「不花积分」和「没测过」必须能分开）。
 * codebuddy 按账号积分计、菜单不显示倍率，所以不给 mult，打印时不带括号。
 * @type {Readonly<Record<string, {label: string, models: Record<string, string|null>, mult: Record<string, number>}>>}
 */
export const TIERS = Object.freeze({
  cheap: Object.freeze({
    label: '省积分',
    models: Object.freeze({ workbuddy: 'Hy3', codebuddy: 'hy3', trae: null, doubao: null }),
    mult: Object.freeze({ workbuddy: 0.00 }),
  }),
  balanced: Object.freeze({
    label: '均衡',
    models: Object.freeze({ workbuddy: 'GLM-5.3-Flash', codebuddy: 'glm-5.3-flash', trae: null, doubao: null }),
    mult: Object.freeze({ workbuddy: 0.08 }),
  }),
  strong: Object.freeze({
    label: '最强',
    models: Object.freeze({ workbuddy: 'Kimi-K3.1-Pro', codebuddy: 'kimi-k3.1-pro', trae: null, doubao: null }),
    mult: Object.freeze({ workbuddy: 0.97 }),
  }),
});

/**
 * 档位 → 模型档；null 表示「这次不切」。
 *
 * strict + S/M → cheap；strict + L → balanced；crazy → strong（不按 size 缩水）；
 * off → null（只转发，不动任何客户端状态）。不认识的 mode 也 null —— 猜错方向比不切更贵。
 *
 * @param {string} mode strict | crazy | off
 * @param {string} [size] S | M | L，只对 strict 有意义，缺省按 M（与 atwo 默认一致）
 * @returns {'cheap'|'balanced'|'strong'|null}
 */
export function tierFor(mode, size) {
  const m = String(mode == null ? '' : mode).trim().toLowerCase();
  if (m === 'crazy') return 'strong';
  if (m !== 'strict') return null;
  const s = String(size == null ? '' : size).trim().toUpperCase();
  return s === 'L' ? 'balanced' : 'cheap';
}

/**
 * 某档位下某通道该用哪个模型。
 * 返回 null = 这一档这个通道没有模型可换（切不动，或档位不认识）。
 * @param {string} tier cheap | balanced | strong
 * @param {string} agent workbuddy | codebuddy | trae | doubao
 * @returns {string|null}
 */
export function modelFor(tier, agent) {
  const t = TIERS[tier];
  if (!t) return null;
  const model = t.models[String(agent == null ? '' : agent).trim().toLowerCase()];
  return typeof model === 'string' && model ? model : null;
}

/**
 * 给用户核对的那一行（PRD R5）。用户唯一能验证「到底切了没有」的就是这句文字，
 * 所以必须逐通道写出来，不能只说「已按档位切换」。
 *
 * 例：▶ 模型：workbuddy→Hy3（0.00x）· codebuddy→hy3 · trae 不可切 · doubao 不可切
 *
 * @param {string|null} tier
 * @returns {string}
 */
export function renderTierLine(tier) {
  if (tier == null) return '▶ 模型：不切（流程关闭，保持原样）';
  const t = TIERS[tier];
  if (!t) return '▶ 模型：未知档位 ' + tier + '（不切）';

  const parts = [];
  for (const agent of AGENTS) {
    const model = t.models[agent];
    if (!model) { parts.push(agent + ' 不可切'); continue; }
    const mult = t.mult[agent];
    parts.push(agent + '→' + model + (typeof mult === 'number' ? '（' + mult.toFixed(2) + 'x）' : ''));
  }
  return '▶ 模型：' + parts.join(' · ');
}

/** 动态取某通道的 setModel；取不到或没实现都返回 null，由调用方记成「这一路切不了」。 */
async function loadSwitcher(agent) {
  const mod = await import('../agents/' + agent + '.mjs');
  return typeof mod.setModel === 'function' ? mod.setModel : null;
}

/**
 * 按档位真的去切：只动「能切」的通道，逐个 try/catch，任何一个失败都只记一笔。
 *
 * opts:
 *   plan         true = 只算不切（--plan），对应条目的 via 标 'plan'，界面一个像素都不动
 *   switchModel  (agent, model) => Promise<{ok, from?, reason?}>；测试与特殊通道注入用，
 *                不给就动态 import agents/<agent>.mjs 的 setModel
 *   model        出参：codebuddy 没有界面可点，换模型就是把这个字段交给调用方传下去
 *
 * @param {string|null} tier
 * @param {object} [opts]
 * @returns {Promise<{tier: string|null, applied: object[], skipped: object[], failed: object[], warnings: string[], env: Record<string,string>}>}
 */
export async function applyTier(tier, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const res = { tier: tier == null ? null : tier, applied: [], skipped: [], failed: [], warnings: [], env: {} };

  // 只切本次真正参与的通道：S 档只跑 codebuddy，却去点 workbuddy 的界面，
  // 等于为了别的批次擅自改了用户窗口状态（--plan 的姊妹约束：没参与就别动）。
  const list = Array.isArray(o.agents) && o.agents.length ? AGENTS.filter((a) => o.agents.includes(a)) : AGENTS;

  // off 或没给档：一个通道都不动，但要留话给调用方打印
  if (tier == null) {
    for (const agent of list) res.skipped.push({ agent, reason: '流程关闭，这次不切' });
    return res;
  }

  const t = TIERS[tier];
  if (!t) {
    res.warnings.push('未知档位 ' + tier + '，模型保持原样');
    for (const agent of list) res.skipped.push({ agent, reason: '未知档位' });
    return res;
  }

  for (const agent of list) {
    const model = t.models[agent];
    if (!model) {
      res.skipped.push({ agent, reason: NO_SWITCH[agent] || '该通道不支持切模型' });
      continue;
    }

    // --plan：只报会切成什么，绝不碰界面
    if (o.plan) { res.applied.push({ agent, model, via: 'plan' }); continue; }

    // codebuddy 没有界面：opts.model / CODEBUDDY_MODEL 就是它的换模型入口，不另造一套
    if (agent === 'codebuddy') {
      try {
        o.model = model;
        res.env.CODEBUDDY_MODEL = model;
        res.applied.push({ agent, model, via: 'opts.model' });
      } catch (e) {
        res.failed.push({ agent, model, reason: 'opts 不可写：' + (e && e.message ? e.message : String(e)) });
      }
      continue;
    }

    try {
      let out;
      if (typeof o.switchModel === 'function') {
        out = await o.switchModel(agent, model);
      } else {
        const setModel = await loadSwitcher(agent);
        if (!setModel) throw new Error('适配层还没有 setModel');
        out = await setModel(model);
      }
      if (out && out.ok === false) throw new Error(out.reason || '切换失败');
      res.applied.push({ agent, model, via: 'setModel', from: (out && out.from) || null });
    } catch (e) {
      res.failed.push({ agent, model, reason: e && e.message ? e.message : String(e) });
    }
  }

  return res;
}

/**
 * 同一通道的模型池（按积分倍率升序）—— 故障时「换一个模型重试」用。
 *
 * 为什么需要这张表：用户澄清过换模型的目的是「避免某一个模型超时或用不了」，
 * 不是「按档位省钱」。档位表解决「花多少」，这张表解决「这个不行换哪个」。
 *
 * 只收真实能切的通道：workbuddy（点界面）、codebuddy（--model）、doubao（点「自动」）。
 * trae 没有池子 —— 不是忘了写，是它这个账号只有 Auto 一项（见 NO_SWITCH）。
 *
 * 顺序 = 由省到贵。故障切换从当前位置往后找，不从头开始（省下的钱不必每次重付）。
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const POOL = Object.freeze({
  workbuddy: Object.freeze([
    'Hy3', 'GLM-5.3-Flash', 'Space-Bunny', 'MiniMax-M3.1-Flash', 'DeepSeek-V4.1-Flash',
    '快速', 'Hy4', 'Step-5-Preview', '均衡', 'DeepSeek-V4-Pro', 'GLM-5.3',
    'Kimi-K2.8-Preview', 'GLM-5.2', 'Kimi-K3.1-Pro', '极致', 'Kimi-K3', 'Xiaomi MiMo-V2.6-Pro',
  ]),
  codebuddy: Object.freeze([
    'hy3', 'glm-5.3-flash', 'space-bunny', 'minimax-m3.1-flash', 'deepseek-v4.1-flash',
    'hy4std', 'step-5-preview', 'deepseek-v4-pro', 'glm-5.3', 'glm-5.2',
    'kimi-k2.8-preview', 'kimi-k3.1-pro', 'kimi-k3-1', 'mimo-v2.6-pro',
  ]),
  // trae 菜单里的 18 项（2026-11-16 实测，先关掉 Auto 开关才看得见），按倍率由省到贵。
  // 名字里有连字符（Seed-Code / GLM-5.3-Flash），必须和菜单一模一样才能点中。
  trae: Object.freeze([
    'Seed-Code', 'MiMo-V2.6-Flash', 'DeepSeek-V4.1-Flash', 'GLM-5.3-Flash',
    'Qwen3.8-Flash', 'MiniMax-M3.1-Flash', 'MiMo-V2.6-Pro', 'Seed-2.1-Turbo',
    'MiniMax-M3', 'GLM-5.3-FlashX', 'DeepSeek-V4-Pro', 'Step-5-Preview',
    'GLM-5.3', 'Seed-2.1-Pro-0915', 'Seed-Evolving', 'Qwen3.8-Max',
    'Kimi-K3', 'Kimi-K3.1-Pro',
  ]),
  // 豆包菜单里的 11 项（2026-11-16 实测抓到的原文），按倍率由省到贵。
  // 名字必须和菜单里显示的字符串完全一致 —— 点击是按文本精确匹配的，差一个空格就点不中。
  doubao: Object.freeze([
    '豆包 2.1 Lite', 'DeepSeek V4.1 Flash', 'GLM 5.3 Flash', 'DeepSeek V4 Pro',
    '豆包 2.1 Pro', 'GLM 5.3', 'Kimi K3.1 Pro', 'Kimi K3.1 Pro 高速', 'Kimi K3', '自动',
  ]),
});

/**
 * 故障时该换哪个模型：在池子里找第一个「没试过、也不是当前这个」的。
 * 池子末尾返回 null = 这个通道的模型都试过了，该换通道了。
 *
 * @param {string} agent
 * @param {{current?: string|null, tried?: string[]}} [opts]
 * @returns {string|null}
 */
export function nextModelFor(agent, opts = {}) {
  const pool = POOL[String(agent == null ? '' : agent).trim().toLowerCase()];
  if (!pool || !pool.length) return null;
  const cur = opts.current == null ? '' : String(opts.current);
  const tried = new Set((opts.tried || []).map((x) => String(x)));
  const startAt = cur ? Math.max(0, pool.indexOf(cur) + 1) : 0;
  for (let i = startAt; i < pool.length; i++) {
    if (!tried.has(pool[i])) return pool[i];
  }
  // 当前在池子外（比如没设过），从头找一个没试过的
  for (const m of pool) if (!tried.has(m) && m !== cur) return m;
  return null;
}

/**
 * 某个通道到底能不能换模型（故障切换只在能换的地方有意义）。
 * @param {string} agent
 * @returns {boolean}
 */
export function canSwitchModel(agent) {
  const a = String(agent == null ? '' : agent).trim().toLowerCase();
  return !!POOL[a] && POOL[a].length > 0;
}

