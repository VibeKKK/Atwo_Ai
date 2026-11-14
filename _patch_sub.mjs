// 一次性补丁：给 orchestra.mjs 加 `sub` 命令（自己的子 agent）
// 用法：node _patch_sub.mjs
import fs from 'node:fs';

const F = 'orchestra.mjs';
let s = fs.readFileSync(F, 'utf8');
let n = 0;
const rep = (from, to, label) => {
  if (!s.includes(from)) { console.log('⚠ 没找到：' + label); return; }
  s = s.replace(from, to);
  n++;
  console.log('✓ ' + label);
};

// 1) import
rep(
  `import { runSwarm, loadSwarmTasks, parseSlots, renderReport, fmtMs, routeTask, listRuns, DEFAULT_SLOTS } from './lib/swarm.mjs';`,
  `import { runSwarm, loadSwarmTasks, parseSlots, renderReport, fmtMs, routeTask, listRuns, DEFAULT_SLOTS } from './lib/swarm.mjs';
import { DECOMPOSE_CONTRACT, parseSubtasks, singleTask, buildBrief, briefDir, writeBrief, digest, renderDigest } from './lib/subagent.mjs';`,
  'import'
);

// 2) usage
rep(
  `  swarm <任务源> [--flags]    N 个独立任务跨 agent 并行跑（吞吐最高的一档）`,
  `  swarm <任务源> [--flags]    N 个独立任务跨 agent 并行跑（吞吐最高的一档）
  sub "<目标>" [--n 3]        把目标拆成子任务，各自独立执行，只回摘要（子 agent）`,
  'usage'
);

// 3) NO_AGENT_CMDS
rep(
  `const NO_AGENT_CMDS = ['eph','ctx','duo','stats','auto','pick','doctor','probe','budget','health','list','swarm','top'];`,
  `const NO_AGENT_CMDS = ['eph','ctx','duo','stats','auto','pick','doctor','probe','budget','health','list','swarm','sub','top'];`,
  'NO_AGENT_CMDS'
);

// 4) sub 分支（插在 swarm 分支之前）
const anchor = `  // ---- swarm：N 个独立任务跨 agent 并行，榨干每一路并发 ----`;
const block = `  // ---- sub：自己的子 agent ----
  // 与 swarm 的区别：swarm 跑「已经拆好的独立任务」；sub 先从一句目标拆出子任务，
  // 每个子任务带角色提示词独立执行，回来只给摘要（全文留在 runs/<id>/）。
  // 拆解失败就退化成单任务，绝不因为「拆得不漂亮」整单失败。
  if (cmd === 'sub') {
    const goal = who0 && who0 !== 'sub' ? who0 : (args.shift() || '');
    if (!goal || String(goal).trim().length < 4) {
      console.error('用法: sub "<目标>" [--n 3] [--agent lead] [--slots trae=1,codebuddy=6] [--deep] [--resume]');
      process.exit(2);
    }
    const wantN = Math.max(1, Math.min(8, Number(argOfText('--n', '3')) || 3));
    const leadAgent = argOfText('--agent', process.env.ORCH_SUB_LEAD || 'codebuddy');
    const runId = 'sub' + Date.now();
    const t0 = Date.now();
    console.error('[sub] 目标：' + String(goal).replace(/\\s+/g, ' ').slice(0, 80));
    console.error('[sub] 拆解中（' + leadAgent + '，目标 ' + wantN + ' 个子任务）…');
    let subs = [];
    try {
      const dp = DECOMPOSE_CONTRACT.replace('__N__', String(wantN)) + '\\n\\n[目标]\\n' + String(goal).trim();
      const dr = await dispatch('sub-decompose', dp, { agent: leadAgent, contract: false });
      const txt = (dr && (dr.addedText || dr.text)) || '';
      subs = parseSubtasks(txt, wantN);
      if (!subs.length) {
        // 有的 agent 会把 JSON 塞进 code 字段
        const c = dr && dr.code ? String(dr.code) : '';
        if (c) subs = parseSubtasks(c, wantN);
      }
    } catch (e) {
      console.error('[sub] 拆解失败（' + (e && e.message) + '），退化为单任务');
    }
    if (!subs.length) subs = singleTask(goal);
    console.error('[sub] 拆出 ' + subs.length + ' 个：' + subs.map((x) => x.id + '.' + x.title).join(' | '));

    const dir = briefDir(runId);
    const briefPath = writeBrief(dir, goal, subs);

    const slots = parseSlots(argOfText('--slots', ''));
    const tasks = subs.map((x) => ({ id: x.id, text: buildBrief(x) }));
    const onProgress = (ev) => {
      const t = new Date().toISOString().slice(11, 19);
      if (ev.type === 'start') console.error('[' + t + '] ▶ #' + ev.id + ' ' + ev.agent + ' 路' + ev.slot);
      else if (ev.type === 'done') console.error('[' + t + '] ' + (ev.item.status === 'done' ? '✓' : '✗') + ' #' + ev.item.id + ' ' + fmtMs(ev.item.elapsedMs));
      else if (ev.type === 'retry') console.error('[' + t + '] ↻ #' + ev.id + ' ' + ev.from + '→' + ev.to);
      else if (ev.type === 'warn' || ev.type === 'move' || ev.type === 'split') console.error('[' + t + '] ⇄ ' + (ev.msg || ev.from + '→' + ev.to));
    };
    let out = null;
    try {
      out = await runSwarm(tasks, {
        mode: flags.mode, slots, resume: flags.resume, taskSource: 'sub:' + runId,
        dispatchFn: (text, extra) => dispatch('sub', text, extra),
        onProgress,
      });
    } catch (e) {
      console.error('ESUBFAIL ' + (e && e.message ? e.message : e));
      process.exit(3);
    }
    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    const d = digest(out.results, Number(argOfText('--chars', '160')) || 160);
    console.log(renderDigest(d));
    console.error('[sub] 墙钟 ' + wall + 's   产物：' + (briefPath ? path.dirname(briefPath) : dir) + '   报告：' + (out.dir || ''));
    process.exit(d.ok === d.total ? 0 : 4);
  }

`;
rep(anchor, block + anchor, 'sub 分支');

if (n) {
  fs.writeFileSync(F, s, 'utf8');
  console.log('写入 ' + F + '  ' + s.length + ' 字节');
} else {
  console.log('没有改动');
}
