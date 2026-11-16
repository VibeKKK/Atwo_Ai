// lib/fanout-cli.mjs —— atwo 的 fanout 动词本体。放在这里而不是 atwo.mjs 里，
// 是因为 atwo.mjs 已经 1100 行，再塞一个动词会让「谁改了哪」越来越难查。
import path from 'node:path';
import fs from 'node:fs';
import { clampParts, runFanout, finishFanout } from './fanout-run.mjs';

const pad2 = (v) => (v === 'PASS' ? 'PASS  ' : v === 'REVISE' ? 'REVISE' : 'unrevd');

function takeOpt(args, name) {
  const rest = [];
  let val = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) { val = args[i + 1] == null ? '' : args[i + 1]; i++; continue; }
    if (a.startsWith(name + '=')) { val = a.slice(name.length + 1); continue; }
    rest.push(a);
  }
  return { val, rest };
}

export function makeFanoutVerb(ctx) {
  const { EXIT, RESULT, HERE, die } = ctx;
  return async function cmdFanout(args) {
    let a = args;
    const oParts = takeOpt(a, '--parts'); a = oParts.rest;
    const oTimeout = takeOpt(a, '--timeout'); a = oTimeout.rest;
    const oReview = takeOpt(a, '--review-model'); a = oReview.rest;
    const oChild = takeOpt(a, '--child-model'); a = oChild.rest;
    // 长任务文本从文件读：命令行里塞多段中文 + 换行，在不同 shell 之间往返一次就变形一次，
    // 而任务文本变形等于整批子会话答错题。文件是唯一不经过转义层的传参方式。
    const oTaskFile = takeOpt(a, '--task-file'); a = oTaskFile.rest;
    const oFix = takeOpt(a, '--fix'); a = oFix.rest;
    // --dry-run 必须先抠掉：它留在 a 里会被 join 成任务文本的一部分，
    // 然后「试跑」两个字就跟着任务一起发给子会话了（这跟 --help 被当任务是同一类坑）。
    const noDry = a.filter((x) => x !== '--dry-run');
    const dryRun = noDry.length !== a.length;
    a = noDry;
    const fixRounds = oFix.val == null ? 0 : Math.max(0, Math.min(2, Number(oFix.val === '' ? 1 : oFix.val) || 0));
    let task = a.join(' ').trim();
    let taskFromFile = null;
    if (!task && oTaskFile.val) {
      const tf = path.resolve(HERE, String(oTaskFile.val));
      if (!fs.existsSync(tf)) return die('--task-file 指向的文件不存在：' + oTaskFile.val, EXIT.usage);
      task = fs.readFileSync(tf, 'utf8').trim();
      taskFromFile = path.relative(HERE, tf).replace(/\\/g, '/');
      if (!task) return die('--task-file 指向的文件是空的：' + taskFromFile, EXIT.usage);
    }
    if (oTaskFile.val && a.length) return die('--task-file 和位置参数只能给一个（两个都给，子会话不知道该干哪件）', EXIT.usage);
    if (!task) return die('fanout：要说清楚让子会话干什么，例如 atwo fanout "atwo.mjs 里 EXIT 有哪几个码" --parts 3（长文本用 --task-file 任务.md）', EXIT.usage);
    const n = clampParts(oParts.val || 3);

    // 试跑：只算不派。AI 想确认「会派几个、用什么模型、大概多久」时不该真花钱。
    if (dryRun) {
      const timeoutMs = Number(oTimeout.val) || 180000;
      console.log('试跑（不会派活、不会写盘）：');
      console.log('  任务      ' + task);
      console.log('  子会话    ' + n + ' 路（独立上下文，并发跑）');
      console.log('  子模型    ' + (oChild.val || '通道默认'));
      console.log('  父审模型  ' + (oReview.val || '通道默认'));
      console.log('  超时      ' + timeoutMs + 'ms / 路');
      console.log('  自愈      ' + (fixRounds ? fixRounds + ' 轮（被打回才重做）' : '关（判了 REVISE 也不重做）'));
      console.log('  父审权限  Read（只能读，改不了文件）');
      console.log('  预计      ' + Math.round((timeoutMs / 1000) * 0.25) + '–' + Math.round(timeoutMs / 1000 * 0.6) + 's（子会话取最慢那路 + 审查约 25s）');
      console.log('');
      console.log('真要跑就去掉 --dry-run。');
      RESULT.data = { dryRun: true, task, taskFile: taskFromFile, parts: n, childModel: oChild.val || null, reviewModel: oReview.val || null, timeoutMs, fixRounds };
      return EXIT.ok;
    }
    const d = new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    const stamp = '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
    const dir = path.join(HERE, '.atw', 'fanout', stamp);

    console.log('父会话派活：' + n + ' 个子会话（独立上下文）· 父只审不干' + (fixRounds ? ' · 被打回自动重做 ' + fixRounds + ' 轮' : ''));
    const res = await runFanout({
      task, parts: n, cwd: HERE,
      timeoutMs: Number(oTimeout.val) || 180000,
      reviewModel: oReview.val || undefined,
      childModel: oChild.val || undefined,
      fixRounds,
    });
    if (res.deadlineHit) {
      console.log('');
      console.log('✗ ' + res.error);
      console.log('  已经拿到的子会话产物仍然落盘了，别当成「没有结论」直接重跑。');
    }
    const file = finishFanout(res, dir);

    for (const c of res.children) {
      const r = res.reviews.find((x) => x.id === c.id) || {};
      console.log('  ' + c.id.padEnd(9) + pad2(r.verdict) + '  ' + String((c.elapsedMs / 1000).toFixed(1) + 's').padStart(6) + '  ' + (r.reason || ''));
    }
    const s = res.summary;
    console.log('');
    console.log('汇总：' + s.state + '（' + s.counts.PASS + ' 过 / ' + s.counts.REVISE + ' 重做 / ' + s.counts.unreviewed + ' 没票）· 子会话 ' + (res.elapsed.childrenMs / 1000).toFixed(1) + 's + 审查 ' + (res.elapsed.reviewMs / 1000).toFixed(1) + 's' + (res.elapsed.rounds > 1 ? ' · 共 ' + res.elapsed.rounds + ' 轮（含自愈重做）' : ''));
    console.log('记录：' + path.relative(HERE, file).replace(/\\/g, '/'));
    RESULT.data = {
      task, parts: res.parts, dir: path.relative(HERE, dir).replace(/\\/g, '/'),
      summary: s,
      children: res.children.map((c) => ({ id: c.id, ok: c.ok, elapsedMs: c.elapsedMs, malformed: !!c.malformed, answer: c.answer })),
      reviews: res.reviews,
      elapsed: res.elapsed,
      rounds: res.rounds ? res.rounds.map((r) => ({ round: r.round, summary: r.summary })) : [],
    };
    if (s.value === 1) return EXIT.ok;
    if (s.value === -1) return EXIT.accept;
    return EXIT.channel;
  };
}
