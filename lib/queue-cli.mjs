// atwo queue <add|list|run|requeue> —— 把任意 atwo 动词变成一条可排队、可重试、掉电不丢的作业。
//
// 为什么是「包一层 atwo 命令」而不是自己定义作业类型：作业种类会一直长（judge/fanout/army/gate/…），
// 每加一种都要改两处必然漂移。这里把 kind 直接当动词名，args 直接当它的参数数组，队列只负责持久与重试。
import { spawnSync } from 'node:child_process';
import { jobVerdict } from './jobverdict.mjs';
import path from 'node:path';
import { enqueue, claim, complete, fail, listQueue, requeueStale, QUEUE_CONTRACT } from './queue.mjs';
import { runOnce } from './supervisor.mjs';
import { appendCost } from './taskcost.mjs';

const VERBS_ALLOWED = null;

/**
 * 退出码 → 作业结论。**exit 4 是「跑成功了但结论是红」，不是作业失败。**
 * 不这么分的话，重试机制会把「已经判出 REVISE 的产物」当成没跑成，反复重跑同一份东西，
 * 而且 done 目录永远看不到「查出了问题」的作业 —— 审计时只看 failed 会以为系统从没抓到过错。
 */
export { jobVerdict }; // 不设白名单：atwo 自己的动词表已经是白名单，这里再列一遍必然漂移

function takeOpt(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return { found: false, val: null, rest: argv };
  const next = argv[i + 1];
  const hasVal = next != null && !String(next).startsWith('--');
  const val = hasVal ? next : '';
  const rest = argv.slice(0, i).concat(argv.slice(i + (hasVal ? 2 : 1)));
  return { found: true, val, rest };
}

function parseArgs(argv) {
  // --args 收 JSON（数组=参数数组，对象=一个对象参数），不写就是空
  const r = takeOpt(argv, '--args');
  if (!r.found || !r.val) return { ok: true, args: [], rest: r.rest };
  try {
    const v = JSON.parse(r.val);
    return { ok: true, args: Array.isArray(v) ? v : [v], rest: r.rest };
  } catch (e) {
    return { ok: false, reason: '--args 不是合法 JSON：' + e.message, rest: r.rest };
  }
}

/** 一条作业的执行体：按 kind 当动词名去跑 atwo，--json 收结构化结果。 */
function makeRunner(EXIT, atwoPath, cwd) {
  return async (job) => {
    const t0 = new Date().toISOString();
    const argv = [atwoPath, String(job.kind), ...(Array.isArray(job.args) ? job.args.map(String) : []), '--json'];
    const r = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', timeout: 900000, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
    const text = String(r.stdout || '');
    const idx = text.lastIndexOf('{"ok"');
    let data = null;
    if (idx >= 0) { try { data = JSON.parse(text.slice(idx)); } catch { data = null; } }
    const code = typeof r.status === 'number' ? r.status : null;
    // 每条作业一账：现在只能拿到墙钟与调用数，token 用量 CLI 的 json 里不是稳定字段，
    // 所以 tokensIn/Out 先记 0 并写明未采集 —— 假数字比没数字更糟。
    const endedAt = new Date().toISOString();
    appendCost(cwd, {
      taskId: String(job.id || ''),
      kind: String(job.kind || ''),
      lane: String(job.lane || 'codebuddy'),
      model: String(process.env.CODEBUDDY_MODEL || 'deepseek-v4.1-flash'),
      startedAt: t0,
      endedAt,
      tokensIn: 0,
      tokensOut: 0,
      calls: 1,
      note: 'token 未采集（CLI json 无稳定 usage 字段）',
    });
    const v = jobVerdict(code);
    return { ok: v.ok, red: v.red, why: v.why, exitCode: code, data, stderr: String(r.stderr || '').slice(-400) };
  };
}

export function makeQueueVerb({ EXIT, RESULT, HERE, die }) {
  return async function cmdQueue(argv) {
    const sub = String(argv[0] || '');
    const rest = argv.slice(1);
    const atwoPath = path.join(HERE, 'atwo.mjs');

    if (sub === 'add') {
      const kind = String(rest[0] || '');
      if (!kind) die('用法：atwo queue add <动词> [--args JSON] [--note 备注]', EXIT.usage);
      const a = parseArgs(rest.slice(1));
      if (!a.ok) die(a.reason, EXIT.usage);
      const note = takeOpt(a.rest, '--note').val;
      const r = enqueue(HERE, { kind, args: a.args, note: note || undefined });
      if (!r.ok) die('入队失败：' + r.reason, EXIT.precondition);
      RESULT.data = { contract: QUEUE_CONTRACT, id: r.id, kind, args: a.args };
      console.log('已入队 ' + r.id + ' · ' + kind + (a.args.length ? ' ' + a.args.join(' ') : ''));
      console.log('  跑它：atwo queue run（或等 AtwoQueueSupervisor 计划任务，每 5 分钟一次）');
      return EXIT.ok;
    }

    if (sub === 'list' || sub === '') {
      const q = listQueue(HERE);
      RESULT.data = q;
      const c = q.counts;
      console.log('队列 · 待 ' + c.pending + ' · 跑 ' + c.running + ' · 完 ' + c.done + ' · 败 ' + c.failed);
      for (const it of q.items.slice(-12)) {
        console.log('  [' + it.state + '] ' + it.id + ' · ' + it.kind + (it.attempts ? ' · 已试 ' + it.attempts + ' 次' : ''));
      }
      if (!q.items.length) console.log('  （空）');
      return EXIT.ok;
    }

    if (sub === 'requeue') {
      const r = requeueStale(HERE, {});
      RESULT.data = r;
      console.log('回收超时作业 ' + r.requeued.length + ' 条' + (r.failed.length ? ' · 判败 ' + r.failed.length + ' 条' : ''));
      return EXIT.ok;
    }

    if (sub === 'run') {
      const maxOpt = takeOpt(rest, '--max');
      const max = Math.max(1, Math.min(6, Number(maxOpt.val) || 2));
      const runner = makeRunner(EXIT, atwoPath, HERE);
      const r = await runOnce(HERE, { runner, max, owner: 'atwo-queue-run' });
      RESULT.data = r;
      if (!r.ok) die('supervisor 没跑起来：' + r.reason, EXIT.precondition);
      console.log('本轮领 ' + r.claimed + ' 条 · 成 ' + r.completed + ' · 败 ' + r.failed);
      for (const x of r.results) {
        console.log('  ' + (x.ok ? '✓' : '✗') + ' ' + x.id + ' ' + Math.round(x.ms / 1000) + 's' + (x.error ? ' —— ' + x.error : ''));
      }
      return r.failed > 0 ? EXIT.accept : EXIT.ok;
    }

    die('用法：atwo queue <add|list|run|requeue>\n\n  add <动词> [--args JSON] [--note 备注]   入队一条 atwo 命令\n  list                                    看队列\n  run [--max N]                           领活跑（默认 2 条）\n  requeue                                 把跑超时的作业放回队列', EXIT.usage);
  };
}
