// test/split.test.mjs —— 长尾切分（把最慢那一路本身变小）
// 口径：墙钟 = 最慢那一个子任务，加路数对它零作用。切分只切「可枚举的工作单元」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_CHUNKS, chunkTask, describeSplit, detectUnits, mergeParts, planSplit } from '../lib/split.mjs';
import { runFanout } from '../lib/fanout-run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; } else { fail += 1; console.log('  ✗ ' + m); } };

// 1. glob 展开
{
  const u = detectUnits('审计 lib/*.mjs 这批文件', { cwd: root });
  ok(u.length >= 10 && u.every((x) => x.exists), '1 glob 展开得到 ' + u.length + ' 个真实文件');
  ok(u.every((x) => x.unit.startsWith('lib/')), '1b unit 是相对路径');
}

// 2. 显式文件名 + 去重 + 不存在不算
{
  const u = detectUnits('看 lib/split.mjs、lib/gate.mjs 和 不存在的.mjs，再看一次 lib/split.mjs', { cwd: root });
  ok(u.length === 2 && u.map((x) => x.unit).join(',') === 'lib/split.mjs,lib/gate.mjs', '2 显式文件去重且只留存在的，实得 ' + u.map((x) => x.unit).join(','));
}

// 3. 没有单元不切
{
  const p = planSplit('把置信度公式改成去重来源数', { cwd: root });
  ok(p.chunks.length === 0 && p.reason === 'no-units', '3 无单元 → 不切（' + p.reason + '）');
}

// 4. 单元太少不切（启动税摊不回本）
{
  // 2026-11-17 语义变更（rank1 的 lib/split.mjs）：片数 = min(上限, 簇数)，簇按真 import 聚。
  // 「单元数 < 4 不切」这条门槛已不再生效，改成「只有一簇就不切」。这一条守的就是它。
  const p = planSplit('看 lib/split.mjs test/split.test.mjs', { cwd: root });
  ok(p.chunks.length === 0 && p.reason === 'single-cluster', '4 实现与它的测试（同一簇）→ 不切（' + p.reason + '）');
}

// 5. 四个单元 → 2 片；每片 2 个
{
  const p = planSplit('审计 lib/split.mjs lib/gate.mjs lib/lanes.mjs lib/pregate.mjs', { cwd: root });
  // 四个互不 import 的模块 = 四簇 → 四片（上限 DEFAULT_MAX_CHUNKS=4）
  const want = Math.min(DEFAULT_MAX_CHUNKS, p.clusters.length);
  ok(p.chunks.length === want, '5 片数 = min(上限, 簇数)：' + p.chunks.length + ' / 簇 ' + p.clusters.length);
  ok(p.chunks.every((c) => c.units.length >= 1), '5b 没有空片');
  ok(p.units.length === 4, '5c 总单元数 4');
  ok(p.strategy === 'clusters', '5d 用的是簇策略（' + p.strategy + '）');
  ok(describeSplit(p).includes(p.chunks.length + ' 片'), '5e describeSplit 可读：' + describeSplit(p));
}

// 6. 上限：单元很多也不超过 maxChunks，默认上限是 DEFAULT_MAX_CHUNKS
{
  const many = '审计 ' + ['split','gate','lanes','pregate','fanout-run','fanout','cli-spec','preGate'].map((n) => {
    const cand = ['lib/' + n + '.mjs', 'lib/pre gate.mjs'];
    return cand[0];
  }).filter((p) => fs.existsSync(path.join(root, p))).join(' ');
  const p = planSplit(many, { cwd: root, maxChunks: 2 });
  ok(p.chunks.length <= 2, '6 maxChunks=2 时片数 <= 2，实得 ' + p.chunks.length);
  const p2 = planSplit(many, { cwd: root });
  ok(p2.chunks.length <= DEFAULT_MAX_CHUNKS, '6b 默认不超过 ' + DEFAULT_MAX_CHUNKS + ' 片');
}

