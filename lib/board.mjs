// file: lib/board.mjs
// 一页人机共看的看板：把已经读好的数据（log/score/pitfalls/model-blocks 的投影）渲成静态 HTML。
// 为什么是纯函数：看板要能被回放、被快照、被测试逐字节比对 —— 一旦里面混进 Date.now 或读盘，
// 「同一份数据两次渲染结果不同」就再也说不清是数据变了还是渲染变了。

// 转义必须自己写、且必须转全五个：日志里的代码片段带 < 和 &，漏一个就把整页结构带塌。
// & 先转，否则后续替换出来的实体（&lt; 里的 &）会被二次转义成 &amp;lt;。
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 时长要和人眼看到的一致（毫秒 / 秒 / 分+秒三档），但这里不能 import lib/durfmt.mjs：
// 看板必须是零依赖的叶子模块，否则它会把整个 lib 依赖树拖进任何想用它的脚本。
function fmtMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return Math.floor(ms) + 'ms';
  if (ms < 60000) return (Math.floor(ms / 100) / 10).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m + 'm' + (s < 10 ? '0' + s : String(s)) + 's';
}

// 成功率：数据里既有 0–1 的小数也有 0–100 的百分数，两种写法都要认，不能因为口径不同就显示成 9500%。
function fmtRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '-';
  const pct = rate <= 1 ? rate * 100 : rate;
  return pct.toFixed(1) + '%';
}

const EMPTY = '<p class="empty">（暂无）</p>';

const STYLE = [
  '*{box-sizing:border-box}',
  'body{margin:0;background:#12151b;color:#e6e9ef;font:14px/1.5 -apple-system,"Segoe UI","Noto Sans SC",sans-serif;font-variant-numeric:tabular-nums}',
  '.wrap{max-width:1100px;margin:0 auto;padding:24px 20px 48px}',
  'h1{font-size:20px;margin:0 0 4px}',
  'h2{font-size:15px;margin:28px 0 10px;color:#b9c0cc;font-weight:600}',
  '.meta{color:#8b93a3;font-size:12px}',
  '.stats{display:flex;flex-wrap:wrap;gap:10px}',
  '.stat{background:#1a1f27;border:1px solid #262c37;border-radius:8px;padding:10px 14px;min-width:120px}',
  '.stat b{display:block;font-size:18px;font-variant-numeric:tabular-nums}',
  '.stat span{color:#8b93a3;font-size:12px}',
  '.scroll{overflow-x:auto;border:1px solid #262c37;border-radius:8px}',
  'table{border-collapse:collapse;width:100%;min-width:560px}',
  'th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #222833;white-space:nowrap}',
  'th{background:#171c24;color:#b9c0cc;font-weight:600;font-size:12px;letter-spacing:.02em}',
  'tbody tr:nth-child(even){background:#161b22}',
  'tbody tr:last-child td{border-bottom:0}',
  '.bad{background:#3a1d22;color:#ff8a8a}',
  '.warn{background:#3a3120;color:#ffd479}',
  'ul.pits{list-style:none;margin:0;padding:0}',
  'ul.pits li{background:#1a1f27;border:1px solid #262c37;border-radius:8px;padding:10px 14px;margin:0 0 8px}',
  'ul.pits li b{color:#ffb4b4}',
  '.fix{color:#9aa3b2;font-size:12px;margin-top:4px}',
  '.empty{color:#8b93a3;margin:0}',
  'footer{margin-top:32px;border-top:1px solid #262c37;padding-top:12px;color:#9aa3b2;font-size:12px}',
].join('');

function overview(runs) {
  if (!runs.length) return EMPTY;
  let ok = 0;
  const ms = [];
  for (const r of runs) {
    if (r && r.ok === true) ok += 1;
    if (r && typeof r.ms === 'number' && Number.isFinite(r.ms)) ms.push(r.ms);
  }
  // 失败按「总数减去成功」算：数据里 ok 缺省的情况不少，逐个判 ok === false 会漏计。
  const bad = runs.length - ok;
  const avg = ms.length ? fmtMs(ms.reduce((s, v) => s + v, 0) / ms.length) : '-';
  return '<div class="stats">'
    + '<div class="stat"><b>' + esc(runs.length) + '</b><span>执行次数</span></div>'
    + '<div class="stat"><b>' + esc(ok) + '</b><span>成功</span></div>'
    + '<div class="stat"><b>' + esc(bad) + '</b><span>失败</span></div>'
    + '<div class="stat"><b>' + esc(avg) + '</b><span>平均耗时</span></div>'
    + '</div>';
}

