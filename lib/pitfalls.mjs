// 坑账本：把「踩过的坑 + 修法」落成可匹配的数据，派活前按任务文本自动提示。
// 目的只有一个：同一个坑不要修第二遍（这是 AI 最容易犯的浪费）。
// 纯函数 + 文件读写都可注入路径，不读环境变量、不 spawn。
import fs from 'node:fs';
import path from 'node:path';

export const PITFALL_KIND = 'pitfall';

function nowIso(now) {
  if (!now) return new Date().toISOString();
  const d = now instanceof Date ? now : new Date(now);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function str(v) {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
}

/** 一条坑记录。trigger 是能被任务文本命中的短语；lesson 是现象；fix 是修法。 */
export function pitfallRecord({ trigger, lesson, fix, now } = {}) {
  const t = str(trigger);
  const l = str(lesson);
  if (!t) throw new Error('坑必须给 trigger（能被任务文本命中的短语）');
  if (!l) throw new Error('坑必须给 lesson（现象是什么）');
  return { kind: PITFALL_KIND, time: nowIso(now), trigger: t, lesson: l, fix: str(fix) };
}

export function appendPitfall(file, rec) {
  if (!file) throw new Error('appendPitfall 需要账本路径');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

/** 读账本；坏行直接跳过（账本是证据，不是数据库，一行坏不该毁掉全部）。 */
export function readPitfalls(file) {
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (!r || r.kind !== PITFALL_KIND) continue;
      if (!str(r.trigger) || !str(r.lesson)) continue;
      out.push({ kind: PITFALL_KIND, time: str(r.time), trigger: str(r.trigger), lesson: str(r.lesson), fix: str(r.fix) });
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** 同一个 trigger 只留最后一次（后来的修法优先），再把命中项按 trigger 长度降序（越具体越靠前）。 */
export function matchPitfalls(records, text) {
  const list = Array.isArray(records) ? records : [];
  const hay = String(text || '').toLowerCase();
  if (!hay) return [];
  const latest = new Map();
  for (const r of list) {
    const key = str(r.trigger).toLowerCase();
    if (!key) continue;
    latest.set(key, r);   // 后者覆盖前者：账本按时间追加，最后一条就是最新结论
  }
  const hit = [];
  for (const r of latest.values()) {
    const key = str(r.trigger).toLowerCase();
    if (hay.includes(key)) hit.push(r);
  }
  hit.sort((a, b) => str(b.trigger).length - str(a.trigger).length);
  return hit;
}

/** 渲染成给人看的三行以内；没命中就是空数组，调用方自己决定要不要打「0 条」。 */
export function renderPitfalls(matched, { max = 3 } = {}) {
  const list = Array.isArray(matched) ? matched.slice(0, Math.max(1, max)) : [];
  return list.map((r, i) => {
    const head = (i === 0 ? '⚠ 头号坑：' : '⚠ 相关坑：') + r.trigger;
    const body = ' —— ' + r.lesson;
    const tail = r.fix ? '；修法：' + r.fix : '';
    return head + body + tail;
  });
}
