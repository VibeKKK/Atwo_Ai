// lib/fanout-cli.mjs —— atwo 的 fanout 动词本体。放在这里而不是 atwo.mjs 里，
// 是因为 atwo.mjs 已经 1100 行，再塞一个动词会让「谁改了哪」越来越难查。
import path from 'node:path';
import fs from 'node:fs';
import { clampFanoutParts, clampParts, pickReviewLane, runFanout, finishFanout } from './fanout-run.mjs';
import { resolveAsk } from './lanes.mjs';
import { DEFAULT_MAX_CHUNKS, describeSplit, planSplit, checkSplit, renderSplitLine } from './split.mjs';
import { shouldDelegate } from './should.mjs';
import { rebalanceByLoad, checkLoad, renderLoadLine } from './split-load.mjs';
import { pruneLanes } from './outcome.mjs';

const pad2 = (v) => (v === 'PASS' ? 'PASS  ' : v === 'REVISE' ? 'REVISE' : 'unrevd');

// 分片数不该超过「真能同时干活的通道数」：切 4 片却只有 1 路可用，
// 四片会串行排队，墙钟反而更长（2026-11-17 实测：8 lane 挤 2 通道，墙钟 360s）。
function effectiveLaneCount(HERE, laneSpec) {
  if (Array.isArray(laneSpec) && laneSpec.length) {
    // 显式编队：按每路 slots 求和（--lanes codebuddy:4,ollama:4 → 8）
    let n = 0;
    for (const x of laneSpec) n += Number(x && x.count) || 1;
    return n;
  }
  try {
    const ledger = path.join(HERE, 'memory', 'log.jsonl');
    const rows = fs.readFileSync(ledger, 'utf8').split(/\r?\n/).filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const lanes = ['codebuddy', 'trae', 'workbuddy', 'doubao'];
    const kept = pruneLanes(rows, lanes).kept;
    return Math.max(1, kept.length);
  } catch { return 0; }  // 读不到账本就当「不知道」，不要瞎限制
}
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
    // 评审分级（2026-11-17 方向讨论里子会话排的第一优先）：评审是 army/fanout 里最贵的一段，
    // 实测 codebuddy 父审 76–120s，而 deepseek-v4.1-flash 在金标准 6 题上同分、19.5s。
    // cheap = 换便宜模型；high = 每片只放 1 份（逐份对引文，最慢最严）；std = 现状。
    const oReviewTier = takeOpt(a, '--review-tier'); a = oReviewTier.rest;
    const oReviewChunk = takeOpt(a, '--review-chunk'); a = oReviewChunk.rest;
    const REVIEW_TIERS = { cheap: 'deepseek-v4.1-flash', std: null, high: null };
    const reviewTier = oReviewTier.val == null ? 'std' : String(oReviewTier.val || '').trim();
    if (!Object.prototype.hasOwnProperty.call(REVIEW_TIERS, reviewTier)) {
      return die('不派活：--review-tier 只能是 cheap / std / high，收到「' + reviewTier + '」。（这次没有派出任何子会话，也没有写盘。）', EXIT.usage);
    }
    const tierModel = REVIEW_TIERS[reviewTier];
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
    // 执行面（2026-11-17）：子会话能跑白名单命令，跑在影子副本里；产物声称的 RUN 由机械层重跑核对。
    const allowRun = a.includes('--allow-run');
    // should 原来是个孤立动词（全仓只有 atwo.mjs 一个调用方），等于「判该不该派」这件事没人执行。
    // 这里在派活前真问一次：判 self 就拒跑，并给出它命中的判据。
    // 已知这类活已经实测负收益（「一条 grep 就能扫完」的活 67→110s），所以默认拦。
    const forceShould = a.includes('--force-should');
    a = a.filter((x) => x !== '--force-should');
    const noLanesFlag = a.includes('--no-lanes');
    const noPreGateFlag = a.includes('--no-pregate');
    // 投机重发（2026-11-17）：机械闸门判死的产物当场带理由重发一次，不等父审。
    // --no-resend 关掉它（离线/省钱/想看清原始产物时用）。
    const noResendFlag = a.includes('--no-resend');
    // 开关位必须在 join 成任务文本之前抠掉 —— 这一条踩过三次（--help / --dry-run / --no-pregate）：
    // 漏掉任何一个是把开关名当任务内容发给子会话，而且输出里看不出区别。
    a = a.filter((x) => x !== '--no-lanes' && x !== '--allow-write' && x !== '--no-pregate' && x !== '--no-resend' && x !== '--allow-run');
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
    }
    if (!task) return die('--task-file 指向的文件是空的：' + taskFromFile, EXIT.usage);
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

    // should 原来是个孤立动词（全仓只有 atwo.mjs 一个调用方），等于「判该不该派」这件事没人执行。
    // 这里在派活前真问一次：判 self 就拒跑，并给出它命中的判据。
    // 已知这类活已经实测负收益（「一条 grep 就能扫完」的活 67→110s），所以默认拦。
    if (!dryRun && !forceShould) {
      const sv = shouldDelegate(task, { parts: n });
      if (sv && sv.verdict === 'self') {
        console.log('  不该派：' + (sv.why || '（没有理由）'));
        console.log('  真要对: 加 --force-should。');
        RESULT.data = { refusedBy: 'should', verdict: sv.verdict, score: sv.score, signals: sv.signals, why: sv.why };
        return EXIT.precondition;
      }
    }
    if (!oParts.val) {
      console.log('  路由     ' + n + ' 路（' + (atForSize && atForSize.size ? '按任务体积 ' + atForSize.size : '没有体积信息，按默认 3') + '；--parts 可覆盖）');
    }

    // 试跑：只算不派。AI 想确认「会派几个、用什么模型、大概多久」时不该真花钱。
    if (dryRun) {
      const timeoutMs = Number(oTimeout.val) || 180000;
      console.log('试跑（不会派活、不会写盘）：');
      console.log('  机械闸门  ' + (noPreGateFlag ? '关（--no-pregate：不需要引证的题）' : '开（缺「文件:行」的产物不送父审，直接 REVISE）'));
      console.log('  子会话工具  ' + (oChildTools.val || (allowRun ? 'Read,Grep,Glob,Bash' : (allowWrite ? 'Write,Edit,Read' : 'Read,Grep,Glob'))) + (oChildTools.val || allowWrite || allowRun ? '' : '（默认只读：派出去的子会话改不动仓库）'));
      console.log('  执行面    ' + (allowRun ? '开（--allow-run：影子副本里可跑 node --check / node test/<文件> / node vm/smoke.mjs / atwo gate，声称的 RUN 会被重跑核对）' : '关（默认：全系统只读文本，跑不起来的东西看不见）'));
      console.log('  编队      ' + (noLanesFlag ? '单通道（--no-lanes）' : laneSpec ? laneSpec.join(' / ') + '（显式，按质量优先填）' : '自动（探测 codebuddy / codex / ollama，质量优先填、溢出到免费本地通道）'));
      console.log('  任务      ' + task);
      // takeOpt 的约定：没写这个参数 → null；写了但不带值（--split）→ ''。
      // 分片数封顶到「有效路数」：切得比通道多只会排队（--lanes 显式或账本可用路数）
      const laneCap = effectiveLaneCount(HERE, laneSpec);
      const wantChunks = Number(oSplit.val) > 1 ? Math.floor(Number(oSplit.val)) : DEFAULT_MAX_CHUNKS;
      const dryChunks = laneCap > 0 ? Math.min(wantChunks, Math.max(2, laneCap)) : wantChunks;
      const drySplit = oSplit.val == null ? null : planSplit(task, { cwd: HERE, maxChunks: dryChunks });
      console.log('  长尾切分  ' + (oSplit.val == null ? '关（--split 开启）' : describeSplit(drySplit) + (drySplit.chunks && drySplit.chunks.length >= 2 ? ' → 实际派 ' + drySplit.chunks.length + ' 路' : '')));
      const drySplitScore = oSplit.val == null ? null : checkSplit(drySplit);
      if (drySplitScore) console.log('  切分质量  ' + renderSplitLine(drySplitScore).replace(/^▶ 切分：/, ''));
      console.log('  子会话    ' + (drySplit && drySplit.chunks && drySplit.chunks.length >= 2 ? drySplit.chunks.length : n) + ' 路（独立上下文，并发跑）');
      console.log('  子模型    ' + (oChild.val || '通道默认'));
      console.log('  父审模型  ' + (oReview.val || tierModel || '通道默认') + (reviewTier === 'std' ? '' : '（--review-tier ' + reviewTier + '）'));
      console.log('  超时      ' + timeoutMs + 'ms / 路');
      console.log('  自愈      ' + (fixRounds ? fixRounds + ' 轮（被打回才重做）' : '关（判了 REVISE 也不重做）'));
      console.log('  投机重发  ' + (noResendFlag ? '关（--no-resend）' : '开（机械闸门判死的当场重发一次，不等父审）'));
      // 父审通道必须试跑就看得到：真跑的标签由 lib/fanout-run.mjs 定，
      // 试跑若只说「父审模型 通道默认」，等于让「这次会不会是自审」留到跑完才知道。
      if (oReviewLane.val) {
        console.log('  父审通道  ' + oReviewLane.val + '（--review-lane 显式指定；起不来就报错，不会悄悄换人）');
      } else {
        const dryMain = (Array.isArray(laneSpec) && laneSpec.length) ? laneSpec.map((x) => (x && x.lane) || x).filter(Boolean).slice(0, 1) : ['codebuddy'];
        const dryWanted = pickReviewLane(HERE, { avoid: dryMain });
        let dryOk = true;
        try { resolveAsk(dryWanted); } catch { dryOk = false; }
        const dryHetero = !dryMain.includes(dryWanted);
        console.log('  父审通道  ' + dryWanted + (dryOk ? '' : '（台账里有这个名字但解析不了，真跑会退回主力并标同源）') + ' · ' + (dryHetero ? '异源（已避开主力 ' + dryMain.join('/') + '）' : '同源 —— 台账里没有第二条可用通道，自审只能抓矛盾与硬错'));
      }
      console.log('  父审权限  Read（只能读，改不了文件）');
      console.log('  预计      ' + Math.round((timeoutMs / 1000) * 0.25) + '–' + Math.round(timeoutMs / 1000 * 0.6) + 's（子会话取最慢那路 + 审查约 25s）');
      console.log('  编队上限  ' + clampFanoutParts(999) + ' 路（单通道拐点 ' + clampParts(999) + ' 路，超出溢出到免费本地通道）');
      console.log('');
      console.log('真要跑就去掉 --dry-run。');
      RESULT.data = { dryRun: true, allowRun, task, taskFile: taskFromFile, parts: n, reviewTier, childModel: oChild.val || null, reviewModel: oReview.val || tierModel || null, reviewLane: oReviewLane.val || null, timeoutMs, fixRounds, lanes: noLanesFlag ? null : 'auto', split: drySplitScore };
      return EXIT.ok;
    }
    const d = new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    const stamp = '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
    // 目录名只精确到秒：两个 fanout 在同一秒起跑会撞进同一个目录（2026-11-17 01:14
    // 实证：方向讨论与 workbuddy 父审同时开跑，notes.md 被后者覆盖，child-N.md 互相覆盖）。
    // 用 mkdirSync 非递归当占位锁：抢到就用，抢不到就往后加 -2/-3，撞十次就带 pid 兜底。
    // 干净 clone 里 .atw/fanout 不存在（运行时目录被 ignore），非递归 mkdir 会 ENOENT
    // 而不是 EEXIST —— 必须先建父目录，否则首次 fanout 直接崩（2026-11-17 干净检出实证）。
    fs.mkdirSync(path.join(HERE, '.atw', 'fanout'), { recursive: true });
    let dir = path.join(HERE, '.atw', 'fanout', stamp);
    for (let i = 2; i <= 12; i += 1) {
      try { fs.mkdirSync(dir, { recursive: false }); break; } catch (e) {
        if (e && e.code !== 'EEXIST') throw e;
        dir = path.join(HERE, '.atw', 'fanout', stamp + '-' + i);
      }
    }
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
      else if (e.phase === 'speculative-resend') console.log('  ↻ ' + e.id + ' 机械闸门判死（' + String(e.reason || '').replace(/^机械闸门：/, '') + '），不等父审当场重发');
      else if (e.phase === 'notes') console.log('  → 吸收了 notes.md 的 ' + String(e.note || '').split('\n').length + ' 行追加指令');
      else if (e.phase === 'split') console.log('  → 长尾切分：' + e.desc + '，派 ' + e.chunks + ' 路');
      else if (e.phase === 'split-skip') console.log('  → 不切（' + e.reason + '），按原路数派');
    } : undefined;

    console.log('父会话派活：' + n + ' 个子会话（独立上下文）· 父只审不干' + (fixRounds ? ' · 被打回自动重做 ' + fixRounds + ' 轮' : ''));

    // 切分侧的闸门（2026-11-17，用户要求「任务分割与检查机制等价占比」）。
    // 检查侧判不过会拒收产物；切分侧判不过就不该起跑 —— 否则四路同改一个文件、
    // 或者有单元根本没人做，跑完再验收只是把浪费记账。
    const laneCap2 = effectiveLaneCount(HERE, laneSpec);
    const wantChunks2 = Number(oSplit.val) > 1 ? Math.floor(Number(oSplit.val)) : DEFAULT_MAX_CHUNKS;
    const preChunks = laneCap2 > 0 ? Math.min(wantChunks2, Math.max(2, laneCap2)) : wantChunks2;
    const preSplit = oSplit.val == null ? null : planSplit(task, { cwd: HERE, maxChunks: preChunks });
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

    // 负载侧的尺子（2026-11-17 第二轮）：片数由 planSplit 定，但「谁去哪片」决定实测墙钟。
    // 实测 6 个真文件轮分 41/23/14KB（2.84×，超上限）→ LPT 后 28/24/26KB（1.18×）。
    // 这里只做排序层面的改写，片数与 label 不变，mergeParts 的对齐规则不受影响。
    let balancedPlan = preSplit;
    if (preSplit && preSplit.chunks && preSplit.chunks.length >= 2) {
      balancedPlan = rebalanceByLoad(preSplit, { cwd: HERE });
      const loadScore = checkLoad(balancedPlan, { cwd: HERE });
      console.log('  负载质量  ' + renderLoadLine(loadScore).replace(/^▶ 负载：/, ''));
      if (loadScore.verdict === 'weak') {
        const why = loadScore.items.filter((i) => !i.ok).map((i) => i.code + '（' + i.detail + '）').join('、');
        console.log('  ⚠ 切分可用但不算均匀：' + why + ' —— 照跑，只是慢的那一路会拖住整批。');
      }
    }

    // 编队失败（通道角色不匹配、codex app-server 起不来…）以前是未捕获异常：栈 + exit 1。
    // 对外只有一个数——退出码。5 = 通道问题，3 = 前置条件不满足，调用方只看这个数就该知道该修环境还是该改任务。
    let res;
    try {
      res = await runFanout({
      task, parts: n, cwd: HERE,
      splitPlan: balancedPlan && balancedPlan.chunks && balancedPlan.chunks.length >= 2 ? balancedPlan : undefined,
      // 两段式：先各交一句计划、互相看见再动手。默认关 —— 多一轮模型调用，只在显式要的时候花。
      twoPhase: process.argv.includes('--two-phase') || process.env.ATWO_TWO_PHASE === '1',
      // 长任务按体量放宽子会话超时：固定 180s 对「读一份 3KB 简报再写判断」不够
      // （2026-11-17 实测：同一份简报，一路 145s 交卷、另两路一个撞回合、一个 180s 被掐）。
      // 只放宽子会话，不放宽父审：父审慢是通道脾气问题，不是任务体量问题。
      timeoutMs: Number(oTimeout.val) || Math.min(300000, Math.max(180000, 60000 + String(task || '').length * 50)),
      reviewModel: oReview.val || tierModel || undefined,
      reviewChunk: oReviewChunk.val != null ? Number(oReviewChunk.val) : (reviewTier === 'high' ? 1 : undefined),
      reviewLane: oReviewLane.val || undefined,
      childModel: oChild.val || undefined,
      fixRounds,
      notesPath,
      onProgress,
      // 编队必须真的传下去：不传就是「算了半天还是单通道 8 路」，
      // 而 8 路单通道比 6 路更慢（实测 27.7s vs 7.18s）。
      autoLanes: noLanesFlag ? false : true,
      noPreGate: noPreGateFlag,
      // 默认开投机重发：机械红是可判定的失败，等父审 14–20s 再判 REVISE 再重做只是排队。
      speculativeResend: !noResendFlag,
      split: oSplit.val == null ? 0 : (Number(oSplit.val) > 1 ? Math.floor(Number(oSplit.val)) : true),
      childTools: oChildTools.val || (allowRun ? 'Read,Grep,Glob,Bash' : (allowWrite ? 'Write,Edit,Read' : undefined)),
      allowRun,
      lanes: laneSpec || undefined,
      });
    } catch (e) {
      // 编队/通道层的错必须落成退出码，不许把栈甩给调用方（5 = 通道问题）。
      console.log('✗ 没派成：' + ((e && e.message) || e));
      RESULT.data = { error: String((e && e.message) || e) };
      return EXIT.channel;
    }
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
    // 结论已经有了，就别让通道的子进程把进程吊住：2026-11-17 实测 workbuddy 当父审
    // 等了 303s 才判失败，之后进程又挂了 134s 才退（child-1..3 的票其实早就定了）。
    // 用 unref 的定时器兜底：不延长进程寿命，但有别的句柄挂着时 2s 后强制收工，
    // 让「跑完了」这件事在日志里真的可见。
    const code = s.value === 1 ? EXIT.ok : (s.value === -1 ? EXIT.accept : EXIT.channel);
    setTimeout(() => process.exit(code), 2000).unref();
    return code;
  };
}