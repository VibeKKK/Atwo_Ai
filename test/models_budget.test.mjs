/**
 * 默认档位的积分预算闸（用户要求：默认模式只选 0.50x 以下的模型）。
 *
 * 钉死三件事：
 *  1) strict 选出的每个模型，倍率必须**已知**且 ≤ 0.50x —— 未知不许当 0 花。
 *  2) crazy 档不受限（那一档就是「不计消耗」），但它的倍率也必须能查出来。
 *  3) 打印行里倍率未知的模型必须写「倍率未知」，不许静默留空。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 不可用名单是全局状态（memory/model-blocks.json）。测试必须指到临时文件，
// 否则「用户今天把 Hy3 拉黑了」会让这套断言无缘无故变红 —— 那是真事，不是回归。
process.env.ATWO_MODEL_BLOCKS = path.join(fsSync.mkdtempSync(path.join(os.tmpdir(), 'atwo-budget-')), 'model-blocks.json');

const {
  MAX_DEFAULT_MULT, MULT, TIERS, tierFor, modelFor, multOf, normModel,
  withinBudget, pickWithinBudget, renderTierLine, POOL, clearBlock, __resetBlockCache,
} = await import('../lib/models.mjs');

clearBlock('*');
__resetBlockCache();

const AGENTS = ['workbuddy', 'codebuddy', 'trae', 'doubao'];

test('上限就是 0.50x，不是别的数', () => {
  assert.equal(MAX_DEFAULT_MULT, 0.5);
});

test('倍率表里的五个值与我实测的一致（Hy3 是真的 0）', () => {
  assert.equal(MULT['hy3'], 0.0);
  assert.equal(MULT['glm-5.3-flash'], 0.08);
  assert.equal(MULT['deepseek-v4.1-flash'], 0.11);
  assert.equal(MULT['kimi-k3.1-pro'], 0.97);
  assert.equal(MULT['kimi-k3'], 1.62);
});

test('同一模型在四个通道的不同写法归一到同一个键', () => {
  assert.equal(normModel('Hy3'), 'hy3');
  assert.equal(normModel('GLM 5.3 Flash'), 'glm-5.3-flash');
  assert.equal(normModel('GLM-5.3-Flash'), 'glm-5.3-flash');
  assert.equal(normModel('DeepSeek V4.1 Flash'), 'deepseek-v4.1-flash');
  assert.equal(normModel('Kimi K3.1 Pro'), 'kimi-k3.1-pro');
});

test('倍率未知返回 null，绝不返回 0', () => {
  assert.equal(multOf('Space-Bunny'), null);
  assert.equal(multOf('豆包 2.1 Lite'), null);
  assert.equal(multOf(''), null);
  assert.equal(multOf(null), null);
});

test('withinBudget：已知且 ≤ 上限才 true，未知一律 false', () => {
  assert.equal(withinBudget('Hy3'), true);
  assert.equal(withinBudget('GLM-5.3-Flash'), true);
  assert.equal(withinBudget('DeepSeek V4.1 Flash'), true);
  assert.equal(withinBudget('Kimi-K3.1-Pro'), false);
  assert.equal(withinBudget('Kimi K3'), false);
  assert.equal(withinBudget('Space-Bunny'), false, '未知倍率必须被挡，不能当 0x');
});

test('strict 的两档（cheap/balanced）每个模型都在预算内且倍率已知', () => {
  for (const tier of ['cheap', 'balanced']) {
    for (const agent of AGENTS) {
      const model = modelFor(tier, agent);
      assert.ok(model, `${tier}/${agent} 应当有模型（原先是 null＝不切，等于放弃预算控制）`);
      const m = multOf(model);
      assert.ok(typeof m === 'number', `${tier}/${agent} 的「${model}」倍率未知，不许进默认档`);
      assert.ok(m <= MAX_DEFAULT_MULT, `${tier}/${agent} 的「${model}」倍率 ${m}x 超了 0.50x`);
    }
  }
});

test('strict + S/M 走 cheap，strict + L 走 balanced，crazy 走 strong', () => {
  assert.equal(tierFor('strict', 'S'), 'cheap');
  assert.equal(tierFor('strict', 'M'), 'cheap');
  assert.equal(tierFor('strict'), 'cheap', '缺省按 M');
  assert.equal(tierFor('strict', 'L'), 'balanced');
  assert.equal(tierFor('crazy', 'S'), 'strong', 'crazy 不按 size 缩水');
  assert.equal(tierFor('off', 'L'), null);
});

test('crazy 档允许超预算，但倍率仍然查得出来', () => {
  for (const agent of AGENTS) {
    const model = modelFor('strong', agent);
    assert.ok(model, `strong/${agent} 应当有模型`);
    const m = multOf(model);
    assert.ok(typeof m === 'number', `strong/${agent} 的「${model}」倍率未知`);
    assert.ok(m > MAX_DEFAULT_MULT, 'strong 档就是要最大倍率，不该被预算闸砍');
  }
});

test('pickWithinBudget：从省到贵挑第一个合规的', () => {
  assert.equal(pickWithinBudget('workbuddy'), 'Hy3');
  // 2026-11-17：codebuddy 的 CLI 不认 hy3（连 6 次 0 秒失败）→ 严格档改它自己的 glm-5.3-flash
  assert.equal(pickWithinBudget('codebuddy'), 'glm-5.3-flash');
  assert.equal(pickWithinBudget('trae'), 'GLM-5.3-Flash', 'trae 池子不按倍率排：必须全扫取最小，GLM-5.3-Flash 0.08x 胜过更靠前的 DeepSeek-V4.1-Flash 0.11x');
  assert.equal(pickWithinBudget('doubao'), 'GLM 5.3 Flash', '豆包 2.1 Lite 倍率未知跳过，GLM 5.3 Flash 0.08x 最小');
  assert.equal(pickWithinBudget('nosuch'), null);
});

test('pickWithinBudget 收得更紧时（0.05x）只有 Hy3 过关', () => {
  assert.equal(pickWithinBudget('workbuddy', 0.05), 'Hy3');
  assert.equal(pickWithinBudget('trae', 0.05), null);
});

test('TIERS 所选模型必须都在通道池子里（点不中的名字等于没切）', () => {
  for (const tier of ['cheap', 'balanced', 'strong']) {
    for (const agent of AGENTS) {
      const model = TIERS[tier].models[agent];
      if (!model) continue;
      assert.ok(POOL[agent].includes(model), `${tier}/${agent} 的「${model}」不在通道菜单池里`);
    }
  }
});

test('打印行：倍率已知带 x，未知写「倍率未知」', () => {
  const line = renderTierLine('cheap');
  assert.match(line, /workbuddy→Hy3（0\.00x）/);
  assert.match(line, /codebuddy→glm-5\.3-flash（0\.08x）/);
  assert.match(line, /trae→GLM-5\.3-Flash（0\.08x）/);
  assert.match(line, /doubao→GLM 5\.3 Flash（0\.08x）/);
  assert.doesNotMatch(line, /倍率未知/, 'cheap 档四个通道的倍率都该是已知的');
  assert.match(renderTierLine(null), /不切/);
});
