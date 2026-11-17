// 无人值守的第一块缺口：任务来源。
// 现在的流程是「我在对话里想起要派活 → 敲一条命令」。人一走开就停摆 ——
// 2026-11-17 夜跑失败就是因为它在等一条没人会敲的命令。
// 这块把任务源外移到文件系统：往 .atw/inbox 扔一个 *.task.json，drain 认领、执行、记账、归档。
import fs from 'node:fs';
import path from 'node:path';

export const INBOX_CONTRACT = 'atwo-inbox/1';
export const KINDS = ['patch', 'gate'];
export const SUFFIX = '.task.json';

export function inboxDir(cwd) {
  return path.join(path.resolve(cwd || process.cwd()), '.atw', 'inbox');
}

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// 只认 <名字>.task.json：.claimed.json / .result.json / done/ 里的都不算待办。
export function listInbox(cwd) {
  const dir = inboxDir(cwd);
  if (!fs.existsSync(dir)) return { ok: true, entries: [], reason: null };
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(SUFFIX)) continue;
    const file = path.join(dir, name);
    const id = name.slice(0, -SUFFIX.length);
    let spec;
    try { spec = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) { out.push({ id, file, ok: false, reason: 'bad-json: ' + (err && err.message) }); continue; }
    const kind = String(spec.kind || 'patch');
    if (!KINDS.includes(kind)) { out.push({ id, file, ok: false, reason: 'unknown-kind: ' + kind }); continue; }
    if (!String(spec.task || '').trim()) { out.push({ id, file, ok: false, reason: 'empty-task' }); continue; }
    out.push({ id, file, ok: true, spec: { ...spec, kind }, reason: null });
  }
  return { ok: true, entries: out, reason: null };
}

// 认领靠 rename：两个 drain 同时跑也只有一个能拿到（失败的一方收到 ENOENT 就跳过）。
export function claimTask(entry) {
  const target = entry.file.replace(/\.task\.json$/, '.claimed.json');
  try {
    fs.renameSync(entry.file, target);
    return { ok: true, file: target, reason: null };
  } catch (err) {
    return { ok: false, file: null, reason: 'claim-failed: ' + (err && err.code || err && err.message) };
  }
}

export function writeResult(cwd, id, result) {
  const dir = inboxDir(cwd);
  ensure(dir);
  const file = path.join(dir, id + '.result.json');
  fs.writeFileSync(file, JSON.stringify({ contract: INBOX_CONTRACT, id, at: new Date().toISOString(), ...result }, null, 2) + '\n', 'utf8');
  return file;
}

export function archive(cwd, id, ok) {
  const dir = inboxDir(cwd);
  const bucket = path.join(dir, ok ? 'done' : 'failed');
  ensure(bucket);
  // 归档时统一回 <id>.task.json：done/ 里躺着 <id>.claimed.json 会让人以为它还没干。
  for (const ext of ['.claimed.json', SUFFIX]) {
    const src = path.join(dir, id + ext);
    if (!fs.existsSync(src)) continue;
    try { fs.renameSync(src, path.join(bucket, id + SUFFIX)); } catch { /* 撞名就留在原地，别把结果弄丢 */ }
  }
  return bucket;
}

// handlers[kind](spec) 必须返回 {ok, detail, ...}；抛错按失败处理，绝不停掉整轮。
export async function drainOnce(opts = {}) {
  const started = Date.now();
  const cwd = path.resolve(opts.cwd || process.cwd());
  const limit = Math.max(1, Math.floor(Number(opts.limit) || 5));
  const handlers = opts.handlers || {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const listed = listInbox(cwd);
  const processed = [];
  const skipped = [];
  if (!listed.ok) return { contract: INBOX_CONTRACT, ok: false, processed, skipped, reason: listed.reason, elapsedMs: 0 };

  for (const entry of listed.entries) {
    if (processed.length >= limit) break;
    if (!entry.ok) {
      // 坏任务文件不能静默留着：每轮都读它、每轮都失败，最后没人知道它坏在哪。
      writeResult(cwd, entry.id, { ok: false, reason: entry.reason });
      archive(cwd, entry.id, false);
      skipped.push({ id: entry.id, reason: entry.reason });
      log({ phase: 'invalid', id: entry.id, reason: entry.reason });
      continue;
    }
    const got = claimTask(entry);
    if (!got.ok) { skipped.push({ id: entry.id, reason: got.reason }); continue; }
    const kind = entry.spec.kind;
    const handler = handlers[kind];
    const t0 = Date.now();
    let out;
    if (typeof handler !== 'function') {
      out = { ok: false, reason: 'no-handler: ' + kind };
    } else {
      try { out = await handler(entry.spec, { cwd, id: entry.id }); }
      catch (err) { out = { ok: false, reason: 'exception: ' + (err && err.message) }; }
    }
    const ok = !!(out && out.ok);
    writeResult(cwd, entry.id, { kind, ok, reason: out && out.reason || null, elapsedMs: Date.now() - t0, detail: out });
    archive(cwd, entry.id, ok);
    processed.push({ id: entry.id, kind, ok, reason: out && out.reason || null, elapsedMs: Date.now() - t0, detail: out });
    log({ phase: 'done', id: entry.id, kind, ok });
  }

  return {
    contract: INBOX_CONTRACT,
    ok: processed.every((p) => p.ok),
    processed,
    skipped,
    remaining: Math.max(0, listed.entries.length - processed.length - skipped.length),
    elapsedMs: Date.now() - started,
  };
}

export function formatDrain(r) {
  if (!r) return '（没有结果）';
  const L = [];
  if (!r.processed.length && !r.skipped.length) return '收件箱是空的（没有 *.task.json）';
  for (const p of r.processed) {
    const head = `${p.ok ? '✓' : '✗'} ${p.id} [${p.kind}] ${(p.elapsedMs / 1000).toFixed(1)}s`;
    L.push(p.ok ? head : head + ' —— ' + (p.reason || '失败'));
    if (p.ok && p.detail && Array.isArray(p.detail.patchPaths)) {
      for (const f of p.detail.patchPaths) L.push('    patch：' + f);
    }
  }
  for (const s of r.skipped) L.push(`· ${s.id} 跳过 —— ${s.reason}`);
  L.push(`合计 ${(r.elapsedMs / 1000).toFixed(1)}s · 剩 ${r.remaining} 条`);
  return L.join('\n');
}