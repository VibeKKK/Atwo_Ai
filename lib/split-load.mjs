// lib/split-load.mjs —— 切分的「负载」与「耦合」两把尺子（2026-11-17）
//
// 为什么单独一个文件而不是塞进 lib/split.mjs：
//  · split.mjs 里有别人正在动的 checkSplit（七条判据），同一份文件的写冲突比多一个文件贵得多。
//  · 这里的两条判据是靠**读盘**得出的（文件字节数、import 边），而 split.mjs 的七条是纯函数。
//    「不读盘的判据」与「读盘的判据」混在一起，纯函数这一侧就再也测不动了。
//
// 补的是什么：
//  · 负载：原 planSplit 按「单元个数」轮分，一个 200 行的 mjs 与一个 1400 行的 mjs 算一个单元。
//    实测 53 个 lib/*.mjs 里最大与最小差 40 倍 —— 按个数均衡，慢的那片依然拖住整批。
//  · 耦合：a.mjs import b.mjs 被切到两片时，两路子会话会各自去读对方的文件、各自给一份结论，
//    合并时出现两个互相矛盾的「同一件事」。这是切分唯一会造成**错误**的副作用，
//    不只是慢。所以它必须能被机器数出来。
import fs from 'node:fs';
import path from 'node:path';

/** 片间字节负载比上限（最大片 / 最小片）。比个数比宽一点：字节均衡不该为了一两 KB 反复搬。 */
export const MAX_LOAD_RATIO = 2.5;
/** 只读前 1MB 抓 import：一张 20MB 的文件不该把切分规划拖成 IO 任务。 */
const READ_LIMIT = 1024 * 1024;
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

const rel = (p, cwd) => {
  try { return path.relative(cwd, p).replace(/\\/g, '/'); } catch { return p; }
};

/** 单元字节数。不存在或不可读记 0（不存在本身已被 detectUnits 挡掉）。 */
export function unitBytes(unit, cwd = process.cwd()) {
  const abs = unit && (unit.abs || path.resolve(cwd, String(unit.unit || '')));
  try { return fs.statSync(abs).size; } catch { return 0; }
}

export function loadOfChunk(chunk, cwd = process.cwd()) {
  const units = (chunk && Array.isArray(chunk.units)) ? chunk.units : [];
  return units.reduce((s, u) => s + unitBytes(u, cwd), 0);
}

/**
 * 按字节把单元重新分配到固定片数里（LPT：大的先放，放给当前最轻的片）。
 * 片数不变 —— 片数由 planSplit 的规则决定（min(maxChunks, floor(units/2))），
 * 这里只改「谁去哪片」。label 与 index 保持原规则，mergeParts 靠 label 对齐分片。
 */
export function rebalanceByLoad(plan, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  if (!plan || !Array.isArray(plan.chunks) || plan.chunks.length < 2) return plan;
  const count = plan.chunks.length;
  const sized = (plan.units || []).map((u) => ({ u, bytes: unitBytes(u, cwd) }));
  if (!sized.length) return plan;
  sized.sort((a, b) => b.bytes - a.bytes || String(a.u.unit).localeCompare(String(b.u.unit)));
  const bins = Array.from({ length: count }, (_, i) => ({ index: i, units: [], bytes: 0 }));
  for (const it of sized) {
    let target = bins[0];
    for (const b of bins) if (b.bytes < target.bytes) target = b;
    target.units.push(it.u);
    target.bytes += it.bytes;
  }
  const chunks = bins.map((b) => ({ index: b.index, total: count, units: b.units, label: 'chunk-' + (b.index + 1) + '/' + count }));
  return {
    ...plan,
    chunks,
    strategy: 'units-by-load',
    balance: {
      before: plan.chunks.map((c) => loadOfChunk(c, cwd)),
      after: bins.map((b) => b.bytes),
    },
  };
}

function readHead(abs) {
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(READ_LIMIT);
    const n = fs.readSync(fd, buf, 0, READ_LIMIT, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
}

/** 单元之间的直接 import 边（只算「两边都是本次单元」的那些边）。 */
export function importEdges(units, cwd = process.cwd()) {
  const abs = new Map();
  for (const u of units || []) {
    const a = path.resolve(cwd, u.abs || u.unit || '');
    abs.set(a, u);
  }
  const edges = [];
  for (const [a, u] of abs) {
    const text = readHead(a);
    if (!text) continue;
    const dir = path.dirname(a);
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = path.resolve(dir, m[1]);
      const hit = [target, target + '.mjs', target + '.js', target + '.cjs', path.join(target, 'index.mjs')].find((t) => abs.has(t));
      if (hit && hit !== a) edges.push({ from: u.unit, to: abs.get(hit).unit });
    }
  }
  return edges;
}

