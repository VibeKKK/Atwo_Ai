// 锁池离线验证：不调 agent，只验证并发控制本身。
import { withLockPool, withLock, listLocks } from '../lib/lock.mjs';

const seq = [];
const t0 = Date.now();
const mark = (s) => seq.push(`${String(Date.now() - t0).padStart(5)}ms ${s}`);

// ① slots=1 → 必须串行（trae 的行为）
await Promise.all([
  withLockPool('t-single', 1, async () => { mark('A-start'); await new Promise(r => setTimeout(r, 120)); mark('A-end'); }),
  withLockPool('t-single', 1, async () => { mark('B-start'); await new Promise(r => setTimeout(r, 120)); mark('B-end'); }),
]);
const serial = seq.join('|');
console.log('slots=1 顺序:', serial.replace(/\d+ms /g, ''));

// ② slots=2 → 两路应当重叠（codebuddy 的行为）
seq.length = 0;
const t1 = Date.now();
await Promise.all([
  withLockPool('t-pool', 2, async () => { mark('C-start'); await new Promise(r => setTimeout(r, 200)); mark('C-end'); }),
  withLockPool('t-pool', 2, async () => { mark('D-start'); await new Promise(r => setTimeout(r, 200)); mark('D-end'); }),
]);
const poolSpan = Date.now() - t1;
console.log('slots=2 耗时:', poolSpan, 'ms（串行会 ≈400，并发应 ≈200）');
console.log('  ', seq.join(' | ').replace(/\d+ms /g, ''));

// ③ slots=2 但来 3 个 → 第三个排队
seq.length = 0;
const t2 = Date.now();
await Promise.all([
  withLockPool('t-3', 2, async () => { mark('E'); await new Promise(r => setTimeout(r, 150)); }),
  withLockPool('t-3', 2, async () => { mark('F'); await new Promise(r => setTimeout(r, 150)); }),
  withLockPool('t-3', 2, async () => { mark('G'); await new Promise(r => setTimeout(r, 150)); }),
]);
const threeSpan = Date.now() - t2;
console.log('slots=2 来 3 个耗时:', threeSpan, 'ms（应 ≈300）');

// ④ 释放干净
const left = listLocks().filter((l) => String(l.name).startsWith('t-'));
console.log('残留锁:', left.length === 0 ? '0 个 ✓' : JSON.stringify(left));
