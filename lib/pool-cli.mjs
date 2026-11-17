// atwo pool —— 多池并发跑队列：按通道能力把队列里的作业分到池里，每池并发受通道硬上限约束。
//
// 为什么不是「queue run 加个并发数」：并发不是标量，通道之间差 6 倍（codebuddy 6 / GUI 1），
// 一个全局并发数必然要么拖死 codebuddy 要么压垮 GUI 通道。并发必须挂在通道上。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { claim, complete, fail, QUEUE_CONTRACT } from './queue.mjs';
import { runPool, planPool, LANE_CAPS, WRITER_LANES, POOL_CONTRACT } from './pool.mjs';
import { appendCost } from './taskcost.mjs';

function listArg(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || String(v).startsWith('--')) return [];
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}

export function makePoolVerb({ EXIT, RESULT, HERE, die }) {
  return async function cmdPool(argv) {
    const sub = String(argv[0] || 'run');
    const maxOpt = (() => {
      const i = argv.indexOf('--max');
      return i >= 0 ? Math.max(1, Math.min(12, Number(argv[i + 1]) || 4)) : 4;
    })();
    const lanesArg = listArg(argv, '--lanes');
    const lanes = (lanesArg && lanesArg.length ? lanesArg : WRITER_LANES).filter((l) => LANE_CAPS[l]);

    if (sub === 'plan') {
      // 只算不跑：看清楚「这 N 条会怎么分池」，不看就派活是赌博。
      const jobs = Array.from({ length: maxOpt }, (_, i) => ({ id: 'job-' + (i + 1), kind: 'x' }));
      const p = planPool(jobs, { lanes });
      RESULT.data = { contract: POOL_CONTRACT, plan: p.plan, unassigned: p.unassigned };
      console.log('分池（' + lanes.join(',') + '）：' + p.plan.map((x) => x.lane + '×' + x.jobs.length).join(' · '));
      return p.ok ? EXIT.ok : EXIT.usage;
    }

    if (sub !== 'run') die('用法：atwo pool <run|plan> [--max N] [--lanes a,b]', EXIT.usage);

    // 领活：先按 max 领出来，再交给池子跑。领出来没跑成的会留在 running，由 queue requeue 回收。
    const claimed = [];
    for (let i = 0; i < maxOpt; i++) {
      const c = claim(HERE, { owner: 'atwo-pool' });
      if (!c.ok) break;
      claimed.push(c);
    }
    if (!claimed.length) {
      RESULT.data = { contract: POOL_CONTRACT, claimed: 0, reason: 'empty' };
      console.log('队列空，没有要跑的。');
      return EXIT.ok;
    }

    const atwoPath = path.join(HERE, 'atwo.mjs');
    const ask = async (lane, job) => {
      const t0 = new Date().toISOString();
      const argv2 = [atwoPath, String(job.kind), ...(Array.isArray(job.args) ? job.args.map(String) : []), '--json'];
      const r = spawnSync(process.execPath, argv2, { cwd: HERE, encoding: 'utf8', timeout: 900000, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
      const code = typeof r.status === 'number' ? r.status : null;
      const out = String(r.stdout || '').slice(-2000);
      appendCost(HERE, { taskId: String(job.id), kind: String(job.kind), lane: String(lane), model: 'n/a', startedAt: t0, endedAt: new Date().toISOString(), tokensIn: 0, tokensOut: 0, calls: 1, note: 'pool 作业' });
      const red = code === 4; // 4 = 跑成了但结论红，不是执行失败
      return { ok: code === 0 || red, red, out, error: code === 0 || red ? null : 'exit ' + code + ' ' + String(r.stderr || '').slice(-200) };
    };

    const jobs = claimed.map((c) => ({ id: c.id, kind: c.job.kind, args: c.job.args || [] }));
    const r = await runPool(jobs, { ask, lanes });
    let ok = 0; let bad = 0;
    for (const res of r.results) {
      const rec = claimed.find((c) => c.id === res.id);
      if (res.ok) { complete(HERE, res.id, { lane: res.lane, ms: res.ms }); ok++; }
      else { fail(HERE, res.id, { lane: res.lane, error: res.error }); bad++; }
      if (!rec) continue;
    }
    RESULT.data = { contract: POOL_CONTRACT, claimed: claimed.length, ok, failed: bad, laneStats: r.laneStats, reassigned: r.reassigned };
    console.log('池子跑完：领 ' + claimed.length + ' · 成 ' + ok + ' · 败 ' + bad);
    for (const [lane, st] of Object.entries(r.laneStats || {})) {
      console.log('  ' + lane + ' ok=' + st.ok + ' fail=' + st.fail + ' ' + Math.round((st.ms || 0) / 1000) + 's');
    }
    if (r.reassigned.length) console.log('  改派 ' + r.reassigned.length + ' 条（原通道被判死）');
    return bad > 0 ? EXIT.accept : EXIT.ok;
  };
}
