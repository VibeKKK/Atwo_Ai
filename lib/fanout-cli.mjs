// lib/fanout-cli.mjs —— atwo 的 fanout 动词本体。放在这里而不是 atwo.mjs 里，
// 是因为 atwo.mjs 已经 1100 行，再塞一个动词会让「谁改了哪」越来越难查。
import path from 'node:path';
import fs from 'node:fs';
import { clampFanoutParts, clampParts, runFanout, finishFanout } from './fanout-run.mjs';
import { DEFAULT_MAX_CHUNKS, describeSplit, planSplit, checkSplit, renderSplitLine } from './split.mjs';

const pad2 = (v) => (v === 'PASS' ? 'PASS  ' : v === 'REVISE' ? 'REVISE' : 'unrevd');

export function takeOpt(args, name) {
  const rest = [];
  let val = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) {
      // 2026-11-16 坑：原先无条件吃掉后一个 token，于是 `--split --dry-run` 把 --dry-run 当成值，
      // 试跑变成真派活。凡是「后一个 token 是另一个开关」的情况都必须挡住。
      const next = args[i + 1];
      // 负数是值不是开关：judge --z -0.5,1 / army --reviewers -1 都必须能带进来，
      // 否则 -1 被当成「没给值」静默变空值（实测 --reviewers -1 因此悄悄跑成 1 路）。
      if (next != null && (!String(next).startsWith('-') || /^-\d/.test(String(next)))) { val = next; i++; } else { val = ''; }
      continue;
    }
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
    const oReviewLane = takeOpt(a, '--review-lane'); a = oReviewLane.rest;
    const oChild = takeOpt(a, '--child-model'); a = oChild.rest;
    // 长任务文本从文件读：命令行里塞多段中文 + 换行，在不同 shell 之间往返一次就变形一次，
    // 而任务文本变形等于整批子会话答错题。文件是唯一不经过转义层的传参方式。
    const oTaskFile = takeOpt(a, '--task-file'); a = oTaskFile.rest;
    const oFix = takeOpt(a, '--fix'); a = oFix.rest;
    // --split N：长尾切分（把最慢那一路本身变小）。不带值 = 自动，上限 4 片。
    const oSplit = takeOpt(a, '--split'); a = oSplit.rest;
    // 编队（大兵团）：默认 auto —— 先真探测再定谁上几路；--lanes codebuddy:4,ollama:4 显式，--no-lanes 回单通道。
    const oLanes = takeOpt(a, '--lanes'); a = oLanes.rest;
    const oChildTools = takeOpt(a, '--child-tools'); a = oChildTools.rest;
    // 事故防线：codebuddy 的 --tools 默认是 Write,Edit,Read —— 派出去的子会话能改仓库，
    // 2026-11-16 vm/judge.mjs 就是这么被写成一坨 LLM 回答文本的。默认只读，写权限要显式开关。
    const allowWrite = a.includes('--allow-write');
    const noLanesFlag = a.includes('--no-lanes');
    const noPreGateFlag = a.includes('--no-pregate');
    a = a.filter((x) => x !== '--no-lanes' && x !== '--allow-write');
    const laneSpec = oLanes.val && oLanes.val !== 'auto' ? String(oLanes.val).split(',').map((x) => x.split(':')[0].trim()).filter(Boolean) : null;
    const autoLanes = !noLanesFlag;
    // --dry-run 必须先抠掉：它留在 a 里会被 join 成任务文本的一部分，
    // 然后「试跑」两个字就跟着任务一起发给子会话了（这跟 --help 被当任务是同一类坑）。
    const noDry = a.filter((x) => x !== '--dry-run');
    const dryRun = noDry.length !== a.length;
    a = noDry;
    // 开关位必须在 join 成任务文本之前抠掉 —— --help / --dry-run 都踩过这个坑。
    const noFollow = a.filter((x) => x !== '--follow' && x !== '--active');
    const follow = noFollow.length !== a.length && a.includes('--follow');
    const useActive = a.includes('--active');
    a = noFollow;
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
    let taskFromActive = null;
    if (!task && useActive) {
      const at = typeof ctx.activeTask === 'function' ? ctx.activeTask() : null;
      if (!at) return die('--active：当前没有进行中的任务（先 atwo new "..." 开一个，或直接给任务文本）', EXIT.precondition);
      task = String(at.title || at.name || '').trim();
      taskFromActive = at.id || at.name || null;
      if (!task) return die('--active：当前任务 ' + taskFromActive + ' 没有 title，无法当任务文本', EXIT.precondition);
    }
    if (oTaskFile.val && a.length) return die('--task-file 和位置参数只能给一个（两个都给，子会话不知道该干哪件）', EXIT.usage);
    if (!task) {
      const at = typeof ctx.activeTask === 'function' ? ctx.activeTask() : null;
      if (at) {
        const line = '当前任务是「' + (at.title || at.name) + '」—— 要派它就加 --active（不用再复制一遍）：';
        console.log(line);
        console.log('  atwo fanout --active --parts 3');
        console.log('');
      }
    }
    if (!task) return die('fanout：要说清楚让子会话干什么，例如 atwo fanout "atwo.mjs 里 EXIT 有哪几个码" --parts 3（长文本用 --task-file 任务.md）', EXIT.usage);
    // 不传 --parts 就别逼 AI 现场决定：按任务体积给默认值。
    // 少参数不是省事，是不给它「要不要多派几路」这个决策点 —— 决策点一出现，
    // 默认解永远是「算了，我自己干」。
    const atForSize = typeof ctx.activeTask === 'function' ? ctx.activeTask() : null;
    const sizeParts = { S: 2, M: 4, L: 6 }[String((atForSize && atForSize.size) || '').toUpperCase()] || 3;
    const n = clampFanoutParts(oParts.val || sizeParts);
    if (!oParts.val) {
      console.log('  路由     ' + n + ' 路（' + (atForSize && atForSize.size ? '按任务体积 ' + atForSize.size : '没有体积信息，按默认 3') + '；--parts 可覆盖）');
    }

    // 试跑：只算不派。AI 想确认「会派几个、用什么模型、大概多久」时不该真花钱。
    if (dryRun) {
      const timeoutMs = Number(oTimeout.val) || 180000;
      console.log('试跑（不会派活、不会写盘）：');
      console.log('  机械闸门  ' + (noPreGateFlag ? '关（--no-pregate：不需要引证的题）' : '开（缺「文件:行」的产物不送父审，直接 REVISE）'));
      console.log('  子会话工具  ' + (oChildTools.val || (allowWrite ? 'Write,Edit,Read' : 'Read,Grep,Glob')) + (oChildTools.val || allowWrite ? '' : '（默认只读：派出去的子会话改不动仓库）'));
      console.log('  编队      ' + (noLanesFlag ? '单通道（--no-lanes）' : laneSpec ? laneSpec.join(' / ') + '（显式，按质量优先填）' : '自动（探测 codebuddy / codex / ollama，质量优先填、溢出到免费本地通道）'));
      console.log('  任务      ' + task);
      // takeOpt 的约定：没写这个参数 → null；写了但不带值（--split）→ ''。
      const drySplit = oSplit.val == null ? null : planSplit(task, { cwd: HERE, maxChunks: Number(oSplit.val) > 1 ? Math.floor(Number(oSplit.val)) : DEFAULT_MAX_CHUNKS });
      console.log('  长尾切分  ' + (oSplit.val == null ? '关（--split 开启）' : describeSplit(drySplit) + (drySplit.chunks && drySplit.chunks.length >= 2 ? ' → 实际派 ' + drySplit.chunks.length + ' 路' : '')));
      const drySplitScore = oSplit.val == null ? null : checkSplit(drySplit);
      if (drySplitScore) console.log('  切分质量  ' + renderSplitLine(drySplitScore).replace(/^▶ 切分：/, ''));
      console.log('  子会话    ' + (drySplit && drySplit.chunks && drySplit.chunks.length >= 2 ? drySplit.chunks.length : n) + ' 路（独立上下文，并发跑）');
      console.log('  子模型    ' + (oChild.val || '通道默认'));
      console.log('  父审模型  ' + (oReview.val || '通道默认'));
      console.log('  超时      ' + timeoutMs + 'ms / 路');
      console.log('  自愈      ' + (fixRounds ? fixRounds + ' 轮（被打回才重做）' : '关（判了 REVISE 也不重做）'));
      console.log('  父审权限  Read（只能读，改不了文件）');
      console.log('  预计      ' + Math.round((timeoutMs / 1000) * 0.25) + '–' + Math.round(timeoutMs / 1000 * 0.6) + 's（子会话取最慢那路 + 审查约 25s）');
      console.log('  编队上限  ' + clampFanoutParts(999) + ' 路（单通道拐点 ' + clampParts(999) + ' 路，超出溢出到免费本地通道）');
      console.log('');
      console.log('真要跑就去掉 --dry-run。');
      RESULT.data = { dryRun: true, task, taskFile: taskFromFile, parts: n, childModel: oChild.val || null, reviewModel: oReview.val || null, reviewLane: oReviewLane.val || null, timeoutMs, fixRounds, lanes: noLanesFlag ? null : 'auto', split: drySplitScore };
      return EXIT.ok;
    }
    const d = new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    const stamp = '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
    const dir = path.join(HERE, '.atw', 'fanout', stamp);
    // 先建目录再派活：--follow 与「往 notes.md 追加要求」都要在开跑前有个落点。
    fs.mkdirSync(dir, { recursive: true });
    const notesPath = path.join(dir, 'notes.md');
    // 说明文字全部塞进 HTML 注释：读取时剥掉，所以「没追加」= 空字符串，
    // 而不是把模板里的说明当成 6 行指令喂给父审（第一版就是这样，真跑才发现）。
    fs.writeFileSync(notesPath, [
      '<!-- 运行中追加的指令写在这个文件里，父审开始前会读一次。',
      '     任务：' + task,
      '     写法示例：child-2 引用了 orch.mjs 的那段不算证据。',
      '     注释里的内容不会进父审；另起一行直接写就会被读到。 -->',
      '',
    ].join('\n'), 'utf8');
    const onProgress = follow ? (e) => {
      if (e.phase === 'children-start') console.log('  → 派出 ' + e.n + ' 路（' + (e.plan || '') + '，独立上下文，等最慢那路）');
      else if (e.phase === 'child-done') console.log('  ✓ ' + e.id + (e.lane ? ' [' + e.lane + ']' : '') + ' ' + (e.elapsedMs / 1000).toFixed(1) + 's ' + String(e.chars) + ' 字');
      else if (e.phase === 'children-done') console.log('  → 子会话全部回来，开始父审（父审有 Read 权）');
      else if (e.phase === 'review-chunk-done') console.log('  ✓ 父审片 ' + e.done + '/' + e.total + '（' + (e.ids || []).join(',') + '）');
      else if (e.phase === 'pregate-all-revise') console.log('  → 机械闸门全判 REVISE（' + e.n + ' 份），不花父审的钱');
      else if (e.phase === 'notes') console.log('  → 吸收了 notes.md 的 ' + String(e.note || '').split('\n').length + ' 行追加指令');
      else if (e.phase === 'split') console.log('  → 长尾切分：' + e.desc + '，派 ' + e.chunks + ' 路');
      else if (e.phase === 'split-skip') console.log('  → 不切（' + e.reason + '），按原路数派');
    } : undefined;

    console.log('父会话派活：' + n + ' 个子会话（独立上下文）· 父只审不干' + (fixRounds ? ' · 被打回自动重做 ' + fixRounds + ' 轮' : ''));

    // 切分侧的闸门（2026-11-17，用户要求「任务分割与检查机制等价占比」）。
    // 检查侧判不过会拒收产物；切分侧判不过就不该起跑 —— 否则四路同改一个文件、
    // 或者有单元根本没人做，跑完再验收只是把浪费记账。
    const preSplit = oSplit.val == null ? null : planSplit(task, { cwd: HERE, maxChunks: Number(oSplit.val) > 1 ? Math.floor(Number(oSplit.val)) : DEFAULT_MAX_CHUNKS });
    const preScore = preSplit ? checkSplit(preSplit) : null;
    if (preScore) {
      console.log('  切分质量  ' + renderSplitLine(preScore).replace(/^▶ 切分：/, ''));
      if (preScore.verdict === 'bad') {
        const why = preScore.items.filter((i) => !i.ok && i.level === 'bad').map((i) => i.code).join('、');
        console.log('');
        console.log('✗ 切分不合格（' + why + '），没有起跑 —— 硬切下去要么两路同改一个文件，要么有单元没人做。');
        console.log('  要么去掉 --split 单路做，要么把任务写成几段互不重叠的再派。');
        RESULT.data = { refused: true, split: preScore };
        return EXIT.precondition;
      }
    }

    const res = await runFanout({
      task, parts: n, cwd: HERE,
      timeoutMs: Number(oTimeout.val) || 180000,
      reviewModel: oReview.val || undefined,
      reviewLane: oReviewLane.val || undefined,
      childModel: oChild.val || undefined,
      fixRounds,
      notesPath,
      onProgress,
      // 编队必须真的传下去：不传就是「算了半天还是单通道 8 路」，
      // 而 8 路单通道比 6 路更慢（实测 27.7s vs 7.18s）。
      autoLanes: noLanesFlag ? false : true,
      noPreGate: noPreGateFlag,
      split: oSplit.val == null ? 0 : (Number(oSplit.val) > 1 ? Math.floor(Number(oSplit.val)) : true),
      childTools: oChildTools.val || (allowWrite ? 'Write,Edit,Read' : undefined),
      lanes: laneSpec || undefined,
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
      task, taskFrom: taskFromActive ? 'active:' + taskFromActive : (taskFromFile || 'inline'),
      notesFile: path.relative(HERE, notesPath).replace(/\\/g, '/'),
      parts: res.parts, dir: path.relative(HERE, dir).replace(/\\/g, '/'),
      summary: s,
      children: res.children.map((c) => ({ id: c.id, ok: c.ok, elapsedMs: c.elapsedMs, malformed: !!c.malformed, answer: c.answer })),
      reviews: res.reviews,
      elapsed: res.elapsed,
      rounds: res.rounds ? res.rounds.map((r) => ({ round: r.round, summary: r.summary })) : [],
      split: preScore,
    };
    if (s.value === 1) return EXIT.ok;
    if (s.value === -1) return EXIT.accept;
    return EXIT.channel;
  };
}
