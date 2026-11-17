// lib/inbox-cli.mjs —— atwo drain：把「往收件箱扔任务」变成「它自己干完并记账」。
// 无人值守的最小闭环 = 任务源外移 + 认领 + 执行 + 验收 + 归档。缺任何一环都得有人在场。
import { drainOnce, formatDrain, listInbox, inboxDir } from './inbox.mjs';
import { takeOpt } from './fanout-cli.mjs';
import { runPatch } from './writeback.mjs';

async function askOf(lane) {
  if (lane === 'codebuddy') return (await import('../agents/codebuddy.mjs')).askCodeBuddy;
  if (lane === 'codex') return (await import('../agents/codex.mjs')).askCodex;
  if (lane === 'ollama') return (await import('../agents/ollama.mjs')).askOllama;
  throw new Error('不认识的写手通道：' + lane);
}

export function makeDrainVerb(ctx) {
  const { EXIT, RESULT, HERE, die } = ctx;
  return async function cmdDrain(args) {
    let a = args.slice();
    const oLimit = takeOpt(a, '--limit'); a = oLimit.rest;
    let dry = false;
    a = a.filter((x) => { if (x === '--dry-run') { dry = true; return false; } return true; });
    if (a.length) return die('用法：atwo drain [--limit N] [--dry-run]（收件箱：' + inboxDir(HERE) + '）', EXIT.usage);

    if (dry) {
      const listed = listInbox(HERE);
      if (!listed.entries.length) { console.log('收件箱是空的：' + inboxDir(HERE)); return EXIT.ok; }
      for (const e of listed.entries) {
        console.log(e.ok ? `· ${e.id} [${e.spec.kind}] ${String(e.spec.task).slice(0, 80)}` : `✗ ${e.id} —— ${e.reason}`);
      }
      console.log(`（dry-run：${listed.entries.length} 条待办，没有认领、没有执行）`);
      RESULT.data = { contract: 'atwo-inbox/1', dryRun: true, entries: listed.entries.map((e) => ({ id: e.id, ok: e.ok, reason: e.reason, kind: e.spec && e.spec.kind })) };
      return EXIT.ok;
    }

    const handlers = {
      patch: async (spec) => {
        const ask = await askOf(String(spec.lane || 'codebuddy'));
        const r = await runPatch({
          cwd: HERE,
          task: spec.task,
          parts: Number(spec.parts) || 1,
          testCmd: spec.test || null,
          ask,
          maxTurns: Number(spec.maxTurns) || 24,
          timeoutMs: Number(spec.timeoutMs) || 600000,
        });
        return {
          ok: r.ok,
          reason: r.ok ? null : ((r.parts && r.parts[0] && r.parts[0].reason) || 'patch 没过验收'),
          patchPaths: r.patchPaths || [],
        };
      },
      gate: async (spec) => {
        const { runGate } = await import('./gate.mjs');
        const r = await runGate({ cwd: HERE, files: Array.isArray(spec.files) ? spec.files : [], skipTests: !!spec.skipTests });
        const red = (r.steps || []).filter((s) => !s.ok);
        return { ok: !!r.ok, reason: r.ok ? null : red.map((s) => s.name + ': ' + (s.detail || '')).join('; ') };
      },
    };

    let r;
    try {
      r = await drainOnce({
        cwd: HERE,
        limit: Number(oLimit.val) || 5,
        handlers,
        log: (ev) => {
          if (ev.phase === 'invalid') console.log(`✗ ${ev.id} 任务文件有问题：${ev.reason}`);
          else if (ev.phase === 'done') console.log(`${ev.ok ? '✓' : '✗'} ${ev.id} [${ev.kind}]`);
        },
      });
    } catch (err) {
      return die('✗ drain 挂了：' + (err && err.message), EXIT.channel);
    }

    console.log(formatDrain(r));
    RESULT.data = {
      contract: r.contract,
      ok: r.ok,
      processed: r.processed.map((p) => ({ id: p.id, kind: p.kind, ok: p.ok, reason: p.reason, elapsedMs: p.elapsedMs })),
      skipped: r.skipped,
      remaining: r.remaining,
      elapsedMs: r.elapsedMs,
    };
    return r.ok ? EXIT.ok : EXIT.accept;
  };
}