/** 跨片边：同一对单元落进两片，就是「两路会互相读对方的东西」。 */
export function crossChunkEdges(plan, cwd = process.cwd()) {
  const chunks = (plan && Array.isArray(plan.chunks)) ? plan.chunks : [];
  const where = new Map();
  chunks.forEach((c, ci) => (c.units || []).forEach((u) => where.set(u.unit, ci)));
  const edges = importEdges(plan && plan.units, cwd);
  const cross = edges.filter((e) => where.has(e.from) && where.has(e.to) && where.get(e.from) !== where.get(e.to));
  return { total: edges.length, cross, where };
}

const LOAD_LABEL = { 'load-balanced': '负载均衡', coupling: '耦合隔离', 'load-covered': '负载明细完整' };

/**
 * 两条读盘判据。软硬分档与 split.mjs 的约定一致：
 *  · load-balanced 软项 —— 负载差 2.5 倍以上只是慢，不是错；降级 weak，不拒收。
 *  · coupling 软项 —— 跨片 import 会让两路互相读，但父审可以发现矛盾，所以也不判死。
 * 两个都只降级不拒绝：切分的错要人来定，机器只能报警。
 */
export function checkLoad(plan, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const maxRatio = Number(opts.maxLoadRatio) > 0 ? Number(opts.maxLoadRatio) : MAX_LOAD_RATIO;
  const items = [];
  const chunks = (plan && Array.isArray(plan.chunks)) ? plan.chunks : [];
  if (chunks.length < 2) {
    return { items: [{ code: 'load-balanced', ok: true, detail: '未切分', level: 'ok' }], verdict: 'skip', load: { min: 0, max: 0, ratio: null }, coupling: { total: 0, cross: [] } };
  }
  const loads = chunks.map((c) => loadOfChunk(c, cwd));
  const nonEmpty = loads.filter((n) => n > 0);
  const min = nonEmpty.length ? Math.min(...nonEmpty) : 0;
  const max = loads.length ? Math.max(...loads) : 0;
  const ratio = min > 0 ? max / min : Infinity;
  items.push({
    code: 'load-balanced',
    ok: Number.isFinite(ratio) && ratio <= maxRatio,
    detail: '最大/最小 = ' + (Number.isFinite(ratio) ? ratio.toFixed(2) + '×' : '∞') + '（上限 ' + maxRatio + '×）',
    level: (Number.isFinite(ratio) && ratio <= maxRatio) ? 'ok' : 'weak',
  });
  const cpl = crossChunkEdges(plan, cwd);
  items.push({
    code: 'coupling',
    ok: cpl.cross.length === 0,
    detail: '跨片引用 ' + cpl.cross.length + ' / 共 ' + cpl.total + ' 条' + (cpl.cross.length ? '（' + cpl.cross.slice(0, 3).map((e) => e.from + '→' + e.to).join('、') + (cpl.cross.length > 3 ? '…' : '') + '）' : ''),
    level: cpl.cross.length === 0 ? 'ok' : 'weak',
  });
  // 「负载明细完整」：某片 0 字节说明单元 stat 全失败（路径错了），这时均衡数字没有意义。
  items.push({
    code: 'load-covered',
    ok: loads.every((n) => n > 0),
    detail: '零字节片 ' + loads.filter((n) => n === 0).length + ' 个',
    level: loads.every((n) => n > 0) ? 'ok' : 'weak',
  });
  const weak = items.filter((i) => !i.ok && i.level === 'weak').length;
  const bad = items.filter((i) => !i.ok && i.level === 'bad').length;
  return {
    items,
    verdict: bad ? 'bad' : weak ? 'weak' : 'ok',
    load: { min, max, ratio: Number.isFinite(ratio) ? ratio : null, bytes: loads },
    coupling: cpl,
  };
}

export function renderLoadLine(result) {
  if (!result || !Array.isArray(result.items)) return '▶ 负载：（没有切分计划）';
  if (result.verdict === 'skip') return '▶ 负载：不切，无需判';
  const parts = result.items.map((i) => {
    const name = LOAD_LABEL[i.code] || i.code;
    if (!i.ok) return name + ' ✗ ' + i.detail;
    if (i.code === 'load-balanced') {
      const m = /=\s*([\d.]+×|∞)/.exec(i.detail);
      return name + (m ? ' ' + m[1] : '') + ' ✓';
    }
    return name + ' ✓';
  });
  return '▶ 负载：' + result.load.bytes.map((b, i) => (b / 1024).toFixed(0) + 'KB').join(' / ') + '（' + parts.join(' · ') + '）';
}
