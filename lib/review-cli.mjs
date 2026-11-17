// atwo review —— 对已有的 fanout 目录补做一次父审，可以排进队列用 GUI 通道慢慢跑。
//
// 为什么需要它：GUI 通道（trae/workbuddy/doubao）单窗口独占、一次 28–190s，放在前台会把整条流水线拖住。
// 有它就能「先收产物、立刻继续干活」，把父审当后台作业交给 supervisor（或 atwo pool）去做。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseChildOutput, buildReviewPrompt, parseReview, VERDICT } from './fanout.mjs';
import { preGateAll, collectRefs } from './pregate.mjs';

/** GUI 通道常不吐 JSON，但会用中文写「child-1 可以收 / child-2 退回」——先宽松捞一遍。 */
export function parseReviewLoose(text, ids) {
  const out = [];
  const s = String(text || '');
  const seen = new Set();
  for (const id of ids) {
    const n = String(id).replace(/^child-/, '');
    const re = new RegExp('(?:' + id + '|child[\\s#-]*' + n + '|第\\s*' + n + '\\s*份)[^\\n]{0,120}?(PASS|ACCEPT|通过|可以收|没问题|REVISE|退回|打回|重做|不能收)', 'i');
    const m = s.match(re);
    if (!m) continue;
    const v = /^(?:PASS|ACCEPT|通过|可以收|没问题)$/i.test(m[1]) ? VERDICT.pass : VERDICT.revise;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, verdict: v, reason: '（从正文里捞出来的，非 JSON 契约）：' + s.slice(Math.max(0, m.index), m.index + 120).replace(/\s+/g, ' '), loose: true });
  }
  return out;
}

