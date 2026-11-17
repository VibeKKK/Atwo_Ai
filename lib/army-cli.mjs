// lib/army-cli.mjs —— atwo army：三三制（侦察 / 主力 / 评审）那个动词的本体。
// 放在单独文件里，理由和 fanout-cli 一样：atwo.mjs 已经 1300 行，再塞会让「谁改了哪」更难查。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMY_LIMITS, estimateArmy, pickUnits, validateArmy } from './army.mjs';
import { armyStamp, finishArmy, runArmy } from './army-run.mjs';
import { takeOpt } from './fanout-cli.mjs';
import { predictRun } from './outcome.mjs';

const dur = (ms) => (ms / 1000).toFixed(1) + 's';
const pad2 = (v) => (v === 'ACCEPT' ? 'ACCEPT' : v === 'REVISE' ? 'REVISE' : 'unrevd');
// 从 memory/log.jsonl 读真历史（只要跑过的通道与耗时，不看结论口径）。
// 读不到就返回空数组 —— 预测会自己说「算不出」，不猜。
function readRunRecords(limit = 600) {
  // 仓库根由本文件位置推出来（原来写死 D:/ai project/ai team work，换台机器就读不到历史）
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const p = path.join(root, 'memory', 'log.jsonl');
  let text = "";
  try { text = fs.readFileSync(p, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (!r || !r.agent) continue;
      const ms = Number(r.elapsedMs != null ? r.elapsedMs : r.ms);
      if (!Number.isFinite(ms) || ms <= 0) continue;
      rows.push({ agent: String(r.agent), ok: r.ok === true, elapsedMs: ms, ms });
    } catch { /* 坏行跳过：账本里可以有垃圾，预测不该被它拦死 */ }
  }
  return rows.slice(-limit);
}

