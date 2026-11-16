// lib/snapshot.mjs —— 把「子会话当时看到的那些文件」原样存下来。
//
// 为什么需要（2026-11-17 实测）：盲测把旧产物当 good 标签，几小时后仓库变了，
// 引用的行号全部错位 → 测出来的不是「父审能不能抓错」，而是「仓库动过没有」。
// 一份产物的可信度只能对着它生成时的字节评，任何「事后拿现在的文件核」都是幻觉。
//
// 只存被引用的文件（EVIDENCE 里点名的那些），不存全仓库：一是体积，二是
// 「没被引用的文件改了」本来就不影响这份产物的对错。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const SNAPSHOT_CONTRACT = 'atwo-snapshot/1';
const REF_RE = /([\w@./-]+\.(?:mjs|js|cjs|mts|ts|tsx|jsx|json|md|py|yml|yaml|txt|sh))(?::(\d+))?/g;
const DEFAULT_MAX_FILES = 24;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 从若干段文本里抠出被引用的相对路径（去重、保持出现顺序、丢掉明显是 URL 的）。 */
export function refsFromTexts(texts, { max = 200 } = {}) {
  const out = [];
  const seen = new Set();
  for (const t of texts || []) {
    if (typeof t !== 'string') continue;
    for (const m of t.matchAll(REF_RE)) {
      const p = String(m[1]).replace(/^\.\//, '');
      // URL 与绝对路径都不是仓库内引用：留它们在清单里只会记一堆 outside-cwd。
      if (/^[a-z]+:\/\//i.test(p) || p.startsWith('//') || p.startsWith('/')) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** 仓库状态指纹：HEAD + 脏文件清单的哈希。未提交改动才是常态，所以必须记下来。 */
export function repoFingerprint(cwd) {
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const status = git(cwd, ['status', '--porcelain']) || '';
  return { head, dirty: status.split('\n').filter(Boolean).length, dirtyHash: sha256(Buffer.from(status, 'utf8')).slice(0, 16) };
}

/**
 * 把引用到的文件原样写进 <dir>/snap/（扁平化文件名，路径写在清单里，避免目录穿越）。
 * 拿不到的文件记 missing —— 不猜、不静默当通过。
 */
export function writeSnapshot(dir, { cwd = process.cwd(), texts = [], maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const refs = refsFromTexts(texts);
  const files = [];
  let bytes = 0;
  fs.mkdirSync(path.join(dir, 'snap'), { recursive: true });
  for (const rel of refs) {
    if (files.length >= maxFiles) break;
    const abs = path.resolve(cwd, rel);
    // 只允许仓库内文件：绝对路径或跳出 cwd 的一律不存（产物可以被模型写坏）。
    if (!abs.startsWith(path.resolve(cwd) + path.sep)) {
      files.push({ path: rel, missing: 'outside-cwd' });
      continue;
    }
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (e) {
      files.push({ path: rel, missing: 'not-found' });
      continue;
    }
    if (bytes + buf.length > maxBytes) {
      files.push({ path: rel, missing: 'over-budget' });
      continue;
    }
    bytes += buf.length;
    const flat = rel.replace(/[\/\\]/g, '__');
    fs.writeFileSync(path.join(dir, 'snap', flat), buf);
    files.push({ path: rel, sha256: sha256(buf), bytes: buf.length, snap: 'snap/' + flat });
  }
  const snap = { contract: SNAPSHOT_CONTRACT, takenAt: new Date().toISOString(), cwd, repo: repoFingerprint(cwd), files };
  fs.writeFileSync(path.join(dir, 'SNAPSHOT.json'), JSON.stringify(snap, null, 2), 'utf8');
  return snap;
}

/**
 * 读回快照并把文件铺到一个临时目录，供盲测「按当时的字节」核引用。
 * 缺的记在 missing 里交回调用方，调用方不许把缺文件当核对通过。
 */
export function materializeSnapshot(dir, outDir) {
  const p = path.join(dir, 'SNAPSHOT.json');
  if (!fs.existsSync(p)) return { ok: false, reason: 'no-snapshot', dir: null, missing: [] };
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { ok: false, reason: 'bad-snapshot', dir: null, missing: [] };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const missing = [];
  for (const f of snap.files || []) {
    if (!f.snap) {
      missing.push(f.path);
      continue;
    }
    const src = path.join(dir, f.snap);
    const dst = path.join(outDir, f.path);
    if (!fs.existsSync(src)) {
      missing.push(f.path);
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return { ok: true, dir: outDir, snapshot: snap, missing };
}
