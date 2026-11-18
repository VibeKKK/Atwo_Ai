// lib/inbox-cli.mjs —— atwo drain：把「往收件箱扔任务」变成「它自己干完并记账」。
// 无人值守的最小闭环 = 任务源外移 + 认领 + 执行 + 验收 + 归档。缺任何一环都得有人在场。
import fs from 'node:fs';
import path from 'node:path';
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
      patch: async (spec, cx) => {
        const ask = await askOf(String(spec.lane || 'codebuddy'));
        // 降级形态：同一任务已经连续失败过，就不要再让它一遍遍改同一处。
        // 只出报告，落成 <id>.report.md —— 人回来第一眼就知道卡在哪。
        if (spec.asReport) {
          const r0 = await runPatch({
            cwd: HERE,
            task: spec.task,
            parts: 1,
            testCmd: null,
            ask,
            maxTurns: Number(spec.maxTurns) || 24,
            timeoutMs: Number(spec.timeoutMs) || 600000,
            readOnly: true,
          });
          const part0 = (r0.parts && r0.parts[0]) || {};
          // 空报告也要写一句可读原因：空白文件等于静默失败，人回来只看得到一个空标题。
          const report = String(part0.report || part0.answer || '').trim()
            || '通道没有给出报告：' + (part0.reason || r0.error || '未知原因');
          const reportPath = path.join(inboxDir(HERE), (cx && cx.id ? cx.id : 'report') + '.report.md');
          fs.writeFileSync(
            reportPath,
            '# 降级报告（第 ' + (spec.failStreak + 1) + ' 次尝试：不再改代码）' + String.fromCharCode(10) + String.fromCharCode(10) + report + String.fromCharCode(10),
            'utf8'
          );
          return { ok: !!r0.ok, reason: r0.ok ? null : (part0.reason || '降级模式也没给出报告'), reportPath, applied: false };
        }
        const r = await runPatch({
          cwd: HERE,
          task: spec.task,
          parts: Number(spec.parts) || 1,
          testCmd: spec.test || null,
          ask,
          maxTurns: Number(spec.maxTurns) || 24,
          timeoutMs: Number(spec.timeoutMs) || 600000,
        });
        // ok 的含义是「改出来了且过了验收」，不是「已经生效」。
        // 2026-11-18 实抓：degrade-e2e 这条 ok:true 进了 done/，但 README 里根本没有它要加的那行 ——
        // runPatch 把改动存成 .atw/patches/*.patch 就结束（日志自己写着「主仓库未改动」），
        // 落地要人自己 git apply。所以结果里必须明写 applied:false，否则看 done/ 的人会以为生效了。
        return {
          ok: r.ok,
          reason: r.ok ? null : ((r.parts && r.parts[0] && r.parts[0].reason) || 'patch 没过验收'),
          patchPaths: r.patchPaths || [],
          applied: false,
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
      processed: r.processed.map((p) => ({ id: p.id, kind: p.kind, ok: p.ok, degraded: p.degraded, reason: p.reason, elapsedMs: p.elapsedMs })),
      skipped: r.skipped,
      remaining: r.remaining,
      elapsedMs: r.elapsedMs,
    };
    return r.ok ? EXIT.ok : EXIT.accept;
  };
}