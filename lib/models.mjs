/**
 * 按档位换模型（atwo-i2ilfe）：strict 花小钱，crazy 用最强。
 *
 * 四条通道的真实能力，全部是 2026-11-16 实测出来的，不是推测：
 *  · WorkBuddy  能切。点 trigger → 120ms 短轮询抓菜单（菜单只活几百毫秒，
 *               先 sleep(900) 再查必然拿到空数组）→ 点中文字包含名字的那项 → 读回 trigger 校验。
 *  · codebuddy  能切。CLI 的 --model / CODEBUDDY_MODEL / opts.model，--help 里列了 17 个 id。

 *  · Trae       能切（2026-11-16 下午修正：上午那条「不能切」是误判）。入口是
 *               button.core-model-select-trigger，但默认开着「Auto」自动挑模型，
 *               此时 listbox 只有 Auto 一行；先把 input[role=switch] 关掉，18 个模型才出来。
 *               三个必须踩对的点：Page.bringToFront；点 switch 本体不是外层 div；
 *               模型行要用 CDP 真实鼠标（Radix Select 在 pointerdown 上选择，合成事件不认）。
 *  · 豆包       能切（同日修正）。入口是输入框右下角那个显示当前值的按钮，点开才看得见模型名。
 *
 * 所以现状是 4/4 通道都能切。表里仍写 null 的通道表示「这一档不动它」，不是「切不动」——
 * 两者必须能分开，否则用户看到「不可切」会以为换模型这条路对它无效。
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
 * 默认档位（strict）允许的积分倍率上限。
 *
 * 用户原话：「改一下默认模式的积分消耗选择的模型 0.50x 以下的」。
 * 这条是**硬约束**，不是建议：strict 档选出来的模型，只要倍率已知就必须 ≤ 0.50x；
 * 倍率未知的模型一律不许进默认档（未知按最坏情况处理，不许当 0 花）。
 * crazy 档不受此限（那一档本来就是「不计消耗」）。
 */
export const MAX_DEFAULT_MULT = 0.5;

/**
 * 已知的积分倍率（2026-11-16 实测自 WorkBuddy 模型菜单）。
 *
 * 键是**归一化后的模型名**：小写、空白转连字符。这样同一个模型在四个通道里
 * 的不同写法（Hy3 / hy3、GLM-5.3-Flash / GLM 5.3 Flash）会落到同一个键上。
 * 表里没有的 = 倍率未知，不是 0x。
 * @type {Readonly<Record<string, number>>}
 */
export const MULT = Object.freeze({
  'hy3': 0.00,
  'glm-5.3-flash': 0.08,
  'deepseek-v4.1-flash': 0.11,
  'kimi-k3.1-pro': 0.97,
  'kimi-k3': 1.62,
});

