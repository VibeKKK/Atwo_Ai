// file: vm/smoke.mjs
/**
 * @file vm/smoke.mjs
 * @description 冷进程冒烟：把契约里的参考向量逐组喂给 judge，比对 value 与 confidence。
 *
 * 为什么必须存在（2026-11-16 实测的漏洞）：lib/gate.mjs 的 contract 步只能证明
 * 「阈值没被写死在代码里」，不能证明「阈值还是原来那个值」。实测把契约 cut.high
 * 从 0.45 改成 0.50，gate 仍然全绿 6939ms —— 同一份 z 的结论从「可判」翻成「存疑」，
 * 闸门替它背书。这一步就是补那个洞：数据改了，跑一遍机器，值不对就红。
 *
 * 跑在独立子进程里（而不是 gate 进程内 import）：验的是「冷启动能不能算出同一结果」，
 * 顺带避开模块级缓存的干扰。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge } from './judge.mjs';
import { judgeVotes, ARITY } from './votes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONF_TOL = 1e-6;

export function runSmoke(file) {
  const p = file || path.join(HERE, 'oracle-contract.json');
  if (!fs.existsSync(p)) return { ok: false, contract: 'atwo-vm-smoke/1', checked: 0, failed: [{ name: '契约', why: '没有契约文件：' + p }] };
  let contract;
  try { contract = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { ok: false, contract: 'atwo-vm-smoke/1', checked: 0, failed: [{ name: '契约', why: '不是合法 JSON：' + (e && e.message) }] }; }
  const vectors = Array.isArray(contract.vectors) ? contract.vectors : [];
  const failed = [];
  for (const v of vectors) {
    let got;
    try { got = judge({ zValues: Array.isArray(v.zValues) ? v.zValues : [] }); } catch (e) { failed.push({ name: v.name || '?', why: 'judge 抛错：' + (e && e.message) }); continue; }
    if (got.value !== v.value) { failed.push({ name: v.name || '?', why: 'value 变了：契约 ' + v.value + ' / 现算 ' + got.value }); continue; }
    if (Number.isFinite(v.confidence) && Math.abs(got.confidence - v.confidence) > CONF_TOL) failed.push({ name: v.name || '?', why: 'confidence 变了：契约 ' + v.confidence + ' / 现算 ' + got.confidence });
  }
  const one = judgeVotes({ votes: ['ACCEPT', 'ACCEPT', 'ACCEPT'], expected: 3 });
  if (one.value !== 1 || one.state !== 'ACCEPT') failed.push({ name: '票面·满票', why: '3/3 张 ACCEPT 应判 ACCEPT，实得 ' + one.state });
  const short = judgeVotes({ votes: ['ACCEPT', 'ACCEPT', 'ACCEPT'], expected: 5 });
  if (short.value === 1) failed.push({ name: '票面·缺票', why: '到票 3/5 低于 arity ' + ARITY + '，不该放行' });
  const noRoster = judgeVotes({ votes: ['ACCEPT', 'ACCEPT', 'ACCEPT'] });
  if (noRoster.value === 1) failed.push({ name: '票面·无名单', why: '没声明应评名额却放行了' });
  return { ok: failed.length === 0, contract: 'atwo-vm-smoke/1', path: p, contractVersion: contract.contractVersion, checked: vectors.length + 3, failed };
}

const invoked = process.argv[1] ? String(process.argv[1]).replace(/\\/g, '/') : '';
if (invoked.endsWith('vm/smoke.mjs')) {
  const r = runSmoke(process.argv[2]);
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(r.ok ? 0 : 1);
}