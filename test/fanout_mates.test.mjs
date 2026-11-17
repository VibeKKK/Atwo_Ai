// test/fanout_mates.test.mjs —— 派活时必须把「队友在改什么」告诉每一片。
// 起因（2026-11-17）：每片只知道自己的清单，改重了只能靠事后 git diff 发现，
// 今天真撞过一次（两个片同改 atwo.mjs）。补丁把 matesOf() 注入 chunkTask 之后。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFanout } from '../lib/fanout-run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; } else { fail += 1; console.log('  ✗ ' + m); } };

const FOUR = '核对这四个文件：lib/split.mjs、lib/lanes.mjs、lib/durfmt.mjs、lib/pitfalls.mjs，各写一句它们负责什么。';

// 1. 四单元切成多片：每一片的 prompt 都必须带上别人的清单
{
  const prompts = [];
  const ask = async (p) => { prompts.push(String(p)); return { ok: true, addedText: 'ans' + prompts.length }; };
  const res = await runFanout({ task: FOUR, split: 4, ask, cwd: root });
  const children = (res.children || []).length;
  ok(children >= 2, '四单元应当切成不止一片（实得 ' + children + ' 片）');
  const hits = prompts.filter((p) => p.includes('## 队友在改什么'));
  ok(hits.length > 0, '至少一片的 prompt 里要有「队友在改什么」段');
  ok(hits.length === prompts.length, '每一片都要有（' + hits.length + ' / ' + prompts.length + '）');
}

// 2. 队友段里不能出现自己负责的文件（否则等于告诉它可以动别人的东西）
{
  const prompts = [];
  const ask = async (p) => { prompts.push(String(p)); return { ok: true, addedText: 'a' }; };
  await runFanout({ task: FOUR, split: 4, ask, cwd: root });
  let selfLeak = 0;
  for (const p of prompts) {
    const iMine = p.indexOf('## 你这一片只负责');
    const iMate = p.indexOf('## 队友在改什么');
    if (iMine < 0 || iMate < 0) continue;
    const mineSeg = p.slice(iMine, iMate);
    const mateSeg = p.slice(iMate, iMate + 400);
    const mine = (mineSeg.match(/^- (lib\/[^\s、]+)/gm) || []).map((s) => s.replace(/^- /, '').trim());
    for (const f of mine) {
      if (f && mateSeg.includes(f)) selfLeak += 1;
    }
  }
  ok(selfLeak === 0, '队友段不该列自己负责的文件（泄漏 ' + selfLeak + ' 处）');
}

// 3. 只有一片时，任务文本必须和没有队友段时一致（不许凭空多出标题）
{
  const prompts = [];
  const ask = async (p) => { prompts.push(String(p)); return { ok: true, addedText: 'a' }; };
  await runFanout({ task: '只改 lib/durfmt.mjs，看看注释够不够。', split: 4, ask, cwd: root });
  ok(!prompts.some((p) => p.includes('## 队友在改什么')), '单片时不该出现队友段');
}

// 4. 段里要有明确禁令（「只读不改」「建议队友改」），否则模型会顺手改别人的文件
{
  const prompts = [];
  const ask = async (p) => { prompts.push(String(p)); return { ok: true, addedText: 'a' }; };
  await runFanout({ task: FOUR, split: 4, ask, cwd: root });
  const hit = prompts.find((p) => p.includes('## 队友在改什么')) || '';
  ok(hit.includes('只读不改'), '队友段要写「只读不改」');
  ok(hit.includes('建议队友改'), '队友段要给出「建议队友改」的出口');
}

console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exit(1);
