/**
 * 派活前菜单核对（用户 2026-11-17 批准：「全部搞成自动检查模型」）。
 *
 * 钉住四件事：
 *   1) 档位想用的模型不在菜单里 → 立刻拉黑并记进 blocked（不是猜，是菜单说的）
 *   2) 选出来的模型必须是菜单里**真实存在**且预算内最省的
 *   3) 读不到菜单的通道只记 skipped，绝不阻断派活（读不到 ≠ 不能用）
 *   4) crazy 档不受 0.50x 限制（那一档本来就不计消耗）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ATWO_MODEL_BLOCKS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-verify-')), 'model-blocks.json');

const M = await import('../lib/models.mjs');
M.clearBlock('*');
M.__resetBlockCache();

const menu = (models, current = null) => () => Promise.resolve({ ok: true, models, current });

test('档位模型不在菜单里 → 拉黑并记进 blocked', async () => {
  M.clearBlock('*');
  M.__resetBlockCache();
  // strict + S = cheap 档，workbuddy 想用 Hy3；但菜单里已经没有 Hy3 了
  const v = await M.verifyModels('cheap', {
    agents: ['workbuddy'],
    listFn: menu(['GLM-5.3-Flash', 'DeepSeek-V4.1-Flash'], 'DeepSeek-V4.1-Flash'),
  });
  assert.equal(v.blocked.length, 1);
  assert.equal(v.blocked[0].model, 'Hy3');
  assert.equal(M.isBlocked('workbuddy', 'Hy3'), true, '必须落进不可用名单');
  assert.equal(v.chosen.workbuddy, 'GLM-5.3-Flash', '选菜单里预算内最省的');
  M.clearBlock('*');
});

test('菜单里模型齐全时：不拉黑，选最省的那个', async () => {
  M.clearBlock('*');
  M.__resetBlockCache();
  const v = await M.verifyModels('cheap', {
    agents: ['workbuddy'],
    listFn: menu(['Kimi-K3', 'GLM-5.3-Flash', 'Hy3'], 'Kimi-K3'),
  });
  assert.equal(v.blocked.length, 0);
  assert.equal(v.checked[0].count, 3);
  assert.equal(v.checked[0].current, 'Kimi-K3');
  assert.equal(v.chosen.workbuddy, 'Hy3', '0.00x 最省');
  M.clearBlock('*');
});

test('读不到菜单 → 只记 skipped，不阻断、不拉黑、不选', async () => {
  M.clearBlock('*');
  M.__resetBlockCache();
  const v = await M.verifyModels('cheap', {
    agents: ['trae'],
    listFn: () => Promise.resolve({ ok: false, reason: '端口没开' }),
  });
  assert.equal(v.skipped.length, 1);
  assert.match(v.skipped[0].reason, /端口没开/);
  assert.equal(v.blocked.length, 0);
  assert.equal(v.chosen.trae, undefined);
});

test('适配层没有 listModels 也不许抛（跳过就好）', async () => {
  const v = await M.verifyModels('cheap', { agents: ['codebuddy'], listFn: () => Promise.reject(new Error('boom')) });
  assert.equal(v.skipped.length, 1);
  assert.match(v.skipped[0].reason, /boom/);
});

test('crazy 档不受 0.50x 限制（可以挑到 1.62x 的 Kimi-K3）', async () => {
  M.clearBlock('*');
  M.__resetBlockCache();
  const v = await M.verifyModels('strong', {
    agents: ['workbuddy'],
    max: Infinity,
    listFn: menu(['Hy3', 'GLM-5.3-Flash', 'Kimi-K3']),
  });
  // 上限放开后 still 挑最省 —— 但关键断言是「超预算的模型也进了候选范围」
  assert.equal(v.chosen.workbuddy, 'Hy3');
  const v2 = await M.verifyModels('strong', {
    agents: ['workbuddy'],
    max: Infinity,
    listFn: menu(['Kimi-K3']),
  });
  assert.equal(v2.chosen.workbuddy, 'Kimi-K3', '只省 Kimi 时也要能选它');
  M.clearBlock('*');
});

test('默认档（0.50x）遇到全是贵模型的菜单 → 退回「自动」而不是硬选贵的', async () => {
  M.clearBlock('*');
  M.__resetBlockCache();
  const v = await M.verifyModels('cheap', {
    agents: ['doubao'],
    listFn: menu(['Kimi K3', 'Kimi K3.1 Pro', '自动']),
  });
  assert.equal(v.chosen.doubao, '自动');
  M.clearBlock('*');
});

test('打印行写清每个通道几项 + 拉黑了什么', async () => {
  M.clearBlock('*');
  M.__resetBlockCache();
  const v = await M.verifyModels('cheap', {
    agents: ['workbuddy', 'trae'],
    listFn: async (a) => (a === 'trae'
      ? { ok: false, reason: '没开调试' }
      : { ok: true, models: ['GLM-5.3-Flash'], current: 'GLM-5.3-Flash' }),
  });
  const line = M.renderVerifyLine(v);
  assert.match(line, /workbuddy 1 项/);
  assert.match(line, /当前 GLM-5\.3-Flash/);
  assert.match(line, /trae 读不到/);
  assert.match(line, /已拉黑 workbuddy\/Hy3/);
  M.clearBlock('*');
});
