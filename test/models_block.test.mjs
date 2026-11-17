/**
 * 模型不可用名单（用户实测反馈：WorkBuddy 的 Kimi 是订阅模型，没订阅就用不了）。
 *
 * 钉住三件事：
 *   1) 认得出「配额/订阅」类错误（不然会把超时误判成不可用，白白降级）
 *   2) 拉黑后选模型真的跳过它，而且是落盘的（别的 lane 立刻受益）
 *   3) 账本坏了 / 文件不存在都不许让派活失败
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-blocks-'));
process.env.ATWO_MODEL_BLOCKS = path.join(TMP, 'model-blocks.json');

const M = await import('../lib/models.mjs');
M.__resetBlockCache();

test('认得出配额/订阅类错误', () => {
  assert.equal(M.looksLikeQuotaError('您已超出使用次数，请明天再试'), true);
  assert.equal(M.looksLikeQuotaError('当前模型额度不足'), true);
  assert.equal(M.looksLikeQuotaError('该模型仅限订阅用户'), true);
  assert.equal(M.looksLikeQuotaError('无权限访问此模型'), true);
  assert.equal(M.looksLikeQuotaError('429 rate limit exceeded'), true);
});

test('超时/空产出不算配额问题（那些重试有意义）', () => {
  assert.equal(M.looksLikeQuotaError('空产出'), false);
  assert.equal(M.looksLikeQuotaError('请求超时 450s'), false);
  assert.equal(M.looksLikeQuotaError('点了但按钮没变：GLM-5.3-Flash'), false);
  assert.equal(M.looksLikeQuotaError(''), false);
  assert.equal(M.looksLikeQuotaError(null), false);
});

test('拉黑 → 落盘 → 查得到 → 解除', () => {
  M.clearBlock('*');
  assert.equal(M.isBlocked('workbuddy', 'Kimi-K3.1-Pro'), false);

  M.blockModel('workbuddy', 'Kimi-K3.1-Pro', '超出使用次数');
  assert.equal(M.isBlocked('workbuddy', 'Kimi-K3.1-Pro'), true);
  // 名字大小写/空白不同也要认成同一个模型
  assert.equal(M.isBlocked('workbuddy', 'kimi k3.1 pro'), true);
  // 别的通道不受影响
  assert.equal(M.isBlocked('trae', 'Kimi-K3.1-Pro'), false);

  const file = process.env.ATWO_MODEL_BLOCKS;
  assert.equal(fs.existsSync(file), true, '必须落盘，否则别的 lane 还会再撞一次');
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(obj['workbuddy|kimi-k3.1-pro'], '键名是 通道|归一化模型名');

  const left = M.clearBlock('workbuddy', 'Kimi-K3.1-Pro');
  assert.equal(left.length, 0);
  assert.equal(M.isBlocked('workbuddy', 'Kimi-K3.1-Pro'), false);
});

test('nextModelFor 跳过拉黑的模型', () => {
  M.clearBlock('*');
  M.__resetBlockCache();
  // 池子里最省的是 Hy3，拉黑它之后应当直接给出下一个
  assert.equal(M.nextModelFor('workbuddy', { current: null, tried: [] }), 'Hy3');
  M.blockModel('workbuddy', 'Hy3', '额度不足');
  assert.notEqual(M.nextModelFor('workbuddy', { current: null, tried: [] }), 'Hy3');
  assert.equal(M.nextModelFor('workbuddy', { current: null, tried: [] }), 'GLM-5.3-Flash');
  M.clearBlock('*');
});

test('pickWithinBudget 跳过拉黑的模型（默认档不许挑到用不了的）', () => {
  M.clearBlock('*');
  M.__resetBlockCache();
  assert.equal(M.pickWithinBudget('workbuddy'), 'Hy3', 'Hy3 是 0.00x，最省');
  M.blockModel('workbuddy', 'Hy3', '超出使用次数');
  assert.equal(M.pickWithinBudget('workbuddy'), 'GLM-5.3-Flash', 'Hy3 不可用就落到 0.08x 的 GLM');
  M.clearBlock('*');
});

test('账本文件坏了也不许抛（宁可多试一次）', () => {
  const file = process.env.ATWO_MODEL_BLOCKS;
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  M.__resetBlockCache();
  assert.equal(M.isBlocked('workbuddy', 'Hy3'), false);
  assert.doesNotThrow(() => M.blockModel('trae', 'Seed-Code', '无权限'));
  assert.equal(M.isBlocked('trae', 'Seed-Code'), true, '坏账本应被重写成合法 JSON');
});

test('过期的拉黑自动失效（默认 12 小时）', () => {
  M.clearBlock('*');
  M.__resetBlockCache();
  const old = Date.now() - 13 * 3600 * 1000;
  M.blockModel('doubao', 'Kimi K3', '额度不足', old);
  assert.equal(M.isBlocked('doubao', 'Kimi K3'), false, '过了 12 小时就当没拉黑过');
  assert.equal(M.listBlocks().length, 0);
  M.clearBlock('*');
});
