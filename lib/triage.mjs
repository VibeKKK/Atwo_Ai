// file: lib/triage.mjs
// 分诊台：花 LLM 父审的钱之前，先让机械闸门把「一定不合格」的和「一定合格形式」的分出来。
//
// 为什么这是「融合」而不是又一个工具：
//   三值机（vm/）已经在判「该不该采信」；pregate 已经在判「证据形式够不够」。
//   两者此前只用在两个地方：判定结论、验收产物。而真花钱的动作 —— 把 6 份产物丢给 LLM 父审 ——
//   从来没人问「这 6 份里有没有几份根本不该花钱」。
//   实测一次父审单片固定成本约 50s（8 份 67.4s / 切 3 片 56–65s），
//   机械能判死的比例直接决定这部分钱花不花。
//
// 路由只有两条（不许出现「大概可以」这种第三态）：
//   reject —— 形式缺失或引用对不上，机械判死，不送 LLM（省一次调用）
//   review —— 机械层没抓到问题，才送 LLM 父审（这一份的钱必须花，因为机械判不了语义）
// 全部 reject 时整批可以机械结帐（settle-without-llm），一次 LLM 都不用付。
import fs from 'node:fs';
import path from 'node:path';
import { preGate, refMatchCheck, PRE } from './pregate.mjs';

export const ROUTE = { reject: 'reject', review: 'review' };

/** 从一段子产物文本里切出 ANSWER / EVIDENCE（与 lib/fanout.mjs 的 parseChildOutput 同口径，但不 import 它：避免循环）。 */
export function splitChild(raw) {
  const text = String(raw || '').replace(/\r/g, '');
  const a = text.search(/ANSWER\s*[:：]/i);
  const e = text.search(/EVIDENCE\s*[:：]/i);
  if (a >= 0 && e > a) {
    const ai = text.indexOf(text.slice(a).match(/[:：]/)[0], a) + 1;
    const ei = text.indexOf(text.slice(e).match(/[:：]/)[0], e) + 1;
    return { answer: text.slice(ai, e).trim(), evidence: text.slice(ei).trim(), malformed: false };
  }
  return { answer: text.trim(), evidence: '', malformed: true };
}

/** 读一个 fanout / army 产物目录里的 child-N.md。缺文件不报错，只少一项（目录是别人写的，别假设齐）。 */
export function readFanoutDir(dir) {
  const abs = path.resolve(String(dir || ''));
  if (!fs.existsSync(abs)) throw new Error('目录不存在：' + abs);
  const names = fs.readdirSync(abs).filter((f) => /^child-\d+\.md$/i.test(f))
    .sort((x, y) => Number(x.match(/(\d+)/)[1]) - Number(y.match(/(\d+)/)[1]));
  return names.map((f) => {
    const text = fs.readFileSync(path.join(abs, f), 'utf8');
    const parts = splitChild(text);
    return { id: f.replace(/\.md$/i, ''), file: f, chars: text.length, ...parts };
  });
}

/** 判一份产物的路由。返回 {id, route, reason, gates}。 */
export function triageOne(child, opts = {}) {
  const id = (child && child.id) || 'child-?';
  const g = preGate(child);
  if (g.verdict === PRE.revise) {
    return { id, route: ROUTE.reject, reason: g.reason, gates: ['pregate'] };
  }
  const r = refMatchCheck(child, opts);
  if (r.verdict === PRE.revise) {
    return { id, route: ROUTE.reject, reason: r.reason, gates: ['pregate', 'ref-match'] };
  }
  return { id, route: ROUTE.review, reason: '机械层没抓到问题，语义只能靠父审', gates: ['pregate', 'ref-match'] };
}

/**
 * 一整批的分诊。
 * @returns {{dir:string, items:Array, counts:{reject:number, review:number, total:number},
 *            llmCalls:number, savedCalls:number, verdict:'settle-without-llm'|'need-llm', detail:string}}
 */
export function planTriage(children, opts = {}) {
  const items = (children || []).map((c) => triageOne(c, opts));
  const reject = items.filter((i) => i.route === ROUTE.reject).length;
  const review = items.filter((i) => i.route === ROUTE.review).length;
  const counts = { reject, review, total: items.length };
  const result = {
    dir: opts.dir ? String(opts.dir) : null,
    items,
    counts,
    llmCalls: review,
    savedCalls: reject,
    verdict: review === 0 ? 'settle-without-llm' : 'need-llm',
    detail: '',
  };
  if (!items.length) { result.verdict = 'settle-without-llm'; result.detail = '没有产物：等于没什么可审的，别调父审'; }
  else if (review === 0) result.detail = '全部 ' + reject + ' 份都被机械判死：整批可以机械结帐，一次 LLM 都不花';
  else if (reject === 0) result.detail = '没有一份被机械判死：' + review + ' 份都要送父审（机械层判不了语义）';
  else result.detail = '省下 ' + reject + ' 次父审（' + reject + ' 份形式/引用不过），' + review + ' 份送父审';
  return result;
}

export function formatTriage(plan) {
  const L = [];
  L.push('分诊：' + plan.counts.total + ' 份 → 送审 ' + plan.counts.review + ' · 机械判死 ' + plan.counts.reject + '（' + plan.verdict + '）');
  L.push('  ' + plan.detail);
  for (const it of plan.items) {
    L.push('  ' + (it.route === ROUTE.reject ? '✗' : '→') + ' ' + it.id + '  ' + it.route + (it.reason ? '  —— ' + it.reason : ''));
  }
  if (plan.dir) L.push('  目录: ' + plan.dir);
  return L.join('\n');
}
