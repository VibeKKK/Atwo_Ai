// lib/accept-attest.mjs
// 把「验收通过」从一句声明变成一串可复算的证据。
// 每条 attestation 固定：哪个任务、哪个文件、当时多大、当时 sha256、验收退出码。
// 任何人拿到这条记录，都能对同一份文件重新算 digest —— 文件被动过，digest 就对不上。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const hashOf = (o) => sha256(JSON.stringify([o.task, o.file, o.digest, o.size, o.acceptExit]));

/**
 * 造一条验收凭证。
 * @param {{task:string, file:string, acceptExit:number, now?:Date|number|string}} spec
 */
export function makeAcceptAttestation({ task, file, acceptExit = 0, now = new Date() }) {
  if (!task || !file) throw new Error('makeAcceptAttestation: task 与 file 必填');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error('makeAcceptAttestation: 文件不存在 ' + file);
  const buf = fs.readFileSync(abs);

  let t = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(t.getTime())) t = new Date();

  const att = {
    v: 1,
    time: t.toISOString(),
    task,
    file: file.replace(/\\/g, '/'),
    size: buf.length,
    digest: sha256(buf),
    acceptExit: Number(acceptExit) | 0,
  };
  att.hash = hashOf(att);
  return att;
}

/** 追加一行 JSON 到凭证账本（目录不存在自动建）。 */
export function appendAttestation(ledger, att) {
  fs.mkdirSync(path.dirname(path.resolve(ledger)), { recursive: true });
  fs.appendFileSync(path.resolve(ledger), JSON.stringify(att) + '\n', 'utf8');
  return { ok: true, file: ledger, line: att.hash.slice(0, 12) };
}

/** 读账本；坏行跳过（一行垃圾不能拖垮整本账）。 */
export function readAttestations(ledger) {
  const abs = path.resolve(ledger);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const raw of fs.readFileSync(abs, 'utf8').split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    try { const o = JSON.parse(s); if (o && typeof o === 'object') out.push(o); } catch { /* skip */ }
  }
  return out;
}

/**
 * 三层校验：hash 自洽 → 文件还在 → 文件当前 digest 与当时一致。
 * @returns {{ok:boolean, reason:string, now:number|null}}
 */
export function verifyAcceptAttestation(att, { cwd = process.cwd() } = {}) {
  if (!att || typeof att !== 'object') return { ok: false, reason: 'not-an-attestation', now: null };
  for (const k of ['task', 'file', 'digest', 'size', 'acceptExit']) {
    if (att[k] === undefined || att[k] === null) return { ok: false, reason: 'field-missing:' + k, now: null };
  }
  if (att.hash !== hashOf(att)) return { ok: false, reason: 'hash-mismatch', now: null };

  const abs = path.resolve(cwd, att.file);
  if (!fs.existsSync(abs)) return { ok: false, reason: 'file-missing', now: null };
  const buf = fs.readFileSync(abs);
  if (buf.length !== att.size) return { ok: false, reason: 'size-changed', now: buf.length };
  if (sha256(buf) !== att.digest) return { ok: false, reason: 'content-changed', now: buf.length };
  return { ok: true, reason: 'ok', now: buf.length };
}

/** 一次验收多份文件：逐个造 + 落账，返回汇总。 */
export function attestFiles({ task, files = [], acceptExit = 0, ledger, now = new Date(), cwd = process.cwd() }) {
  const made = [];
  for (const f of files) {
    try {
      made.push(makeAcceptAttestation({ task, file: path.resolve(cwd, f), acceptExit, now }));
    } catch { /* 文件不在就跳过，不假装验过 */ }
  }
  let appended = 0;
  if (ledger) for (const a of made) { appendAttestation(ledger, a); appended++; }
  return { count: made.length, appended, items: made };
}

/**
 * 批量审计：逐条验，按任务归类。日常用法 = 改完代码后看哪些凭证失效了。
 * @param {object[]} entries
 * @returns {{ok:boolean, checked:number, failed:object[], byTask:object, stamp:string}}
 */
export function auditAttestations(entries = [], { cwd = process.cwd() } = {}) {
  const failed = [];
  const byTask = {};
  for (const e of entries) {
    const v = verifyAcceptAttestation(e, { cwd });
    const task = e && e.task ? e.task : "(无任务)";
    byTask[task] = byTask[task] || { total: 0, ok: 0, bad: 0 };
    byTask[task].total += 1;
    if (v.ok) byTask[task].ok += 1;
    else { byTask[task].bad += 1; failed.push({ task, file: e && e.file, reason: v.reason }); }
  }
  return { ok: failed.length === 0, checked: entries.length, failed, byTask, stamp: new Date().toISOString() };
}

/** 人话报告（三行 + 失败清单）。 */
export function formatAudit(res) {
  const lines = [];
  const bad = res.failed.length;
  lines.push(`凭证审计：共 ${res.checked} 份，通过 ${res.checked - bad}，失效 ${bad}`);
  const tasks = Object.keys(res.byTask || {});
  if (tasks.length) {
    lines.push("按任务：" + tasks.map((t) => {
      const x = res.byTask[t];
      return `${t} ${x.ok}/${x.total}` + (x.bad ? ` (失效 ${x.bad})` : "");
    }).join("  ·  "));
  }
  if (bad) {
    lines.push("失效清单：");
    for (const f of res.failed.slice(0, 20)) lines.push(`  ✗ ${f.file} —— ${f.reason}`);
    if (bad > 20) lines.push(`  … 另有 ${bad - 20} 条`);
  } else {
    lines.push("全部可复算：文件与记账时一致。");
  }
  return lines.join(String.fromCharCode(10));
}
