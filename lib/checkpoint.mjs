/**
 * 断点续跑：派活到一半失败，别把已经跑完的片再烧一遍。
 *
 * 现实动机：一次 L 档派活 4 片、每片 30–450 秒，最后因为一片 480 秒超时整批报废 ——
 * 已经回来的三片是白烧的。有了 checkpoint，重跑时那三片直接跳过。
 *
 * 三条约束：
 * 1. 原子写：先写 .tmp 再 rename，断电/被杀不会留下半个 JSON（半截 JSON 比没有更坏）。
 * 2. 只在有 ATWO_RUN_ID 时启用：没有 run id 就没有「同一件事」的判定依据，乱续跑比重跑更危险。
 * 3. 读坏了就当没有：checkpoint 是加速器，不是真值来源。
 */
import fs from 'node:fs';
import path from 'node:path';

/** .atwo/fanout/<runId>/chk/ */
export function chkDir(root, runId) {
  return path.join(root || process.cwd(), '.atwo', 'fanout', String(runId || ''), 'chk');
}

export function readChk(dir, id) {
  try {
    const raw = fs.readFileSync(path.join(dir, String(id) + '.json'), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    // 只认「有答案或明确失败理由」的条目：空壳 checkpoint 会让下次误以为跑过了
    if (!obj.answer && obj.ok !== false) return null;
    return obj;
  } catch {
    return null;
  }
}

export function writeChk(dir, id, obj) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, String(id) + '.json');
    const tmp = dest + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, dest);
    return true;
  } catch {
    return false;
  }
}

/** 清掉一个 run 的全部 checkpoint（派活成功后调用，避免过期缓存影响下一次）。 */
export function clearChk(dir) {
  try {
    const names = fs.readdirSync(dir);
    let n = 0;
    for (const f of names) {
      if (!f.endsWith('.json') && !f.endsWith('.tmp')) continue;
      try { fs.rmSync(path.join(dir, f), { force: true }); n += 1; } catch { /* 单个删不掉不影响其余 */ }
    }
    return n;
  } catch {
    return 0;
  }
}

/** 这个 run 已经有几片可复用（给 CLI 打印「续跑」用）。 */
export function countChk(dir, n) {
  let k = 0;
  for (let i = 0; i < n; i += 1) if (readChk(dir, i)) k += 1;
  return k;
}