export function makeArmyVerb(ctx) {
  const { EXIT, RESULT, HERE, die, activeTask } = ctx;
  return async function cmdArmy(args) {
    let a = args;
    const oTaskFile = takeOpt(a, '--task-file'); a = oTaskFile.rest;
    const oUnits = takeOpt(a, '--units'); a = oUnits.rest;
    const oReviewers = takeOpt(a, '--reviewers'); a = oReviewers.rest;
    const oTimeout = takeOpt(a, '--timeout'); a = oTimeout.rest;
    const oScoutLane = takeOpt(a, '--scout-lane'); a = oScoutLane.rest;
    const oScoutModel = takeOpt(a, '--scout-model'); a = oScoutModel.rest;
    const oMainLane = takeOpt(a, '--main-lane'); a = oMainLane.rest;
    const oMainModel = takeOpt(a, '--main-model'); a = oMainModel.rest;
    const oReviewLane = takeOpt(a, '--review-lane'); a = oReviewLane.rest;
    const oReviewModel = takeOpt(a, '--review-model'); a = oReviewModel.rest;
    const oNote = takeOpt(a, '--note'); a = oNote.rest;
    const useActive = a.includes('--active');
    const follow = a.includes('--follow');
    const noPreGate = a.includes('--no-pregate');
    const dryRun = a.includes('--dry-run');
    a = a.filter((x) => !['--active', '--follow', '--no-pregate', '--dry-run'].includes(x));

    let task = a.join(' ').trim();
    if (!task && oTaskFile.val) {
      const tf = path.resolve(HERE, String(oTaskFile.val));
      if (!fs.existsSync(tf)) return die('--task-file 指向的文件不存在：' + oTaskFile.val, EXIT.usage);
      task = fs.readFileSync(tf, 'utf8').trim();
      if (!task) return die('--task-file 指向的文件是空的：' + oTaskFile.val, EXIT.usage);
    }
    if (!task && useActive) {
      const at = typeof activeTask === 'function' ? activeTask() : null;
      if (!at) return die('--active：当前没有进行中的任务（先 atwo new "..." 开一个，或直接给 PRD 文本）', EXIT.precondition);
      task = String(at.title || at.name || '').trim();
      if (!task) return die('--active：当前任务没有 title，无法当 PRD', EXIT.precondition);
    }
    if (!task) {
      return die([
        'army：需要一个能拆出多个单元的 PRD（不是一句话任务）。',
        '',
        '  atwo army --task-file prd.md              # 从文件读（长文本走这个）',
        '  atwo army "改 lib/a.mjs 和 lib/b.mjs"      # 单元从文本里自动抠',
        '  atwo army "..." --units a.mjs,b.mjs        # 显式指定单元',
        '',
        '只有 1 个单元、或一句话就能答的题，用 atwo fanout 更便宜（三三制对单任务慢 72%）。',
      ].join('\n'), EXIT.usage);
    }

    const unitsPick = pickUnits(task, { cwd: HERE, units: oUnits.val ? String(oUnits.val).split(',') : null });
    // 严格解析：原来的 Math.floor(Number(x) || 1) 会把 --reviewers 0 / -1 / 非数字全部悄悄当成 1 路，
    // 实测 --reviewers 0 就是这样静默派出 1 路评审的（三三制真跑时被评审抓到）。
    let reviewers = 1;
    if (oReviewers.val !== null) {
      const n = Number(oReviewers.val);
      if (!Number.isInteger(n) || n < ARMY_LIMITS.minReviewers || n > ARMY_LIMITS.maxReviewers) {
        return die([
          '不派活：--reviewers 只能是 ' + ARMY_LIMITS.minReviewers + '-' + ARMY_LIMITS.maxReviewers + ' 的整数，收到 ' + JSON.stringify(oReviewers.val),
          '',
          '  （这次没有派出任何子会话，也没有写盘。）',
        ].join('\n'), EXIT.usage);
      }
      reviewers = n;
    }
    const gate = validateArmy({ units: unitsPick.units, reviewers });
    if (!gate.ok) {
      return die([
        '不派活：' + gate.reason,
        '',
        '  ' + gate.hint,
        '',
        '  （这次没有派出任何子会话，也没有写盘。）',
      ].join('\n'), EXIT.usage);
    }
    const units = unitsPick.units;
    const timeoutMs = Number(oTimeout.val) || 180000;
    const mainLane = oMainLane.val || 'codebuddy';
    const reviewLane = oReviewLane.val || 'codebuddy';
    const homogeneous = reviewLane === mainLane && String(oReviewModel.val || '') === String(oMainModel.val || '');

    if (dryRun) {
      const est = estimateArmy({ units: units.length, reviewers });
      console.log('三三制（PRD 批次阵型）· 试跑，不会派活、不会写盘：');
      console.log('  单元      ' + units.length + ' 个（来源：' + (unitsPick.from === 'explicit' ? '--units 显式' : '从 PRD 文本抠出') + '）');
      for (const [i, u] of units.entries()) console.log('            ' + (i + 1) + '. ' + u);
      console.log('  侦察      ' + (oScoutLane.val || 'auto') + (oScoutModel.val ? '（' + oScoutModel.val + '）' : '') + ' · 1 路只读，产出全部打 [候选] 标记');
      console.log('  主力      ' + mainLane + ' × ' + units.length + (oMainModel.val ? '（' + oMainModel.val + '）' : '') + ' · 异题并行，一单元一路，只读');
      console.log('  评审      ' + reviewLane + ' × ' + reviewers + (oReviewModel.val ? '（' + oReviewModel.val + '）' : '') + ' · 只找反例' + (homogeneous ? '（与主力同源：只能抓矛盾与硬错）' : '（异源）'));
      console.log('  机械闸门  ' + (noPreGate ? '关（--no-pregate）' : '开（缺「文件:行」的产物不送评审，直接 REVISE）'));
      console.log('  票面闸门  到票率 < ' + '0.8' + ' → unreviewed（声明 ' + reviewers + ' 路评审，缺一路就不算通过）');
      const history = readRunRecords();
      const pred = predictRun({ records: history, lanes: [...new Set([mainLane, reviewLane])], units: units.length });
      for (const line of pred.lines) console.log("  " + line);
      console.log('  静态假设  ' + est.stages.map((s) => s.stage + ' ' + dur(s.ms)).join(' + ') + ' = ' + dur(est.totalMs));
      console.log('  对照      ' + '只跑主力是 ' + dur(est.mainOnlyMs) + '，多出的 ' + Math.round(est.overheadRatio * 100) + '% 是批次摊薄的本钱（单元越多越划算）');
      console.log('');
      console.log('真要跑就去掉 --dry-run。');
      RESULT.data = { dryRun: true, prd: task, units, unitsFrom: unitsPick.from, reviewers, mainLane, reviewLane, homogeneous, estimate: est, prediction: pred };
      return EXIT.ok;
    }

    const dir = path.join(HERE, '.atw', 'army', armyStamp());
    fs.mkdirSync(dir, { recursive: true });
    const onProgress = follow ? (e) => {
      if (e.phase === 'scout-start') console.log('  → 侦察出发（' + e.lane + '，' + e.units + ' 个单元要探路）');
      else if (e.phase === 'scout-done') console.log('  ✓ 侦察回来：' + e.candidates + ' 条候选（全部标 [候选]）' + dur(e.ms));
      else if (e.phase === 'children-start') console.log('  → 主力 ' + e.n + ' 路异题并发（' + e.plan + '）');
      else if (e.phase === 'child-done') console.log('  ✓ ' + e.id + ' [' + e.lane + '] ' + dur(e.elapsedMs) + ' ' + e.chars + ' 字 · ' + e.unit);
      else if (e.phase === 'review-start') console.log('  → 评审 ' + e.reviewers + ' 路（送审 ' + e.n + ' 份，机械闸门先毙 ' + e.preGate + ' 份）');
      else if (e.phase === 'reviewer-done') console.log('  ✓ 评审 ' + e.reviewer + ' 回来：' + e.votes + ' 张票' + dur(e.ms));
    } : undefined;

    console.log('三三制：侦察 1 + 主力 ' + units.length + ' + 评审 ' + reviewers + '（PRD 批次阵型，不是单任务工具）');
    const res = await runArmy({
      task, cwd: HERE, units, reviewers, timeoutMs,
      scoutLane: oScoutLane.val || undefined, scoutModel: oScoutModel.val || undefined,
      mainLane, mainModel: oMainModel.val || undefined,
      reviewLane, reviewModel: oReviewModel.val || undefined,
      note: oNote.val || '', noPreGate, onProgress,
    });
    if (res.deadlineHit) {
      console.log('');
      console.log('✗ ' + res.error);
      console.log('  已经拿到的产物仍然落盘了，别当成「没有结论」直接重跑。');
    }
    const file = finishArmy(res, dir, task);

    console.log('');
    for (const s of res.settled) {
      console.log('  ' + s.id.padEnd(8) + pad2(s.state) + '  conf ' + (s.confidence != null ? Number(s.confidence).toFixed(3) : '  -  ') + '  ' + (String(s.counts.ACCEPT) + '认/' + String(s.counts.REVISE) + '改/' + String(s.counts.unreviewed) + '未评 应评' + s.expected).padEnd(22) + ' ' + String(s.reason) + (s.reasonText ? '（' + s.reasonText + '）' : ''));
    }
    const sum = res.summary;
    console.log('');
    console.log('汇总：' + sum.state + '（' + sum.counts.ACCEPT + ' 过 / ' + sum.counts.REVISE + ' 重做 / ' + sum.counts.unreviewed + ' 没票）· 侦察 ' + dur(res.elapsed.scoutMs) + ' + 主力 ' + dur(res.elapsed.mainMs) + ' + 评审 ' + dur(res.elapsed.reviewMs) + ' = ' + dur(res.elapsed.totalMs));
    if (res.sources.homogeneous) console.log('注意：评审与主力同源（' + res.sources.review + '）—— 能抓矛盾与硬错，抓不了「三份一致地错」。要异源就换 --review-lane ollama。');
    console.log('记录：' + path.relative(HERE, file).replace(/\\/g, '/'));
    RESULT.data = {
      prd: task, units: res.units, unitsFrom: res.unitsFrom,
      sources: res.sources, summary: sum, settled: res.settled,
      scout: { total: res.scout.total, model: res.scout.model, candidates: [...res.scout.skeleton, ...res.scout.risks, ...res.scout.checks].map((x) => ({ text: x.text, candidate: true, source: x.source })) },
      artifacts: res.artifacts.map((x) => ({ id: x.id, unit: x.unit, lane: x.lane, ok: x.ok, answer: x.answer, evidence: x.evidence })),
      elapsed: res.elapsed, preGate: res.preGate,
      dir: path.relative(HERE, dir).replace(/\\/g, '/'),
    };
    if (res.deadlineHit) return EXIT.channel;
    if (sum.value === 1) return EXIT.ok;
    if (sum.value === -1) return EXIT.accept;
    return EXIT.channel;
  };
}
