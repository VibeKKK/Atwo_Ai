// file: lib/triage-cli.mjs
// atwo triage：分诊台动词。只读产物目录、不派活、不花模型钱。
//
// 用法：
//   atwo triage                 # 最近一批 fanout / army 产物
//   atwo triage --dir <目录>     # 指定产物目录（child-N.md）
//   atwo triage --json
//
// 退出码：0 = 分诊完成（不管路由结论是什么，这是事实报告不是闸门）。
import fs from 'node:fs';
import path from 'node:path';
import { readFanoutDir, planTriage, formatTriage } from './triage.mjs';
import { takeOpt } from './fanout-cli.mjs';

/** 最近一批产物目录：先看 .atw/fanout，再看 .atw/army，取 mtime 最新的一个。 */
function latestArtifactDir(HERE) {
  const bases = [path.join(HERE, '.atw', 'fanout'), path.join(HERE, '.atw', 'army')];
  const cands = [];
  for (const b of bases) {
    if (!fs.existsSync(b)) continue;
    for (const name of fs.readdirSync(b)) {
      const d = path.join(b, name);
      try {
        if (!fs.statSync(d).isDirectory()) continue;
        if (!fs.readdirSync(d).some((f) => /^child-\d+\.md$/i.test(f))) continue;
        cands.push({ dir: d, mtime: fs.statSync(d).mtimeMs });
      } catch { /* 读不了就当没有 */ }
    }
  }
  cands.sort((x, y) => y.mtime - x.mtime);
  return cands.length ? cands[0].dir : null;
}

export function makeTriageVerb(ctx) {
  const { EXIT, RESULT, HERE, die } = ctx;
  return async function cmdTriage(args) {
    const oDir = takeOpt(args, '--dir');
    let dir = String(oDir.val || '').trim();
    if (!dir) {
      const latest = latestArtifactDir(HERE);
      if (!latest) {
        return die([
          '没有可分诊的产物：.atw/fanout 与 .atw/army 下都没有 child-N.md',
          '',
          '  （这次没有派活，也没有花钱。先 atwo fanout / army 真跑一批，或用 --dir 指一个目录。）',
        ].join('\n'), EXIT.precondition);
      }
      dir = latest;
    }
    const abs = path.resolve(HERE, dir);
    if (!fs.existsSync(abs)) return die('目录不存在：' + abs, EXIT.precondition);
    const kids = readFanoutDir(abs);
    const plan = planTriage(kids, { cwd: HERE, dir: abs.replace(/\\/g, '/') });
    RESULT.data = plan;
    if (RESULT.quiet) return EXIT.ok;
    console.log(formatTriage(plan));
    if (plan.verdict === 'settle-without-llm') console.log('\n  整批可以机械结帐：不必调父审（省 ' + plan.counts.total + ' 次 LLM 调用）。');
    else console.log('\n  要送父审的 ' + plan.llmCalls + ' 份才是这轮真正要花的钱。');
    return EXIT.ok;
  };
}