function lanesTable(lanes) {
  if (!lanes.length) return EMPTY;
  const head = '<tr><th>通道</th><th>判定数</th><th>成功率</th><th>平均耗时</th><th>状态</th></tr>';
  const body = lanes.map((l) => {
    const it = l || {};
    const blocked = !!it.blocked;
    const judged = typeof it.judged === 'number' && Number.isFinite(it.judged) ? it.judged : '-';
    return '<tr' + (blocked ? ' class="bad"' : '') + '>'
      + '<td>' + esc(it.agent || '-') + '</td>'
      + '<td>' + esc(judged) + '</td>'
      + '<td>' + esc(fmtRate(it.rate)) + '</td>'
      + '<td>' + esc(fmtMs(it.avgMs)) + '</td>'
      + '<td>' + (blocked ? '已拉黑' : '可用') + '</td>'
      + '</tr>';
  }).join('');
  return '<div class="scroll"><table><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

function pitfallsList(pitfalls) {
  const items = [];
  for (const p of pitfalls) {
    const it = p || {};
    // 缺字段就跳过该字段：宁可这一条只有一行字，也不要让 undefined 印在页面上。
    const parts = [];
    if (it.trigger != null && String(it.trigger) !== '') parts.push('<b>' + esc(it.trigger) + '</b>');
    if (it.lesson != null && String(it.lesson) !== '') parts.push('<div>' + esc(it.lesson) + '</div>');
    if (it.fix != null && String(it.fix) !== '') parts.push('<div class="fix">修法：' + esc(it.fix) + '</div>');
    if (parts.length) items.push('<li>' + parts.join('') + '</li>');
  }
  if (!items.length) return EMPTY;
  return '<ul class="pits">' + items.join('') + '</ul>';
}

function runsTable(runs) {
  if (!runs.length) return EMPTY;
  const head = '<tr><th>任务</th><th>判定</th><th>耗时</th><th>通道数</th></tr>';
  const body = runs.map((r) => {
    const it = r || {};
    const verdict = it.verdict == null || String(it.verdict) === '' ? '-' : String(it.verdict);
    const warn = /REVISE/i.test(verdict) ? ' class="warn"' : '';
    const laneCount = Array.isArray(it.lanes) ? it.lanes.length : '-';
    const task = it.desc != null && String(it.desc) !== '' ? it.desc : (it.id != null ? it.id : '-');
    return '<tr>'
      + '<td>' + esc(task) + '</td>'
      + '<td' + warn + '>' + esc(verdict) + '</td>'
      + '<td>' + esc(fmtMs(it.ms)) + '</td>'
      + '<td>' + esc(laneCount) + '</td>'
      + '</tr>';
  }).join('');
  return '<div class="scroll"><table><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

export function renderBoard({ generatedAt, runs = [], lanes = [], pitfalls = [], blocks = [], jobs = [], notes = '' } = {}) {
  const at = generatedAt == null || String(generatedAt) === '' ? '-' : String(generatedAt);
  const runsArr = Array.isArray(runs) ? runs : [];
  const lanesArr = Array.isArray(lanes) ? lanes : [];
  const pitArr = Array.isArray(pitfalls) ? pitfalls : [];
  const notesStr = notes == null ? '' : String(notes);
  // blocks / jobs 目前只进签名不进页面：调用方已经在读这两份数据，留位是为了不动它的调用点。
  void blocks;
  void jobs;
  const foot = notesStr.trim()
    ? '<footer>备注：' + esc(notesStr) + '</footer>'
    : '';
  return '<!doctype html>'
    + '<html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>atwo 看板</title><style>' + STYLE + '</style></head>'
    + '<body><main class="wrap">'
    + '<h1>atwo 看板</h1>'
    + '<div class="meta">生成时间：' + esc(at) + '</div>'
    + '<h2>概览</h2>' + overview(runsArr)
    + '<h2>通道</h2>' + lanesTable(lanesArr)
    + '<h2>坑</h2>' + pitfallsList(pitArr)
    + '<h2>任务</h2>' + runsTable(runsArr)
    + foot
    + '</main></body></html>';
}
