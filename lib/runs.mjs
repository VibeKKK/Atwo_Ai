// 长任务的「可观察 + 可叫停」最小件：runs/<id>/progress.log 记流水，STOP 旗标叫停。
// 为什么单独做一个叶子模块：go / fanout / army 三条长任务路径都得用同一套目录与旗标约定，
// 谁各自拼一次路径，迟早出现「A 写的日志 B 读不到、C 喊停 D 不认」这种只有现场才能发现的错位。
import fs from 'node:fs';
import path from 'node:path';

const MAX_ID = 60;
const DEFAULT_TAIL = 20;
const LOG_NAME = 'progress.log';
const STOP_NAME = 'STOP';

// 时间戳统一在内部生成：调用方传 Date 还是 ISO 串都行，非法值退回当前时间，
// 这样日志永远不会出现 [Invalid Date] 这种既不能排序也不能 grep 的前缀。
function isoOf(now) {
  if (now == null) return new Date().toISOString();
  const d = now instanceof Date ? now : new Date(now);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function textOf(v) {
  return v == null ? '' : String(v);
}

// id 会直接变成目录名，所以白名单比黑名单可靠：只留 [A-Za-z0-9._-]，其余一律换成 '-'。
// 点保留是必要的（.hidden、v1.2 这类 id 合法），但「整个名字全是点」在 path.join 里会被解析成
// 当前目录或上级目录 —— 那就是穿越，必须整段换掉，不能只是删几个字符了事。
export function sanitizeId(id) {
  // 先把连续两个以上的点压成一个 '-'：'../etc/passwd' 会先变成 '..-etc-passwd'，
  // 前缀里的 '..' 虽然已经不构成穿越（斜杠早被换成 '-'），但留在目录名里
  // 会让 ls / 日志 / 事后取证都无法一眼判断这是不是有人试图越界，压掉最省事。
  const s = textOf(id).replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.{2,}/g, '-');
  if (!s) return 'run';
  if (/^\.+$/.test(s)) return '-';
  return s.slice(0, MAX_ID);
}

export function runDir(root, id) {
  return path.join(textOf(root), 'runs', sanitizeId(id));
}

// 返回写入的整行（含 [ISO] 前缀，不含行尾换行），方便调用方直接打印或与 tailRunLog 的结果对比。
// 写失败返回空串而不是抛：日志是观察用的旁路，磁盘满了不该把正在跑的任务一起带走。
export function appendRunLog(dir, line, now) {
  const full = '[' + isoOf(now) + '] ' + textOf(line);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, LOG_NAME), full + '\n', 'utf8');
  } catch {
    return '';
  }
  return full;
}

// 文件末尾的换行会 split 出一个空串，算行数时它不是一行 —— 不剔掉，「最后 1 行」会返回空白。
export function tailRunLog(dir, n) {
  const want = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TAIL;
  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, LOG_NAME), 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-want);
}

// 旗标写普通文本而不是 JSON：人也会 cat 它，「为什么停」不该需要解析器才能看懂。
export function requestStop(dir, reason) {
  const why = textOf(reason);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, STOP_NAME), why, 'utf8');
  } catch {
    return '';
  }
  return why;
}

// STOP 是目录 / 权限不足 / 读出来是乱码，全都不等于「已叫停」：
// 这里宁可回 stop:false 让它继续跑，也不要因为读旗标抛异常把整个任务判死。
export function isStopRequested(dir) {
  try {
    return { stop: true, reason: fs.readFileSync(path.join(dir, STOP_NAME), 'utf8') };
  } catch {
    return { stop: false, reason: '' };
  }
}

// 返回是否真删到了：调用方靠它区分「刚撤掉旗标」和「本来就没有」。
export function clearStop(dir) {
  try {
    fs.unlinkSync(path.join(dir, STOP_NAME));
    return true;
  } catch {
    return false;
  }
}

// mtimeMs 取「目录 mtime」与「progress.log mtime」的较大值：追加日志不会改目录 mtime，
// 只看目录会把一个正在狂写日志的任务排在很早的位置，看板顺序就骗人了。
export function listRuns(root) {
  const base = path.join(textOf(root), 'runs');
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(base, e.name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    let lines = 0;
    try {
      const text = fs.readFileSync(path.join(dir, LOG_NAME), 'utf8');
      lines = text.split(/\r?\n/).filter((x) => x !== '').length;
      const logStat = fs.statSync(path.join(dir, LOG_NAME));
      if (logStat.mtimeMs > mtimeMs) mtimeMs = logStat.mtimeMs;
    } catch {
      lines = 0;
    }
    out.push({ id: e.name, dir, lines, stop: isStopRequested(dir).stop, mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
