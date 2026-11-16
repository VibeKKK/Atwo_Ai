// file: test/pair_heartbeat.test.mjs
/**
 * @file test/pair_heartbeat.test.mjs
 * @description 心跳（collab/heartbeat.json）的管道测试。
 *
 * 为什么要有：心跳存在的唯一理由是「区分在忙与已死」。它一旦静默失效，
 * 看板会永远显示「从未跳过」，人就会退回「状态 busy 就当他在听」的老路 ——
 * 而那条路在 2026-11-16 已经害我们以为对端还在，实际会话早爆了 3 小时。
 */

import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BEAT = path.join(root, 'collab/heartbeat.json');
const ME = 'dsh-work-replace';

let pass = 0; let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
};

const before = (() => { try { return JSON.parse(fs.readFileSync(BEAT, 'utf8')); } catch { return {}; } })();
const r = cp.spawnSync(process.execPath, ['pair.mjs', 'alive', '心跳自测'], {
  cwd: root, encoding: 'utf8', env: { ...process.env, COLLAB_ME: ME },
});
check('pair.mjs alive 退出码 0', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(0, 120));
check('alive 输出里有两方心跳行与判读说明', /dsh-work-replace/.test(r.stdout) && /疑似已死/.test(r.stdout));

const after = (() => { try { return JSON.parse(fs.readFileSync(BEAT, 'utf8')); } catch { return null; } })();
check('heartbeat.json 可解析', !!after);
const mine = after && after[ME];
check('本次心跳写入了自己那一条', !!(mine && mine.ts), JSON.stringify(mine));
check('时间戳是合法 ISO 且离现在不到 60 秒', !!mine && Math.abs(Date.now() - new Date(mine.ts).getTime()) < 60e3);
check('心跳带 note 与机器信息（能看出是谁、在哪台机）', !!(mine && mine.note === '心跳自测' && mine.host && mine.cwd));

// 不刷心跳的例外：watch 是长时空转，跳了会给出「有人在处理」的假信号。
const beforeTs = mine && mine.ts;
cp.spawnSync(process.execPath, ['pair.mjs', 'watch', '1'], {
  cwd: root, encoding: 'utf8', timeout: 1200, env: { ...process.env, COLLAB_ME: ME },
});
const afterWatch = (() => { try { return JSON.parse(fs.readFileSync(BEAT, 'utf8')); } catch { return {}; } })();
check('watch 不刷心跳（空转不算有人在干活）', (afterWatch[ME] || {}).ts === beforeTs, String((afterWatch[ME] || {}).ts));

// board 必须把心跳打出来 —— 不显示的心跳等于没有。
const b = cp.spawnSync(process.execPath, ['pair.mjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, COLLAB_ME: ME } });
check('看板显示「心跳」行', /心跳 我/.test(b.stdout || ''), (b.stdout || '').split('\n').slice(0, 8).join(' | ').slice(0, 200));

// 恢复：测试不该把自己的真实心跳改成「心跳自测」。
if (before[ME]) {
  const restored = { ...after, [ME]: before[ME] };
  fs.writeFileSync(BEAT, JSON.stringify(restored, null, 2) + '\n', 'utf8');
}

console.log('');
console.log((fail ? '✗' : '✓') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
