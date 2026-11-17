// 交接单：把「改了什么 / 为什么这么改 / 怎么验」从散文变成可校验的数据。
// 为什么非结构化不可：散文只有人能读，评审和验收只能凭感觉说「写得还行」；
// 定成对象之后，够不够格由 checkHandoff 判，人手写多漂亮都绕不过去。
// 全模块零依赖、零时间源：交接单要能被重放和逐字节比对，混进当前时间就再也对不上了。

const NL = String.fromCharCode(10);

function str(v) {
  return String(v == null ? '' : v).trim();
}

// files 允许两种写法混着来（['a.mjs'] 与 [{ path, change }]），因为写手手上有什么就写什么，
// 让调用方先统一格式等于把「交单」变成了「先学会格式」，最后大家还是会随手写字符串。
function normFiles(files) {
  if (!Array.isArray(files)) return [];
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const isObj = f !== null && typeof f === 'object';
    const p = str(isObj ? f.path : f);
    // 空路径没有意义：它渲染出来是一个只有项目符号的空行，读单的人会以为漏了一行。
    if (!p) continue;
    // 同一个文件重复出现只留第一条：后写的往往是补记，而「同一文件两条改动」在单上
    // 会让人以为改了两处，实际只有一处，评审会去追一个不存在的第二次改动。
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, change: isObj ? str(f.change) : '' });
  }
  return out;
}

export function makeHandoff({ task = '', by = '', files = [], why = '', verify = '', now = '' } = {}) {
  return {
    v: 1,
    task: str(task),
    by: str(by),
    files: normFiles(files),
    why: str(why),
    verify: str(verify),
    // time 只认入参：这个模块可能被拿去批量重放历史单，自己取当前时间会让重放结果漂移。
    time: str(now),
  };
}

export function renderHandoff(h) {
  const x = h && typeof h === 'object' ? h : {};
  const files = normFiles(x.files);
  const task = str(x.task) || '（未命名任务）';
  const by = str(x.by);
  const why = str(x.why) || '（未填）';
  const verify = str(x.verify) || '（未填）';

  const head = ['> 交接单：' + task];
  if (by) head.push('> 交付人：' + by);

  // 没有 change 就只留路径：破折号后面空着会像是渲染漏了字段，而「只改结构不动内容」
  // 这种改动本来就没有一句话可说，写死一个占位反而更难读。
  const filesBlock = files.length
    ? files.map((f) => (f.change ? '- ' + f.path + ' —— ' + f.change : '- ' + f.path)).join(NL)
    : '（没有文件变更）';

  // 三节之间空一行：markdown 里紧挨着的标题在渲染时会和上一节的最后一行黏成一坨。
  return [
    head.join(NL),
    '',
    '## 改了什么',
    filesBlock,
    '',
    '## 为什么',
    why,
    '',
    '## 怎么验',
    verify,
  ].join(NL);
}

export function checkHandoff(h) {
  const x = h && typeof h === 'object' ? h : {};
  const files = normFiles(x.files);
  const problems = [];
  // 顺序固定成 no-task → no-files → no-verify：problems 会被拼进日志与看板，
  // 顺序一乱，同一份单在不同轮次里比对就会出现假 diff。
  if (!str(x.task)) problems.push('no-task');
  if (!files.length) problems.push('no-files');
  if (!str(x.verify)) problems.push('no-verify');
  // no-task 只提示不拦：任务名可以事后补，而没有文件和没有验法这两条，交出来的东西没法验。
  return { ok: files.length >= 1 && !!str(x.verify), problems };
}
// 从一次派活的产物反推交接单：写手交的是散文 + EVIDENCE 行，评审要的是「改了哪些文件」这一层。
// 只从 EVIDENCE 里认文件路径，不从正文里认 —— 正文里出现的路径经常是「参考了某文件」，不是改动。
const FILE_RE = /([\w./-]+\.(?:mjs|js|cjs|ts|tsx|json|md|py|yml|yaml|html|css))(?::\d+)?/g;

export function handoffFromRun({ task = '', children = [], summary = '', now = '' } = {}) {
  const files = [];
  const by = [];
  for (const c of Array.isArray(children) ? children : []) {
    const ev = str(c && c.evidence);
    if (ev) {
      for (const m of ev.matchAll(FILE_RE)) files.push(m[1]);
    }
    const lane = str(c && c.lane);
    const label = str(c && c.chunkLabel);
    if (lane || label) by.push([label, lane].filter(Boolean).join(' / '));
  }
  // summary 里的「1 过 / 1 重做 / 0 没票」就是这一轮的验法结论，直接搬进「怎么验」：
  // 另起一套说法，两处一旦对不上，读单的人会以为有一处是过期的。
  return makeHandoff({ task, by: by.join('；'), files, why: '', verify: str(summary), now });
}
