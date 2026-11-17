// lib/board-cli.mjs —— `atwo board`：把散在四个账本里的状态渲染成一页 HTML。
//
// 为什么单独一个文件：`atwo.mjs` 已经 1700+ 行，而且这个仓有两个会话在并发改它。
// 新动词一律走「makeXxxVerb 工厂 + 一行 import + 一行表项」，改得越少越不容易被对方的
// 整文件覆盖冲掉（这个月已经发生过三次：cmdSnapshot 两次、viaDefinitions 一次）。
//
// 数据来源（缺文件不算错，看板宁可少一块也不该报错）：
//   memory/log.jsonl          → 任务流水
//   memory/pitfalls.jsonl     → 坑账本
//   memory/model-blocks.json  → 不可用模型
//   lanesSnapshot()           → 通道成功率
// 测试可用 ATWO_BOARD_LOG / ATWO_BOARD_PITFALL / ATWO_BOARD_BLOCKS 指到临时文件。

import fs from 'node:fs';
import path from 'node:path';
import { renderBoard } from './board.mjs';
import { readPitfalls } from './pitfalls.mjs';
import { lanesSnapshot } from './lanesnap.mjs';
import { listBlocks } from './models.mjs';

/** 逐行读 JSONL，坏行直接跳过（账本是追加写的，进程被杀时末行常常是半截）。 */
function readJsonl(file, limit) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = text.split(/\r?\n/).filter((s) => s.trim());
  const tail = limit > 0 ? lines.slice(-limit) : lines;
  const out = [];
  for (const ln of tail) {
    try { out.push(JSON.parse(ln)); } catch { /* 半截行，跳过 */ }
  }
  return out;
}

/** 流水行 → 看板任务行。字段名不统一（历史原因：log.jsonl 里 agent/verb/task 都出现过），所以全用兜底。 */
export function toRunRow(e) {
  const rec = e || {};
  const lanes = Array.isArray(rec.lanes) ? rec.lanes
    : (typeof rec.agent === 'string' && rec.agent ? [rec.agent] : []);
  const verdict = rec.ok === true ? 'ok' : (rec.ok === false ? 'failed' : (rec.verdict || '-'));
  const id = String(rec.task || rec.verb || rec.kind || rec.id || '-').slice(0, 60);
  const desc = String(rec.summary || rec.note || rec.desc || '').slice(0, 80);
  const ms = Number(rec.ms || rec.elapsedMs || 0) || 0;
  return { id, desc, verdict, ms, lanes };
}

/** 收集看板数据。所有路径都允许被环境变量改，便于测试隔离。 */
export function collectBoardData({ cwd, limit = 20, now = new Date() } = {}) {
  const root = cwd || process.cwd();
  const logFile = process.env.ATWO_BOARD_LOG || path.join(root, 'memory', 'log.jsonl');
  const pitFile = process.env.ATWO_BOARD_PITFALL || process.env.ATWO_PITFALL || path.join(root, 'memory', 'pitfalls.jsonl');
  const blockFile = process.env.ATWO_BOARD_BLOCKS || process.env.ATWO_MODEL_BLOCKS || path.join(root, 'memory', 'model-blocks.json');

  const runs = readJsonl(logFile, limit).map(toRunRow);
  let pitfalls = [];
  try { pitfalls = readPitfalls(pitFile).slice(-12).map((p) => ({ trigger: p.trigger, lesson: p.lesson, fix: p.fix })); } catch { pitfalls = []; }
  let lanes = [];
  try { lanes = (lanesSnapshot({ cwd: root, now }).lanes || []); } catch { lanes = []; }
  let blocks = [];
  try { blocks = listBlocks(now); } catch { blocks = []; }
  return { generatedAt: now.toISOString(), runs, lanes, pitfalls, blocks, jobs: [], notes: '' };
}

/**
 * 生成 `atwo board` 动词。
 * @param {{cwd?: string, EXIT?: object}} ctx
 */
export function makeBoardVerb({ cwd, EXIT } = {}) {
  const ex = EXIT || { ok: 0 };
  return function cmdBoard(args = [], RESULT = { data: {} }) {
    const root = cwd || process.cwd();
    const out = String(takeOptArg(args, '--out') || process.env.ATWO_BOARD_OUT || path.join(root, 'docs', 'reports', 'board.html'));
    const limit = Number(takeOptArg(args, '--limit')) || 20;
    const data = collectBoardData({ cwd: root, limit });
    const html = renderBoard(data);
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, html, 'utf8');
    } catch (err) {
      console.log('✗ 写看板失败：' + (err && err.message ? err.message : err));
      return ex.precondition === undefined ? 3 : ex.precondition;
    }
    const bytes = Buffer.byteLength(html, 'utf8');
    RESULT.data.board = { out, bytes, runs: data.runs.length, lanes: data.lanes.length, pitfalls: data.pitfalls.length };
    console.log('看板：' + out);
    console.log('  共 ' + data.runs.length + ' 条任务 · ' + data.lanes.length + ' 条通道 · ' + data.pitfalls.length + ' 条坑 · ' + bytes + ' 字节');
    console.log('  用浏览器打开即可（单文件、无外链、可离线看）');
    return ex.ok === undefined ? 0 : ex.ok;
  };
}

/** 极小的 `--flag value` 取值器（不引 atwo.mjs 的 takeOpt，避免循环依赖）。 */
function takeOptArg(args, name) {
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i]);
    if (a === name) return list[i + 1] === undefined ? '' : String(list[i + 1]);
    if (a.startsWith(name + '=')) return a.slice(name.length + 1);
  }
  return '';
}
