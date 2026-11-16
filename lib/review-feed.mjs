// file: lib/review-feed.mjs
// 目的：把 reviews/ 目录里散落的评审文件读成「票」，供 done 闸门做三态裁决。
// 为什么要单独一层：atwo.mjs 里原先一处都没读 reviews/（grep 0 命中），
// 评审结果只躺在文件里没人消费；而票面解析（文件名规则、去重、同批评审合并视图）
// 是最容易被写错的一段，抽成纯函数才好测。
//
// 文件名规则（按实际样本反推，不要用 split('-') 取段）：
//   <reviewer>-review-<subject>-YYYYMMDD-HHMMSS.md
//   multi-review-<subject>-YYYYMMDD-HHMMSS.md
//   trae-review-trae.mjs.md                 （没有时间戳的旧样本）
// subject 自己可能带点、带扩展名，所以只能「剥两端」而不是按分隔符切。

import fs from 'node:fs';
import path from 'node:path';

export const VOTE = { accept: 'ACCEPT', revise: 'REVISE', none: 'unreviewed' };

/** 从文件名解析出 reviewer / subject / 时间戳。解析不出来返回 null（宁可不计票，也不瞎计）。 */
export function parseReviewName(name) {
  if (!/\.md$/i.test(name)) return null;
  let base = name.slice(0, -3); // 去掉 .md
  let tsMs = null;

  // 末尾可能是 -YYYYMMDD-HHMMSS
  const m = base.match(/^(.*)-(\d{8})-(\d{6})$/);
  if (m) {
    base = m[1];
    const y = m[2].slice(0, 4);
    const mo = m[2].slice(4, 6);
    const d = m[2].slice(6, 8);
    const hh = m[3].slice(0, 2);
    const mi = m[3].slice(2, 4);
    const ss = m[3].slice(4, 6);
    const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss)).getTime();
    if (Number.isFinite(t)) tsMs = t;
  }

  // 开头必须是 <reviewer>-review-
  const head = base.match(/^([A-Za-z][\w.]*)-review-(.+)$/);
  if (!head) return null;
  const reviewer = head[1].toLowerCase();
  let subject = head[2];

  // 旧样本 trae-review-trae.mjs.md → subject 会多一个 ".md"，剥掉一层
  subject = subject.replace(/\.md$/i, '') || subject;

  return { reviewer, subject, tsMs, multi: reviewer === 'multi' };
}

/** 正文里的裁决。只认显式标记，认不出就是 unreviewed（不猜）。 */
export function voteFromText(text) {
  const s = String(text || '');
  const v = s.match(/VERDICT\s*[:：]\s*(ACCEPT|REVISE|UNREVIEWED|unreviewed|accept|revise)/);
  if (v) {
    const t = v[1].toUpperCase();
    if (t === 'ACCEPT') return VOTE.accept;
    if (t === 'REVISE') return VOTE.revise;
    return VOTE.none;
  }
  const c = s.match(/裁决\s*[:：]\s*(ACCEPT|REVISE|通过|需改|不通过)/);
  if (c) {
    const t = c[1].toUpperCase();
    if (t === 'ACCEPT' || t === '通过') return VOTE.accept;
    if (t === 'REVISE' || t === '需改' || t === '不通过') return VOTE.revise;
  }
  return VOTE.none;
}

/**
 * 读目录，产出票面。
 * @param {{dir?:string, subjects?:string[], sinceMs?:number, expectedReviewers?:string[]}} opt
 * @returns {{votes:Array, sources:Array, missing:Array, bySubject:Object, counts:Object}}
 */
export function discoverVotes(opt = {}) {
  const dir = opt.dir;
  const subjects = Array.isArray(opt.subjects) && opt.subjects.length ? new Set(opt.subjects) : null;
  const sinceMs = Number.isFinite(opt.sinceMs) ? opt.sinceMs : null;
  const out = { votes: [], sources: [], missing: [], bySubject: {}, counts: { ACCEPT: 0, REVISE: 0, unreviewed: 0 } };
  if (!dir || !fs.existsSync(dir)) return out;

  const rows = [];
  for (const name of fs.readdirSync(dir)) {
    const meta = parseReviewName(name);
    if (!meta) continue;
    if (subjects && !subjects.has(meta.subject)) continue;
    if (sinceMs != null && meta.tsMs != null && meta.tsMs < sinceMs) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    rows.push({ ...meta, file: name, vote: voteFromText(text) });
  }

  // 同一批的合并视图（multi）只在没有具体评审者覆盖同一 subject+时间 时计一票，
  // 否则一次评审会被算成两票 —— 那正是「同值复制冒充独立证据」在票面上的翻版。
  const specific = new Set(rows.filter((r) => !r.multi).map((r) => r.subject + '|' + (r.tsMs ?? 'x')));
  const kept = rows.filter((r) => !(r.multi && specific.has(r.subject + '|' + (r.tsMs ?? 'x'))));

  // 同一 (subject, reviewer) 只留最新一份
  const latest = new Map();
  for (const r of kept) {
    const k = r.subject + '|' + r.reviewer;
    const prev = latest.get(k);
    if (!prev || (r.tsMs || 0) >= (prev.tsMs || 0)) latest.set(k, r);
  }

  out.votes = [...latest.values()].sort((a, b) => (a.subject === b.subject
    ? (a.reviewer < b.reviewer ? -1 : 1) : (a.subject < b.subject ? -1 : 1)));
  const seen = new Set();
  for (const r of rows) seen.add(r.reviewer);
  out.sources = [...seen].sort();
  for (const v of out.votes) {
    out.counts[v.vote] = (out.counts[v.vote] || 0) + 1;
    (out.bySubject[v.subject] = out.bySubject[v.subject] || []).push({ reviewer: v.reviewer, vote: v.vote, file: v.file });
  }
  if (Array.isArray(opt.expectedReviewers)) {
    const have = new Set(out.votes.map((v) => v.reviewer));
    out.missing = opt.expectedReviewers.filter((r) => !have.has(r));
  }
  return out;
}
