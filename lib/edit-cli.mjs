// lib/edit-cli.mjs —— atwo edit 的壳。
//
// 关键设计：指令从文件读（--spec），不从命令行读。
// 命令行读就回到「shell 引号 + 转义」的老坑，那正是这个动词要消灭的东西。

import fs from 'node:fs';
import path from 'node:path';
import { runEdits, validateSpec, formatEdit, logEdits } from './edit-ops.mjs';

const NL = String.fromCharCode(10);

export function makeEditVerb({ EXIT, RESULT, HERE, die }) {
  return async function cmdEdit(args) {
    let specPath = null;
    let dryRun = false;
    let check = true;
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a === '--spec') { specPath = args[i + 1] || null; i += 1; }
      else if (a === '--dry-run') dryRun = true;
      else if (a === '--no-check') check = false;
    }
    if (!specPath) {
      return die([
        '用法：atwo edit --spec <指令.json> [--dry-run] [--no-check]',
        '',
        '指令格式：{"ops":[{"file":"lib/x.mjs","find":"旧文本","replace":"新文本"},',
        '                      {"file":"lib/x.mjs","anchor":"标记行","insert":"插入内容","where":"after"}]}',
        '',
        '为什么走文件：命令行要过 shell 引号与转义 —— 那正是这个动词要消灭的错误来源。',
      ].join(NL), EXIT.usage);
    }
    const abs = path.resolve(process.cwd(), specPath);
    if (!fs.existsSync(abs)) return die('没有这个指令文件：' + specPath, EXIT.usage);
    let spec;
    try {
      spec = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      return die('指令文件不是合法 JSON：' + String((e && e.message) || e).slice(0, 200), EXIT.usage);
    }
    const v = validateSpec(spec);
    if (!v.ok) return die('指令没通过校验：' + v.reason + '（一个字节都没写）', EXIT.usage);

    const r = runEdits(spec, { cwd: HERE, dryRun, check });
    RESULT.data.edit = r;
    console.log(formatEdit(r));
    if (!r.ok) return EXIT.accept;
    if (!dryRun) {
      const log = logEdits(HERE, r, { by: process.env.COLLAB_ME || null });
      if (log) console.log('  记账：' + path.relative(HERE, log) + '（atwo commit 靠它认领 hunk）');
    }
    return EXIT.ok;
  };
}