/** 从一个 fanout 目录里读回所有 child-*.md（按 id 排序），解析成父审需要的形状。 */
export function readChildren(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return { ok: false, reason: 'no-dir: ' + abs, children: [] };
  const ids = fs.readdirSync(abs)
    .filter((n) => /^child-\d+\.md$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  if (!ids.length) return { ok: false, reason: 'no-child-artifacts', children: [] };
  const children = ids.map((n) => {
    const o = parseChildOutput(fs.readFileSync(path.join(abs, n), 'utf8'));
    return { id: n.replace(/\.md$/, ''), answer: o.answer, evidence: o.evidence, raw: n };
  });
  return { ok: true, children, dir: abs };
}

/** 纯逻辑：拿现成产物跑一遍机械闸门 + 父审，返回票与要落盘的内容。ask 可注入（测试用）。 */
export async function reviewDir(dir, { ask, cwd, task = '', note = null, timeoutMs = 300000, perCall = 0 } = {}) {
  const read = readChildren(dir);
  if (!read.ok) return { ok: false, reason: read.reason, votes: [] };
  if (typeof ask !== 'function') return { ok: false, reason: 'no-ask', votes: [] };
  const rawDir = path.resolve('.'); // 引用核对用当前仓库
  const kids = read.children.map((c) => ({ id: c.id, answer: c.answer, evidence: c.evidence }));
  const mech = preGateAll(kids, { cwd: cwd || rawDir });
  const mechVotes = (mech.reviews || []).filter((r) => r && r.verdict && r.verdict !== VERDICT.none);
  // 全被判死了就别调父审（省钱也省时间），但这件事必须说出来 —— 原先只说「父审没回内容」，
  // 让人以为 GUI 通道哑了（2026-11-17 实测：两份都被机械闸门判 REVISE，父审根本没被调用）。
  const skippedLlm = mechVotes.length === read.children.length;
  const already = new Set(mechVotes.map((r) => r.id));
  const need = kids.filter((k) => !already.has(k.id));
  let llmVotes = [];
  let reviewed = 0;
  let rawText = '';
  if (need.length) {
    // 一次送几份？默认全送（CLI 通道一次能吃多份，省一次往返）。GUI 通道一份一送：
    // workbuddy 送两份时 303 秒零回答（2026-11-17 实测），送一份 22 秒就回。
    const size = perCall > 0 ? perCall : need.length;
    const chunks = [];
    for (let i = 0; i < need.length; i += size) chunks.push(need.slice(i, i + size));
    const raws = [];
    for (const slice of chunks) {
      const refsText = collectRefs(slice, { cwd: cwd || rawDir }).text;
      const prompt = buildReviewPrompt(task || '（补审：原始任务没写在目录里）', slice, note, refsText);
      let r = null;
      let errMsg = '';
      try {
        r = await ask(prompt, { timeoutMs });
      } catch (e) {
        errMsg = '（调用失败：' + ((e && e.message) || e) + '）';
      }
      const text = String((r && (r.text || r.out || r.addedText)) || errMsg || '');
      let got = parseReview(text, slice.map((k) => k.id));
      // 严格解析「解出了票但全是 unreviewed」也算没解出来 —— 否则宽松解析永远不会被尝试
      // （GUI 通道常见：答了一大段中文，JSON 契约一个字都没给）。
      const decisive = got.filter((v) => v.verdict && v.verdict !== 'unreviewed');
      if (!decisive.length && text.trim()) {
        const loose = parseReviewLoose(text, slice.map((k) => k.id));
        if (loose.length) got = loose;
      }
      llmVotes.push(...got);
      raws.push('### 第 ' + (chunks.indexOf(slice) + 1) + '/' + chunks.length + ' 片（' + slice.map((k) => k.id).join(',') + '）\n' + text);
    }
    reviewed = llmVotes.length;
    rawText = raws.join('\n\n');
  }
  const votes = [...mechVotes, ...llmVotes];
  const body = votes.map((v) => '- ' + v.id + '  ' + v.verdict + (v.reason ? ' —— ' + v.reason : '')).join('\n');
  return {
    ok: true,
    votes,
    mechCount: mechVotes.length,
    llmCount: llmVotes.length,
    skippedLlm,
    rawText,
    digest: createHash('sha256').update(JSON.stringify(votes)).digest('hex').slice(0, 16),
    markdown: '# 异步父审\n\n机械闸门 ' + mechVotes.length + ' 票 · 父审 ' + llmVotes.length + ' 票（' + reviewed + '/' + need.length + '）\n\n' + body + '\n',
  };
}

export function makeReviewVerb({ EXIT, RESULT, HERE, die, resolveAsk }) {
  return async function cmdReview(argv) {
    const opt = (n) => {
      const i = argv.indexOf(n);
      if (i < 0) return null;
      const v = argv[i + 1];
      return v && !String(v).startsWith('--') ? v : '';
    };
    const dir = opt('--dir') || opt('--fanout');
    if (!dir) die('用法：atwo review --dir .atw/fanout/<时间戳> [--lane workbuddy] [--task "原任务"]', EXIT.usage);
    const lane = opt('--lane') || 'codebuddy';
    const task = opt('--task') || '';
    const timeoutMs = Number(opt('--timeout')) || 300000;
    let ask;
    try {
      ask = resolveAsk(lane);
    } catch (e) {
      die('这个通道用不了：' + (e && e.message), EXIT.channel);
    }
    // GUI 通道（trae/workbuddy/doubao）一份一送：多份提示它们答不出来（实测 workbuddy 303s 零回答）。
    let perCall = 0;
    let laneIsGui = false;
    try {
      const { LANE_DEFS } = await import('./lanes.mjs');
      const def = LANE_DEFS[lane];
      if (def && def.kind === 'gui') { perCall = 1; laneIsGui = true; }
    } catch { /* lanes 不可用时按 CLI 处理 */ }
    const r = await reviewDir(dir, { ask, cwd: HERE, task, timeoutMs, perCall });
    if (!r.ok) die('补审没做成：' + r.reason, EXIT.precondition);
    const outMd = path.join(path.resolve(dir), 'REVIEW-ASYNC.md');
    // GUI 通道的文件工具读的是它自己的工作区，不是本仓库：2026-11-17 实测 workbuddy 的
    // 理由是「Read(lib/split.mjs) = File does not exist.、ls -la 仅有 . 与 ..、find 全树无文件」。
    // 那是它核不了，不是产物错 —— 这句话必须跟结论一起落盘，否则读报告的人会把「核不了」当「抓到了」。
    const guiNote = laneIsGui
      ? '> 注意：' + lane + ' 是 GUI 通道，它的 Read/Grep 在它自己的工作区里跑，读不到本仓库。\n'
        + '> 所以「文件不存在 / ls 只有 . 与 .. / find 全树无文件」只能算「核不了」，不是「产物错」。\n'
        + '> 要核引文真实性：用 CLI 通道（codebuddy，cwd=仓库）或机械闸门。\n\n'
      : '';
    fs.writeFileSync(outMd, guiNote + r.markdown, 'utf8');
    fs.writeFileSync(path.join(path.resolve(dir), 'REVIEW-ASYNC.json'), JSON.stringify({ lane, digest: r.digest, votes: r.votes }, null, 2) + '\n', 'utf8');
    // 父审原文必须落盘：workbuddy/glm 那类通道经常「答了但没按契约」，不存原文就只剩「0 票」这个现象，
    // 事后分不清是没给票、解析丢票、还是调用失败（2026-11-17 实测踩过）。
    if (r.rawText) fs.writeFileSync(path.join(path.resolve(dir), 'REVIEW-ASYNC-RAW.md'), '# 父审原文（' + lane + '，' + r.rawText.length + ' 字）\n\n' + r.rawText + '\n', 'utf8');
    RESULT.data = { lane, digest: r.digest, votes: r.votes, mech: r.mechCount, llm: r.llmCount, wrote: outMd };
    console.log('补审完成（' + lane + '）· 机械 ' + r.mechCount + ' 票 · 父审 ' + r.llmCount + ' 票' + (r.rawText ? '（原文 ' + r.rawText.length + ' 字已落盘 REVIEW-ASYNC-RAW.md）' : (r.skippedLlm ? '（机械闸门已全判，父审没被调用）' : '（父审没回内容）')));
    for (const v of r.votes) console.log('  ' + v.id + '  ' + v.verdict + (v.reason ? ' —— ' + String(v.reason).slice(0, 120) : ''));
    console.log('写入：' + outMd);
    return r.votes.some((v) => v.verdict === VERDICT.revise) ? EXIT.accept : EXIT.ok;
  };
}