// 无人值守的第一块缺口：任务来源。
// 现在的流程是「我在对话里想起要派活 → 敲一条命令」。人一走开就停摆 ——
// 2026-11-17 夜跑失败就是因为它在等一条没人会敲的命令。
// 这块把任务源外移到文件系统：往 .atw/inbox 扔一个 *.task.json，drain 认领、执行、记账、归档。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const INBOX_CONTRACT = 'atwo-inbox/1';
export const KINDS = ['patch', 'gate'];
export const SUFFIX = '.task.json';
// 同一 id 连续失败到这个数，就降级成「只出报告、不改代码」。
// 理由是实测出来的：模型改不出能过验收的东西时会一遍遍改同一处，
// 无人值守下这等于无限重试 —— 而人不在场，没人会拦住它。
export const MAX_ATTEMPTS = 2;

export function inboxDir(cwd) {
  return path.join(path.resolve(cwd || process.cwd()), '.atw', 'inbox');
}

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// 归档改名用：ISO 时间去到分钟，撞名再加 -1/-2。
// 第一版 slice(0,15) 只截到「时+分的第一位」，同一分钟投两次会互相覆盖。
function compactStamp(iso) {
  return String(iso || new Date().toISOString()).replace(/[:.]/g, '').replace(/Z$/, '').slice(0, 13);
}