// 7. chunkTask：片号 + 本片清单 + 越界禁令 + 格式契约仍在
{
  const p = planSplit('审计 lib/split.mjs lib/gate.mjs lib/lanes.mjs lib/pregate.mjs', { cwd: root });
  const text = chunkTask('审计这四个文件', p.chunks[0]);
  ok(text.includes('第 1 / ' + p.chunks.length + ' 片'), '7a 带片号');
  ok(p.chunks[0].units.every((u) => text.includes(u.unit)), '7b 本片清单逐条列出');
  ok(text.includes('不要越界'), '7c 有越界禁令');
  ok(!p.chunks[1].units.some((u) => text.split('不要越界')[0].includes(u.unit)), '7d 不列别片的单元');
}

// 8. 机械拼装：按片序、带片头、不丢证据
{
  const plan = { chunks: [{ index: 0, total: 2, label: 'chunk-1/2', units: [{ unit: 'a.mjs' }] }, { index: 1, total: 2, label: 'chunk-2/2', units: [{ unit: 'b.mjs' }] }] };
  const m = mergeParts([{ answer: 'A 的结论', evidence: 'a.mjs:1', chunkLabel: 'chunk-1/2' }, { answer: 'B 的结论', evidence: 'b.mjs:9', chunkLabel: 'chunk-2/2' }], plan);
  ok(m.parts === 2 && m.text.indexOf('A 的结论') < m.text.indexOf('B 的结论'), '8 按片序拼装');
  ok(m.text.includes('## 分片 1/2 · a.mjs') && m.text.includes('证据：b.mjs:9'), '8b 片头与证据都在');
  ok(mergeParts([], plan).text === '', '8c 空输入返回空');
}

// 9. 端到端：split 生效时按片派、产物带 chunkLabel、merged 有内容、父审仍需实读
{
  const seen = [];
  const ask = async (prompt, opts = {}) => {
    seen.push({ tools: opts.tools, prompt });
    return { ok: true, addedText: 'ANSWER: 本片逐项看完。\nEVIDENCE: lib/split.mjs:5 「export const MIN_UNITS_PER_CHUNK = 2;」', elapsedMs: 1 };
  };
  const res = await runFanout({ task: '审计 lib/split.mjs lib/gate.mjs lib/lanes.mjs lib/pregate.mjs', split: true, cwd: root, ask, timeoutMs: 5000, noPreGate: true, reviewChunk: 0 });
  const wantChunks = Math.min(DEFAULT_MAX_CHUNKS, (planSplit('审计 lib/split.mjs lib/gate.mjs lib/lanes.mjs lib/pregate.mjs', { cwd: root }).clusters || []).length);
  ok(res.split && res.split.chunks === wantChunks, '9 切 ' + wantChunks + ' 片，实得 ' + JSON.stringify(res.split));
  ok(res.children.length === wantChunks && res.children.every((c) => c.chunkLabel), '9b 每份产物都带 chunkLabel');
  ok(res.children.every((c) => seen.some((s) => s.prompt.includes(c.chunkLabel ? '第 ' : ''))), '9c 任务文本里带了片号');
  ok(res.merged && res.merged.text.length > 20 && res.merged.parts === wantChunks, '9d merged 拼装完成');
  ok(seen.filter((s) => s.tools === 'Read').length >= 1, '9e 父审仍然只读且被调用');
}

// 10. 不切时行为不变（回归）
{
  const res = await runFanout({ task: '把公式改成去重来源数', parts: 2, cwd: root, ask: async () => ({ ok: true, addedText: 'ANSWER: ok\nEVIDENCE: atwo.mjs:190', elapsedMs: 1 }), timeoutMs: 5000, noPreGate: true });
  ok(res.split === null && res.children.length === 2, '10 无单元时不切，仍按 parts 派');
}

// 11. takeOpt 不再把后一个开关当成值（--split --dry-run 曾导致试跑变真派活）
{
  const cli = fs.readFileSync(path.join(root, 'lib', 'fanout-cli.mjs'), 'utf8');
  ok(/String\(next\)\.startsWith\('-'\)/.test(cli) && /val = '';/.test(cli), '11 takeOpt 对以 - 开头的下一个 token 不当成值');
}

console.log((fail === 0 ? '✓ ' : '✗ ') + 'split: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);