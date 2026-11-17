// lib/patch-cli.mjs —— atwo patch：让子会话在影子副本里真写代码，产出 patch 而不是「改好了」。
// 为什么单开动词而不塞进 fanout：fanout 的语义是「我只读、出结论」，patch 的语义是「它可以动手」。
// 混在一个动词里，谁都记不住默认值到底是只读还是可写 —— 11-16 那次 vm/judge.mjs 被覆写就是这个模糊的结果。
import { runPatch, formatPatchResult, MAX_WRITE_PARTS, PATCH_CONTRACT } from './writeback.mjs';
import { takeOpt } from './fanout-cli.mjs';

export function makePatchVerb(ctx) {
  const { EXIT, RESULT, HERE, die } = ctx;
  return async function cmdPatch(args) {
    let a = args.slice();
    const oParts = takeOpt(a, '--parts'); a = oParts.rest;
    const oTimeout = takeOpt(a, '--timeout'); a = oTimeout.rest;
    const oTest = takeOpt(a, '--test'); a = oTest.rest;
    const oModel = takeOpt(a, '--model'); a = oModel.rest;
    const oTurns = takeOpt(a, '--max-turns'); a = oTurns.rest;
    const oLane = takeOpt(a, '--lane'); a = oLane.rest;
    let dry = false;
    a = a.filter((x) => {
      if (x === '--dry-run') { dry = true; return false; }
      if (x === '--follow') { return false; } // 目前始终打印逐路进度，留着这个开关只为不打脸
      return true;
    });
    const task = a.join(' ').trim();
    if (!task) {
      return die([
        '用法：atwo patch "要改什么" [--test "node test/x.test.mjs"] [--parts 1-3] [--dry-run]',
        '',
        '  它在一份 git worktree 副本里改，改完自己 node --check 与跑测试，',
        '  过了才出 patch（主仓库零改动），不过整份丢。',
        '  合：git apply .atw/patches/<时间>.patch',
      ].join('\n'), EXIT.usage);
    }

    const parts = Math.max(1, Math.min(MAX_WRITE_PARTS, Math.floor(Number(oParts.val) || 1)));
    const testCmd = oTest.val ? String(oTest.val) : null;
    const lane = oLane.val ? String(oLane.val) : 'codebuddy';

    if (dry) {
      console.log([
        `将派 ${parts} 路写入 · 通道 ${lane} · 验收 ${testCmd || '（只做 node --check）'}`,
        `工作目录：一份临时 git worktree（主仓库 ${HERE} 不动）`,
        `任务：${task.slice(0, 200)}`,
        '（dry-run：没有建副本、没有派活、没有写盘）',
      ].join('\n'));
      RESULT.data = { contract: PATCH_CONTRACT, dryRun: true, parts, lane, testCmd };
      return EXIT.ok;
    }

    const { LANE_DEFS } = await import('./lanes.mjs').catch(() => ({ LANE_DEFS: null }));
    const def = LANE_DEFS && LANE_DEFS[lane];
    if (!def || !Array.isArray(def.roles) || !def.roles.includes('writer')) {
      return die(`不派活：${lane} 不能当写手（能写的：codebuddy / codex / ollama）。这次没有建副本，也没有写盘。`, EXIT.usage);
    }

    let ask;
    try {
      if (lane === 'codebuddy') ({ askCodeBuddy: ask } = await import('../agents/codebuddy.mjs'));
      else if (lane === 'codex') ({ askCodex: ask } = await import('../agents/codex.mjs'));
      else ({ askOllama: ask } = await import('../agents/ollama.mjs'));
    } catch (err) {
      return die(`通道 ${lane} 加载失败：${err && err.message}`, EXIT.channel);
    }
    if (typeof ask !== 'function') return die(`通道 ${lane} 没有可用的 ask`, EXIT.channel);

    const t0 = Date.now();
    let r;
    try {
      r = await runPatch({
        cwd: HERE,
        task,
        parts,
        testCmd,
        ask,
        model: oModel.val ? String(oModel.val) : null,
        maxTurns: Number(oTurns.val) || 24,
        timeoutMs: Math.max(60000, Number(oTimeout.val) || 600000),
        onProgress: (ev) => {
          if (ev.phase === 'worktree') console.log(`· 第 ${ev.index} 路副本就绪（叠了 ${ev.overlay && ev.overlay.copied || 0} 个未提交改动）`);
        },
      });
    } catch (err) {
      return die(`✗ 没成：${err && err.message}`, EXIT.channel);
    }

    console.log(formatPatchResult(r));
    RESULT.data = {
      contract: PATCH_CONTRACT,
      ok: r.ok,
      allOk: r.allOk,
      parts: (r.parts || []).map((p) => ({
        index: p.index, ok: p.ok, reason: p.reason, changed: p.changed.map((f) => f.path),
        tests: p.tests ? { cmd: p.tests.cmd, code: p.tests.code, ok: p.tests.ok } : null,
        patchPath: p.patchPath, elapsedMs: p.elapsedMs,
      })),
      patchPaths: r.patchPaths,
      elapsedMs: Date.now() - t0,
    };
    // 4 = 跑成了但结论是红（子会话改了但没过验收）——与 gate 同一个约定，别让人以为环境坏了。
    return r.ok ? EXIT.ok : EXIT.accept;
  };
}