function freeName(dir, base) {
  let cand = base;
  let n = 0;
  while (fs.existsSync(path.join(dir, cand))) { n += 1; cand = base + '-' + n; }
  return cand;
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
    // gate 不需要任务文本（它就是「跑一遍闸门」），只有 patch 必须说清要改什么。
    // 2026-11-18 00:04 真跑常驻时抓到：{"kind":"gate"} 被判 empty-task，收件箱等于废掉一半。
    if (kind === 'patch' && !String(spec.task || '').trim()) { out.push({ id, file, ok: false, reason: 'empty-task' }); continue; }
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

// 任务的机械指纹：同一个 id 换了任务内容，旧失败就不该继续算在它头上。
// 2026-11-18 实抓：degrade-e2e 这个 id 先跑「往 README 加一行」，再跑「降级复验」，
// 第二个任务一开局 attempts=4 ≥ MAX_ATTEMPTS，直接降级成只出报告 —— 白跑一次。
export function taskHash(spec) {
  const s = spec || {};
  const key = JSON.stringify({
    k: String(s.kind || 'patch'),
    t: String(s.task || ''),
    test: String(s.test || ''),
    lane: String(s.lane || ''),
  });
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

// 同一 id 的历史失败次数（读上一次的 result.json）。成功会把它清零。
// 传了 hash 且与上一次的 taskHash 不同 → 视为全新任务，从 0 开始。
export function attemptsOf(cwd, id, hash) {
  const f = path.join(inboxDir(cwd), id + '.result.json');
  if (!fs.existsSync(f)) return 0;
  try {
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (hash && r && r.taskHash && r.taskHash !== hash) return 0;
    return Number(r && r.attempts) || 0;
  } catch { return 0; }
}

// 结果不能只留一份。
// 2026-11-18 实抓：degrade-e2e 连跑两次（一次成功进 done/、一次失败进 failed/），
// 而 <id>.result.json 是覆盖写 —— 成功那次的结论被失败那次抹掉，
// 事后只能看到「failed/ 里有 task、done/ 里也有 task，但只有一份失败结果」，
// 到底 done/ 那条跑成没跑成，无从复原。
// 所以：根目录留最新一份（兼容旧读法）+ 桶内留当时那份 + history.jsonl 永追加。
export function writeResult(cwd, id, result) {
  const dir = inboxDir(cwd);
  ensure(dir);
  const rec = { contract: INBOX_CONTRACT, id, at: new Date().toISOString(), ...result };
  const text = JSON.stringify(rec, null, 2) + '\n';
  const file = path.join(dir, id + '.result.json');
  fs.writeFileSync(file, text, 'utf8');

  const bucket = path.join(dir, rec.ok ? 'done' : 'failed');
  ensure(bucket);
  const snap = path.join(bucket, id + '.result.json');
  if (fs.existsSync(snap)) {
    // 桶里已经有同 id 的旧结论 → 先把旧的那份改名留档，不覆盖。
    let prevAt = 'prev';
    try {
      const old = JSON.parse(fs.readFileSync(snap, 'utf8'));
      if (old && old.at) prevAt = compactStamp(old.at);
    } catch { /* 旧文件坏了也照样改名留档 */ }
    try { fs.renameSync(snap, path.join(bucket, freeName(bucket, id + '@' + prevAt + '.result.json'))); } catch { /* 改名失败就让下面覆盖 */ }
  }
  fs.writeFileSync(snap, text, 'utf8');

  try { fs.appendFileSync(path.join(dir, 'history.jsonl'), JSON.stringify(rec) + '\n', 'utf8'); } catch { /* 账本写不了不影响主流程 */ }
  return file;
}

export function archive(cwd, id, ok) {
  const dir = inboxDir(cwd);
  const bucket = path.join(dir, ok ? 'done' : 'failed');
  ensure(bucket);
  // 归档时统一回 <id>.task.json：done/ 里躺着 <id>.claimed.json 会让人以为它还没干。
  // 撞名说明同 id 被投了两次（2026-11-18 实测 done/ 与 failed/ 各有一份 degrade-e2e）：
  // 第一版这里 catch 是空的，两次都成功归档，但日志零痕迹 —— 事后查不出「同 id 重复投」这件事。
  // 现在改成带时间戳改名归档，并把撞名事实回传给调用方记账。
  const collided = [];
  for (const ext of ['.claimed.json', SUFFIX]) {
    const src = path.join(dir, id + ext);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(bucket, id + SUFFIX);
    if (!fs.existsSync(dst)) {
      fs.renameSync(src, dst);
      continue;
    }
    const alt = path.join(bucket, freeName(bucket, id + '@' + compactStamp() + SUFFIX));
    try {
      fs.renameSync(src, alt);
      collided.push(path.basename(alt));
    } catch (err) {
      collided.push(id + ' 归档失败: ' + (err && err.code || err && err.message));
    }
  }
  return { bucket, collided };
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
      writeResult(cwd, entry.id, { ok: false, reason: entry.reason, taskHash: taskHash(entry.spec) });
      archive(cwd, entry.id, false);
      skipped.push({ id: entry.id, reason: entry.reason });
      log({ phase: 'invalid', id: entry.id, reason: entry.reason });
      continue;
    }
    const got = claimTask(entry);
    if (!got.ok) { skipped.push({ id: entry.id, reason: got.reason }); continue; }
    const kind = entry.spec.kind;
    const handler = handlers[kind];
    // 连续失败到阈值就降级：spec 上打 asReport，handler 有义务据此只出报告。
    const hash = taskHash(entry.spec);
    const prevAttempts = attemptsOf(cwd, entry.id, hash);
    const degrade = prevAttempts >= MAX_ATTEMPTS;
    const spec = degrade ? { ...entry.spec, asReport: true, failStreak: prevAttempts } : entry.spec;
    const t0 = Date.now();
    let out;
    if (typeof handler !== 'function') {
      out = { ok: false, reason: 'no-handler: ' + kind };
    } else {
      try { out = await handler(spec, { cwd, id: entry.id }); }
      catch (err) { out = { ok: false, reason: 'exception: ' + (err && err.message) }; }
    }
    const ok = !!(out && out.ok);
    writeResult(cwd, entry.id, {
      kind,
      ok,
      reason: out && out.reason || null,
      elapsedMs: Date.now() - t0,
      degraded: degrade,
      attempts: ok ? 0 : prevAttempts + 1,
      taskHash: hash,
      detail: out,
    });
    const arch = archive(cwd, entry.id, ok);
    for (const c of arch.collided) log({ phase: 'collision', id: entry.id, detail: c });
    processed.push({ id: entry.id, kind, ok, degraded: degrade, reason: out && out.reason || null, elapsedMs: Date.now() - t0, collided: arch.collided, detail: out });
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
    const head = `${p.ok ? '✓' : '✗'} ${p.id} [${p.kind}]${p.degraded ? '（已降级：只出报告）' : ''} ${(p.elapsedMs / 1000).toFixed(1)}s`;
    L.push(p.ok ? head : head + ' —— ' + (p.reason || '失败'));
    if (p.ok && p.detail && Array.isArray(p.detail.patchPaths)) {
      for (const f of p.detail.patchPaths) L.push('    patch：' + f);
      if (p.detail.applied === false) L.push('    注意：patch 只存档、没有应用到工作树（要落地得自己 apply）');
    }
    if (p.collided && p.collided.length) L.push('    撞名留档：' + p.collided.join('、'));
  }
  for (const s of r.skipped) L.push(`· ${s.id} 跳过 —— ${s.reason}`);
  L.push(`合计 ${(r.elapsedMs / 1000).toFixed(1)}s · 剩 ${r.remaining} 条`);
  return L.join('\n');
}