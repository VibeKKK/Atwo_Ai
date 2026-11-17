// atwo tail / atwo stop 两个动词的实现。
// 为什么单独成文件而不是塞进 atwo.mjs：atwo.mjs 已经 1700+ 行，往里加动词必踩「注册了忘规格」
// 与「改一行冲突一整块」两个老坑；这里做纯工厂，atwo.mjs 只加三行接线。
import path from 'node:path';
import { runDir, tailRunLog, isStopRequested, requestStop, clearStop, listRuns } from './runs.mjs';

function takeOpt(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return '';
  const v = args[i + 1];
  return v && !String(v).startsWith('-') ? String(v) : '';
}

function runsRoot(cwd) {
  return process.env.ATWO_RUNS || path.join(cwd, '.atw');
}

// atwo tail <id> [-n 40]：看某次跑到哪了。没有 id 时列出最近几次。
export function makeTailVerb({ cwd, EXIT }) {
  return function tailVerb(args = [], RESULT = { data: {} }) {
    const root = runsRoot(cwd);
    const nRaw = takeOpt(args, '-n');
    const n = Number(nRaw) > 0 ? Number(nRaw) : 40;
    let id = '';
    for (let i = 0; i < args.length; i += 1) {
      const a = String(args[i]);
      if (a === '-n') { i += 1; continue; }
      if (!a.startsWith('-')) { id = a; break; }
    }
    if (!id) {
      const runs = listRuns(root);
      const print = (s) => console.log(s);
      if (!runs.length) print('还没有任何 run 目录（长任务跑起来后才有）');
      else {
        print('最近的 run：');
        for (const r of runs) print('  ' + (r.stop ? '⛔ ' : '   ') + r.id + '  ' + r.lines + ' 行  ' + r.dir);
        print('');
        print('看细节：atwo tail <id> -n 40');
      }
      RESULT.data.tail = { id: '', runs };
      return EXIT.ok;
    }
    const dir = runDir(root, id);
    const lines = tailRunLog(dir, n);
    const stop = isStopRequested(dir);
    console.log('run：' + dir);
    console.log(stop.stop ? '状态：已收到 STOP（' + (stop.reason || '无原因') + '）' : '状态：进行中（没有 STOP 旗标）');
    if (!lines.length) console.log('（还没有日志行）');
    else for (const l of lines) console.log('  ' + l);
    RESULT.data.tail = { id, dir, lines, stop: stop.stop, reason: stop.reason };
    return EXIT.ok;
  };
}

// atwo stop <id>：往 run 目录写 STOP 旗标。不是杀进程 —— 杀进程会让落盘/记账半途而废，
// 旗标由长任务自己在两次派发之间查一次，能收尾才收尾。
export function makeStopVerb({ cwd, EXIT }) {
  return function stopVerb(args = [], RESULT = { data: {} }) {
    const root = runsRoot(cwd);
    const reason = takeOpt(args, '--reason');
    const clear = args.includes('--clear');
    let id = '';
    for (let i = 0; i < args.length; i += 1) {
      const a = String(args[i]);
      if (a === '--reason') { i += 1; continue; }
      if (!a.startsWith('-')) { id = a; break; }
    }
    if (!id) {
      console.error('用法：atwo stop <run-id> [--reason 「为什么停」] [--clear]');
      return EXIT.usage;
    }
    const dir = runDir(root, id);
    if (clear) {
      const removed = clearStop(dir);
      console.log(removed ? '已清掉 STOP：' + dir : '本来就没有 STOP：' + dir);
      RESULT.data.stop = { id, dir, cleared: removed };
      return EXIT.ok;
    }
    const reasonText = requestStop(dir, reason); // 返回写进去的原因串（空串=写失败），不是布尔
    const wrote = !!reasonText;
    if (!wrote) {
      console.error('写 STOP 失败（目录不可写？）：' + dir);
      return EXIT.precondition;
    }
    console.log('已请求停止：' + dir);
    console.log('  理由：' + (reasonText || '（未写）'));
    console.log('  注意：长任务在「下一次派发前」才会看到它，不会立刻掐断正在跑的那个子会话。');
    RESULT.data.stop = { id, dir, reason, wrote };
    return EXIT.ok;
  };
}