/** 模型名归一化：小写 + 空白折叠成连字符。只用于查倍率表，不改真实模型名。 */
export function normModel(model) {
  return String(model == null ? '' : model).trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * 查一个模型的积分倍率。null = 未知（不要当成 0）。
 * @param {string} model
 * @returns {number|null}
 */
export function multOf(model) {
  const key = normModel(model);
  if (!key) return null;
  const v = MULT[key];
  return typeof v === 'number' ? v : null;
}

/**
 * 这个模型能不能进默认档：倍率已知且 ≤ 上限。未知一律 false。
 * @param {string} model
 * @param {number} [max]
 * @returns {boolean}
 */
export function withinBudget(model, max = MAX_DEFAULT_MULT) {
  const m = multOf(model);
  return m != null && m <= max;
}

/**
 * 在通道的模型池里挑「倍率已知且 ≤ 上限」的最便宜那个。
 * 池子按由省到贵排，所以第一个命中的就是最省的。
 * @param {string} agent
 * @param {number} [max]
 * @returns {string|null} null = 这个通道没有符合预算且倍率已知的模型
 */
export function pickWithinBudget(agent, max = MAX_DEFAULT_MULT) {
  const pool = usablePool(agent);
  if (!pool || !pool.length) return null;
  // 池子并不严格按倍率排（trae 的 DeepSeek-V4.1-Flash 1.1x 就排在 GLM-5.3-Flash 0.8x 前面），
  // 所以必须全扫一遍取最小倍率，不能取第一个合规的。同倍率时保留池子原序。
  let best = null;
  let bestMult = Infinity;
  for (const m of pool) {
    if (!withinBudget(m, max)) continue;
    if (isBlocked(agent, m)) continue; // 今天用不了的（订阅/次数）不再选它
    const v = multOf(m);
    if (v < bestMult) { best = m; bestMult = v; }
  }
  return best;
}

/**
 * 三档模型表。mult 是 WorkBuddy 菜单里的真实积分倍率（0.00x 也要写出来，
 * 「不花积分」和「没测过」必须能分开）。
 * codebuddy 按账号积分计、菜单不显示倍率，所以不给 mult，打印时不带括号。
 * @type {Readonly<Record<string, {label: string, models: Record<string, string|null>, mult: Record<string, number>}>>}
 */
export const TIERS = Object.freeze({
  cheap: Object.freeze({
    label: '省积分',
    // codebuddy 的 hy3 是抄 workbuddy 池子写进去的，实测 CLI 不认（2026-11-17 连 6 次 0 秒失败）
    // → 严格档给它自己的 glm-5.3-flash（0.08x，仍在预算内）。
    models: Object.freeze({ workbuddy: 'Hy3', codebuddy: 'glm-5.3-flash', trae: 'GLM-5.3-Flash', doubao: 'GLM 5.3 Flash' }),
  }),
  balanced: Object.freeze({
    label: '均衡',
    models: Object.freeze({ workbuddy: 'GLM-5.3-Flash', codebuddy: 'glm-5.3-flash', trae: 'DeepSeek-V4.1-Flash', doubao: 'DeepSeek V4.1 Flash' }),
  }),
  strong: Object.freeze({
    label: '最强',
    models: Object.freeze({ workbuddy: 'Kimi-K3.1-Pro', codebuddy: 'kimi-k3.1-pro', trae: 'Kimi-K3.1-Pro', doubao: 'Kimi K3.1 Pro' }),
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
 * 例：▶ 模型：workbuddy→Hy3（0.00x）· codebuddy→hy3 · trae→GLM-5.3-Flash · doubao 本档不切
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
    let model = t.models[agent];
    if (!model) { parts.push(agent + ' 本档不切'); continue; }
    // 模型会消失（用户 2026-11-17：hy3 没了）。档位表里那个名字要是已经拉黑，
    // 这里就得显示真正会用的那个，否则 --plan 说的和真跑做的不是一回事。
    let sub = false;
    if (isBlocked(agent, model)) {
      const alt = pickWithinBudget(agent, MAX_DEFAULT_MULT);
      if (alt) { model = alt; sub = true; }
      else { parts.push(agent + '→?' + '（' + t.models[agent] + ' 不可用，本档没替补）'); continue; }
    }
    const mult = multOf(model);
    // 倍率未知就明说「未知」，绝不省成「不带括号 = 免费」——那会让人以为省了钱。
    parts.push(agent + '→' + model + (sub ? '（替代）' : '') + '（' + (typeof mult === 'number' ? mult.toFixed(2) + 'x' : '倍率未知') + '）');
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

  const override = o.override && typeof o.override === 'object' ? o.override : null;
  for (const agent of list) {
    let model = override && override[agent] ? override[agent] : t.models[agent];
    if (!model) {
      res.skipped.push({ agent, reason: NO_SWITCH[agent] || '该通道不支持切模型' });
      continue;
    }
    // 档位表是昨天的快照，模型会消失（用户 2026-11-17：hy3 没了，模型变动很正常）。
    // 这一档指定的模型如果已经拉黑，就地换成预算内能用的，不要拿着死名字去点。
    if (isBlocked(agent, model)) {
      const alt2 = pickWithinBudget(agent, MAX_DEFAULT_MULT);
      if (alt2) {
        res.warnings.push(agent + ' 的 ' + model + ' 今天不可用，本档改用 ' + alt2);
        model = alt2;
      } else {
        res.skipped.push({ agent, reason: model + ' 不可用，且没有预算内的替代' });
        continue;
      }
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
 * 明确不可用的组合（不是额度问题，是「这个通道根本没有这个模型」）。
 * 证据：2026-11-17 codebuddy 连着 6 次 0 秒失败，因为 hy3 是抄 workbuddy 池子写进去的，
 *       codebuddy 的 CLI 不认它。这类错误不该走 12 小时拉黑（那不是临时故障），
 *       而该永久排除在该通道的候选之外。
 */
export const EXCLUDED = Object.freeze({
  codebuddy: Object.freeze(['hy3']),
});

/** 某通道真正可用的候选池（已经去掉永久排除项）。 */
export function usablePool(agent) {
  const a = String(agent == null ? '' : agent).trim().toLowerCase();
  const pool = POOL[a] || [];
  const bad = EXCLUDED[a] || [];
  return pool.filter((m) => !bad.includes(normModel(m)) && !bad.includes(m));
}

/**
 * 故障时该换哪个模型：在池子里找第一个「没试过、也不是当前这个」的。
 * 池子末尾返回 null = 这个通道的模型都试过了，该换通道了。
 *
 * @param {string} agent
 * @param {{current?: string|null, tried?: string[]}} [opts]
 * @returns {string|null}
 */
/**
 * 菜单里不是模型的项：档位（快速/均衡/极致）与「自动」。
 * 故障切换不能切到这些 —— 它们改的是思考强度/交给平台挑，不是换一个模型。
 */
const NON_MODEL_ITEMS = new Set(['快速', '均衡', '极致', '自动', 'Auto', 'auto']);

export function nextModelFor(agent, opts = {}) {
  const pool = POOL[String(agent == null ? '' : agent).trim().toLowerCase()];
  if (!pool || !pool.length) return null;
  const cur = opts.current == null ? '' : String(opts.current);
  const tried = new Set((opts.tried || []).map((x) => String(x)));
  // 当前这个已经被拉黑（订阅/额度）时，别从它后面继续找 —— 那是随机往下滚；
  // 直接从池子最省的一端重新挑一个今天真能用的。
  const startAt = cur && !isBlocked(agent, cur) ? Math.max(0, pool.indexOf(cur) + 1) : 0;
  for (let i = startAt; i < pool.length; i++) {
    if (!tried.has(pool[i]) && !isBlocked(agent, pool[i]) && !NON_MODEL_ITEMS.has(pool[i])) return pool[i];
  }
  // 当前在池子外（比如没设过），从头找一个没试过且今天能用的
  for (const m of pool) if (!tried.has(m) && m !== cur && !isBlocked(agent, m) && !NON_MODEL_ITEMS.has(m)) return m;
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

// ────────────────────────────────────────────────────────────────────────────
// 模型不可用名单（2026-11-17，用户实测反馈）
//
// 用户原话：「workbuddy 的 kimi 模型订阅的那一个超出使用次数了，因为我没订阅
// 所以这个模型用不了，遇到这种情况就赶紧换别的模型」。
//
// 这是**账号级**限制，不是超时也不是抽风：一旦某个模型报「超出次数 / 未订阅 /
// 无权限」，它今天就不可能好用，再点一次只是再浪费一轮 45s。
// 所以要做两件事：
//   1) 认得出这类错误（不是所有失败都该拉黑 —— 超时、空产出还可能重试成功）
//   2) 拉黑后落盘，之后 `nextModelFor` / `pickWithinBudget` 都跳过它，
//      直到有人手动解除（`atwo models unblock`），或文件过期（默认 12 小时）
//
// 为什么落盘：一个通道里四个 lane 并发跑同一个模型，第一个撞墙后，
// 另外三个不该再依次撞一遍。
// ────────────────────────────────────────────────────────────────────────────

/** 配额类错误的样子。只认「这个模型我用不了」，不认超时/空产出（那些重试有意义）。 */
const QUOTA_SIGS = [
  /超出使用次数/, /使用次数已(超|用)/, /次数已用完/, /额度(不足|已用尽|用完)/,
  /未订阅/, /没有订阅/, /需要订阅/, /仅限订阅/,
  /无权限/, /没有权限/, /权限不足/, /未开通/, /套餐/,
  /quota/i, /rate.?limit/i, /subscription/i, /not\s+entitled/i, /forbidden/i,
];

/**
 * 这段错误文本是不是「配额/订阅」类（模型级不可用），而不是「这次不顺」（通道级可重试）。
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeQuotaError(text) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  return QUOTA_SIGS.some((re) => re.test(s));
}

const BLOCK_TTL_MS = 12 * 3600 * 1000;

/** 进程内缓存：{ 'workbuddy|kimi-k3.1-pro': {reason, at} } */
let blockCache = null;

function blockFilePath() {
  // 允许测试指到临时目录，别污染真实账本。
  const override = process.env.ATWO_MODEL_BLOCKS;
  if (override) return override;
  return new URL('../memory/model-blocks.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

function loadBlockCache() {
  if (blockCache) return blockCache;
  blockCache = {};
  try {
    const fs = require('node:fs');
    const raw = fs.readFileSync(blockFilePath(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') blockCache = obj;
  } catch { /* 文件不存在 / 坏了都当空名单：宁可多试一次，也不能因为账本坏了停止派活 */ }
  return blockCache;
}

/** nextModelFor / pickWithinBudget 用不到的运行时 require（ESM 里拿 CJS 的 fs 与 path）。 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function blockKey(agent, model) {
  return String(agent || '').trim().toLowerCase() + '|' + normModel(model);
}

/**
 * 这个模型的今天还能不能用。
 * @param {string} agent
 * @param {string} model
 * @param {number} [now]
 * @returns {boolean} true = 被拉黑了
 */
export function isBlocked(agent, model, now = Date.now()) {
  const cache = loadBlockCache();
  const rec = cache[blockKey(agent, model)];
  if (!rec) return false;
  if (typeof rec.at === 'number' && now - rec.at > BLOCK_TTL_MS) return false;
  return true;
}

/**
 * 把一个模型记进不可用名单（落盘）。
 * @param {string} agent
 * @param {string} model
 * @param {string} reason
 * @param {number} [now]
 * @returns {{agent:string, model:string, reason:string, at:number}}
 */
export function blockModel(agent, model, reason, now = Date.now()) {
  const cache = loadBlockCache();
  const key = blockKey(agent, model);
  const rec = { agent: String(agent || '').trim().toLowerCase(), model: String(model || ''), reason: String(reason || ''), at: now };
  cache[key] = rec;
  try {
    const fs = require('node:fs');
    const p = blockFilePath();
    fs.mkdirSync(require('node:path').dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8');
  } catch { /* 落盘失败只是「下次还要再撞一次」，不影响本次切走 */ }
  return rec;
}

/** 列出还没过期的拉黑记录（给 `atwo models` 与日志用）。 */
export function listBlocks(now = Date.now()) {
  const cache = loadBlockCache();
  return Object.values(cache).filter((r) => !(typeof r.at === 'number' && now - r.at > BLOCK_TTL_MS));
}

/**
 * 派活前核对一遍模型菜单（用户 2026-11-17 批准：「全部搞成自动检查模型」）。
 *
 * 为什么要在派活**前**做：模型会消失（hy3 没了）、订阅会过期（Kimi 未订阅）。
 * 失败一次至少 45 秒起（GUI 通道还要重开会话），而读一次菜单只要 1~2 秒。
 *
 * 做的事：
 *   1) 问每个通道「你菜单里现在有什么、当前选的是哪个」（适配层的 listModels）
 *   2) 档位想用的模型如果不在菜单里 → 立刻拉黑（写明原因），并记进 blocked
 *   3) 从菜单里挑一个预算内最能用的（不传 = 默认 0.50x 上限）作为本次要切的模型
 *   4) 拿不到菜单的通道只记 skipped，不阻断（读不到不等于不能用）
 *
 * @param {'cheap'|'balanced'|'strong'|null} tier
 * @param {object} [opts]
 * @param {string[]} [opts.agents] 只核对这几路
 * @param {number} [opts.max] 预算上限；crazy 档传 Infinity
 * @param {(agent:string)=>Promise<{ok:boolean,models?:string[],current?:string|null,reason?:string}>} [opts.listFn]
 *        测试注入用；不给就动态 import agents/<agent>.mjs 的 listModels
 * @returns {Promise<{checked:object[], skipped:object[], blocked:object[], chosen:Record<string,string>, max:number}>}
 */
export async function verifyModels(tier, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const list = Array.isArray(o.agents) && o.agents.length ? AGENTS.filter((a) => o.agents.includes(a)) : AGENTS;
  const max = typeof o.max === 'number' ? o.max : MAX_DEFAULT_MULT;
  const t = TIERS[tier] || null;
  const out = { checked: [], skipped: [], blocked: [], chosen: {}, max };

  for (const agent of list) {
    let rss;
    try {
      if (typeof o.listFn === 'function') rss = await o.listFn(agent);
      else {
        const mod = await import('../agents/' + agent + '.mjs');
        rss = typeof mod.listModels === 'function' ? await mod.listModels() : { ok: false, reason: '该通道没有 listModels' };
      }
    } catch (e) {
      rss = { ok: false, reason: String((e && e.message) || e) };
    }

    const models = rss && Array.isArray(rss.models) ? rss.models : [];
    if (!rss || !rss.ok || !models.length) {
      out.skipped.push({ agent, reason: (rss && rss.reason) || '拿不到菜单（不阻断，按原样派）' });
      continue;
    }
    out.checked.push({ agent, count: models.length, current: (rss && rss.current) || null });

    const wanted = t && t.models[agent] ? t.models[agent] : null;
    if (wanted && !models.some((m) => normModel(m) === normModel(wanted))) {
      blockModel(agent, wanted, '菜单核对：这个模型已经不在菜单里了');
      out.blocked.push({ agent, model: wanted, reason: '已不在菜单里' });
    }

    // 先从菜单挑预算内最省的；挑不到（预算内全超）才退回档位原值，交给 setModel 去试。
    const pick = pickFromMenu(models, agent, max);
    if (pick) out.chosen[agent] = pick;
    else if (wanted && models.some((m) => normModel(m) === normModel(wanted))) out.chosen[agent] = wanted;
  }
  return out;
}

/** 菜单核对结果的一行回执（给 --plan 与真跑都能看）。 */
export function renderVerifyLine(v) {
  if (!v) return '▶ 菜单核对：跳过';
  const parts = [];
  for (const c of v.checked) parts.push(c.agent + ' ' + c.count + ' 项' + (c.current ? '（当前 ' + c.current + '）' : ''));
  for (const s of v.skipped) parts.push(s.agent + ' 读不到（' + s.reason + '）');
  const tail = v.blocked.length ? ' · 已拉黑 ' + v.blocked.map((b) => b.agent + '/' + b.model).join('、') : '';
  return '▶ 菜单核对：' + (parts.length ? parts.join(' · ') : '没有通道可核对') + tail;
}

/** 测试用：清掉进程内缓存（换 ATWO_MODEL_BLOCKS 后必须调它）。 */
export function __resetBlockCache() {
  blockCache = null;
  return true;
}

/**
 * 从「界面里真实存在的菜单项」挑一个能用的。
 *
 * 为什么需要它：用户 2026-11-17 反馈「hy3 没了，模型变动很正常」——
 * 池子是昨天的快照，菜单才是今天的真相。切换失败时 setModel 会把菜单原文带回来，
 * 这时候不该放弃，而该从菜单里挑一个：优先倍率已知且在预算内最省的，
 * 其次「自动」（让平台自己挑），再不然菜单第一项。
 *
 * @param {string[]} menu 菜单原文（setModel 失败时的 menu 字段）
 * @param {string} agent
 * @param {number} [max]
 * @returns {string|null}
 */
export function pickFromMenu(menu, agent, max = MAX_DEFAULT_MULT) {
  const items = (Array.isArray(menu) ? menu : []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
  if (!items.length) return null;
  let best = null;
  let bestMult = Infinity;
  for (const it of items) {
    if (NON_MODEL_ITEMS.has(it)) continue;
    if (isBlocked(agent, it)) continue;
    const v = multOf(it);
    if (v != null && v <= max && v < bestMult) { best = it; bestMult = v; }
  }
  if (best) return best;
  // 预算内一个都没有：退到「自动」，让平台自己挑一个能跑的
  const auto = items.find((x) => NON_MODEL_ITEMS.has(x) && /auto|自动/i.test(x));
  if (auto) return auto;
  const first = items.find((x) => !isBlocked(agent, x));
  return first || null;
}

/** 解除拉黑。传 agent+model，或 `*` 清空全部。 */
export function clearBlock(agent, model) {
  const cache = loadBlockCache();
  if (agent === '*' || (model == null && String(agent).includes('|'))) { blockCache = {}; }
  else if (model == null) {
    for (const k of Object.keys(cache)) if (k.startsWith(String(agent).toLowerCase() + '|')) delete cache[k];
  } else delete cache[blockKey(agent, model)];
  try {
    require('node:fs').writeFileSync(blockFilePath(), JSON.stringify(blockCache, null, 2), 'utf8');
  } catch { /* ignore */ }
  return listBlocks();
}

