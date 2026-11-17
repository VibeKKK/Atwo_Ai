// test/board.test.mjs —— `atwo board` 的三件硬要求：
// ① 渲染器是纯函数且真转义（日志里的 < 不能把页面搞坏）；
// ② 账本里半截行/坏行不许把看板带崩；
// ③ 写盘失败要说人话并给前置条件退出码（不能静默通过）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBoard } from '../lib/board.mjs';
import { collectBoardData, makeBoardVerb, toRunRow } from '../lib/board-cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; } else { fail += 1; console.log('  ✗ ' + m); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-board-'));

// ── ① 渲染器：纯 + 转义 + 四块内容
{
  const data = {
    generatedAt: '2026-11-17T20:50:00Z',
    runs: [{ id: 'r1', desc: '<script>alert(1)</script>', verdict: 'ok', ms: 132900, lanes: ['codebuddy'] }],
    lanes: [{ agent: 'codebuddy', judged: 10, ok: 9, rate: 0.9, avgMs: 22115, blocked: false },
      { agent: 'workbuddy', judged: 0, ok: 0, rate: null, avgMs: 0, blocked: true }],
    pitfalls: [{ trigger: '补丁', lesson: '引号嵌套', fix: '用「」' }],
    notes: '备注 <b>x</b>',
  };
  const a = renderBoard(data);
  const b = renderBoard(data);
  ok(a === b, '同样入参两次调用必须逐字节相同（纯函数）');
  ok(a.startsWith('<!doctype html>') || a.startsWith('<!DOCTYPE html>'), '要返回完整 HTML 文档');
  ok(!a.includes('<script'), '页面里不许有 script 标签（含注入进来的）');
  ok(a.includes('&lt;script&gt;'), '入参里的尖括号必须被转义');
  ok(a.includes('概览') && a.includes('通道') && a.includes('坑') && a.includes('任务'), '四块内容都要在');
  ok(a.includes('已拉黑'), '被拉黑的通道要在状态列写「已拉黑」');
  ok(a.includes('90.0%') || a.includes('90%'), '成功率要带百分号');
  ok(renderBoard().length > 100, '空数据也要出页面，不许抛');
  const sparse = renderBoard({ runs: [{ id: undefined, lanes: undefined }] });
  ok(!sparse.includes('undefined'), '缺字段不许渲染出 undefined');
  ok(sparse.includes('-'), '缺字段要兜成「-」');
}

// ── ② 采集：坏行跳过、字段兜底
{
  const log = path.join(tmp, 'log.jsonl');
  fs.writeFileSync(log, [
    JSON.stringify({ task: '好行一', ok: true, ms: 1000, agent: 'codebuddy' }),
    JSON.stringify({ verb: 'go', ok: false, elapsedMs: 2000, lanes: ['deepseek'] }),
    '{"半截行":',
    '',
    'not json at all',
  ].join('\n'));
  const pit = path.join(tmp, 'pitfalls.jsonl');
  fs.writeFileSync(pit, [
    JSON.stringify({ kind: 'pitfall', time: 'T', trigger: '补丁', lesson: '引号', fix: '「」' }),
    JSON.stringify({ kind: 'other', trigger: '不该出现', lesson: 'x' }),
  ].join('\n'));
  process.env.ATWO_BOARD_LOG = log;
  process.env.ATWO_BOARD_PITFALL = pit;
  process.env.ATWO_BOARD_BLOCKS = path.join(tmp, 'none.json');
  const data = collectBoardData({ cwd: tmp, limit: 10, now: new Date('2026-11-17T21:00:00Z') });
  ok(data.runs.length === 2, '坏行必须跳过，只留两条好行（实得 ' + data.runs.length + '）');
  ok(data.runs[1].lanes.length === 1 && data.runs[1].lanes[0] === 'deepseek', 'lanes 字段要原样带过来');
  ok(data.runs[0].ms === 1000 && data.runs[1].ms === 2000, 'ms / elapsedMs 都要认');
  ok(data.pitfalls.length === 1 && data.pitfalls[0].trigger === '补丁', '只收 kind=pitfall 的记录');
  ok(data.generatedAt === '2026-11-17T21:00:00.000Z', 'generatedAt 只来自入参，不许读真实时钟');
  ok(toRunRow({}).verdict === '-' && toRunRow({}).id === '-', '空记录要兜成「-」而不是 undefined');
}

// ── ③ 动词：写盘 + 失败给前置条件码
{
  const out = path.join(tmp, 'sub', 'board.html');
  const RESULT = { data: {} };
  const cmd = makeBoardVerb({ cwd: tmp, EXIT: { ok: 0, precondition: 3 } });
  const code = cmd(['--out', out, '--limit', '5'], RESULT);
  ok(code === 0, '正常写盘退出码应为 0（实得 ' + code + '）');
  ok(fs.existsSync(out), '应生成 HTML 文件');
  ok(RESULT.data.board && RESULT.data.board.runs >= 0, 'RESULT.data.board 要带统计');
  ok(String(RESULT.data.board.out).endsWith('board.html'), 'RESULT 要带回输出路径');

  // --out 指到一个「文件」下面 → 必然 mkdir 失败
  const blocker = path.join(tmp, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const bad = makeBoardVerb({ cwd: tmp, EXIT: { ok: 0, precondition: 3 } })(['--out', path.join(blocker, 'x.html')], { data: {} });
  ok(bad === 3, '写盘失败要返回前置条件退出码 3（实得 ' + bad + '）');
}

delete process.env.ATWO_BOARD_LOG;
delete process.env.ATWO_BOARD_PITFALL;
delete process.env.ATWO_BOARD_BLOCKS;
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exit(1);
