// 结果缓存（C②）：同 agent + 同 prompt 的重复派活直接复用，不再付第二次钱。
// 只缓存「成功的契约输出」；失败与降级一律不缓存（否则错误会被冻结 24 小时）。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const FILE = join(process.cwd(), 'memory', '.cache.json');
const TTL_MS = Number(process.env.ORCH_CACHE_TTL_MS || 24 * 3600 * 1000);
const MAX = Number(process.env.ORCH_CACHE_MAX || 500);

function load() {
  try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}; } catch { return {}; }
}
function save(db) {
  try {
    mkdirSync(join(process.cwd(), 'memory'), { recursive: true });
    const keys = Object.keys(db);
    if (keys.length > MAX) {
      keys.sort((a, b) => (db[a].ts || 0) - (db[b].ts || 0));
      for (const k of keys.slice(0, keys.length - MAX)) delete db[k];
    }
    writeFileSync(FILE, JSON.stringify(db), 'utf8');
  } catch { /* 缓存写不进去不该影响主流程 */ }
}

export function keyOf(agent, prompt) {
  return createHash('sha256').update(agent + '\u0000' + prompt).digest('hex').slice(0, 32);
}

export function get(agent, prompt) {
  if (process.env.ORCH_NO_CACHE === '1') return null;
  const k = keyOf(agent, prompt);
  const db = load();
  const hit = db[k];
  if (!hit) return null;
  if (Date.now() - hit.ts > TTL_MS) { delete db[k]; save(db); return null; }
  return { addedText: hit.text, usage: { in: 0, out: 0 }, cached: true, savedTs: hit.ts };
}

export function put(agent, prompt, text) {
  if (process.env.ORCH_NO_CACHE === '1') return;
  if (!text || String(text).trim().length < 8) return;
  const db = load();
  db[keyOf(agent, prompt)] = { ts: Date.now(), agent, text: String(text).slice(0, 200000) };
  save(db);
}

export function stats() {
  const db = load();
  const n = Object.keys(db).length;
  const bytes = JSON.stringify(db).length;
  return { entries: n, bytes };
}

export function clear() { save({}); }
