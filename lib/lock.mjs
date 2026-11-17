/**
 * 单例锁 —— 每个 agent 同时只能有一个任务在用它的输入框/CLI。
 *
 * 为什么必须有：
 *   Trae 只有一个 "Agent" 页面目标，CDP 连上去就是那一个输入框。
 *   两个请求同时敲进去 → 文本混在一起 → 两边都拿到残缺答案，而且**不报错**。
 *   codebuddy 是 CLI 子进程，并发问题小些，但它的 CLI 会写同一个凭据/缓存目录。
 *
 * 用的是最笨也最可靠的办法：O_CREAT|O_EXCL 建锁文件。
 *   进程崩了也不会永久卡死 —— 锁里有 pid 和心跳时间，超过 staleMs 或 pid 已死就抢。
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR = path.join(process.cwd(), '.locks');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 拿锁。拿不到就轮询等待。
 * @param {string} name        锁名（一般就是 agent 名）
 * @param {{dir?:string, waitMs?:number, staleMs?:number, pollMs?:number, onWait?:(info:object)=>void}} opts
 * @returns {Promise<()=>void>} 释放函数
 */
export async function acquire(name, opts = {}) {
  const dir = opts.dir || process.env.ORCH_LOCK_DIR || DEFAULT_DIR;
  const waitMs = opts.waitMs ?? 300000;   // 最多等 5 分钟
  const staleMs = opts.staleMs ?? 600000; // 10 分钟没心跳视为死锁
  const pollMs = opts.pollMs ?? 400;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.lock`);
  const t0 = Date.now();
  let announced = false;

  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), name }));
      fs.closeSync(fd);
      let released = false;
      const heartbeat = setInterval(() => {
        try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now(), name })); } catch { }
      }, 15000);
      heartbeat.unref?.();
      return () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        try { fs.unlinkSync(file); } catch { }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = readLock(file);
      const stale = !held || !pidAlive(held.pid) || (Date.now() - (held.ts || 0) > staleMs);
      if (stale) {
        try { fs.unlinkSync(file); } catch { }
        continue; // 立刻重试
      }
      if (waitMs === 0) {
        // 留给锁池用：只试一次，占着就立刻告诉我，我去试下一路
        const err = new Error(`${name} 被占用（持有者 pid=${held?.pid}）`);
        err.code = 'EBUSY';
        throw err;
      }
      if (Date.now() - t0 > waitMs) {
        const err = new Error(`${name} 被占用超过 ${Math.round(waitMs / 1000)}s（持有者 pid=${held?.pid}）`);
        err.code = 'ELOCKTIMEOUT';
        throw err;
      }
      if (!announced && opts.onWait) { announced = true; opts.onWait({ held, waitedMs: Date.now() - t0 }); }
      await new Promise(r => setTimeout(r, pollMs));
    }
  }
}

/** 拿锁 → 跑 → 一定释放（含异常、超时）。 */
export async function withLock(name, fn, opts = {}) {
  const release = await acquire(name, opts);
  try { return await fn(); } finally { release(); }
}

/**
 * 锁池：允许同一个 agent 最多 slots 路并发。
 *
 * 为什么需要：codebuddy 是独立 CLI 进程，本来可以同时跑 2-3 个；
 * 但单一锁把它排成队，等于自废吞吐。trae 则必须恒为 1（只有一个 Agent 页面，
 * 并发会互相污染回答），所以它的 slots 传 1，行为与 withLock 完全一致。
 *
 * 实现：先用 name.1.lock … name.N.lock 依次抢，抢到哪个算哪路；
 * 全被占就等 pollMs 再试，直到 waitMs 超时。
 */
/**
 * 进程内重入表：同一进程对同一个槽位重复申请时直接放行。
 *
 * 为什么必须有：orchestra.runOne 外层已经 withLockPool(name, slots) 包了一层，
 * 而 agents/doubao.mjs 的 askDoubao 内部又自带一层同名 withLockPool。
 * 两层抢的是同一个锁文件 → 内层永远 EBUSY → 内层轮询到它自己的 waitMs(300s) 才放弃，
 * 表现为「doubao 260s 超时、连 task.md 都没写」。文件锁本身不区分「自己」和「别人」，
 * 所以只能在进程内记一层。槽位名一致才算重入，并发多路（name#i）不受影响。
 */
const LOCAL_HELD = new Map();

export async function withLockPool(name, slots, fn, opts = {}) {
  const n = Math.max(1, Math.floor(slots) || 1);
  const waitMs = opts.waitMs ?? 300000;
  const pollMs = opts.pollMs ?? 150;   // 池内轮询要短：空出的槽位应当立刻被抢到
  const t0 = Date.now();
  let announced = false;
  for (;;) {
    for (let i = 1; i <= n; i++) {
      const slotName = n === 1 ? name : `${name}#${i}`;
      if ((LOCAL_HELD.get(slotName) || 0) > 0) {
        LOCAL_HELD.set(slotName, (LOCAL_HELD.get(slotName) || 0) + 1);
        try { return await fn(i); } finally {
          const v = (LOCAL_HELD.get(slotName) || 1) - 1;
          if (v <= 0) LOCAL_HELD.delete(slotName); else LOCAL_HELD.set(slotName, v);
        }
      }
      try {
        const release = await acquire(slotName, { ...opts, waitMs: 0 });
        LOCAL_HELD.set(slotName, (LOCAL_HELD.get(slotName) || 0) + 1);
        try { return await fn(i); } finally {
          const v = (LOCAL_HELD.get(slotName) || 1) - 1;
          if (v <= 0) LOCAL_HELD.delete(slotName); else LOCAL_HELD.set(slotName, v);
          release();
        }
      } catch (e) {
        if (e && (e.code === 'EBUSY' || /占/.test(String(e.message)))) continue;
        throw e;
      }
    }
    if (!announced && opts.onWait) { opts.onWait(n); announced = true; }
    if (Date.now() - t0 > waitMs) {
      const e = new Error(`${name} 的 ${n} 路都占满，等待超时`);
      e.code = 'ELOCKTIMEOUT';
      throw e;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** 超时包装：到点就 reject，并给 fn 一个 abort 信号（如果它支持的话）。 */
export function withTimeout(promiseFactory, ms, label = 'task') {
  let timer;
  const ac = new AbortController();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      const e = new Error(`${label} 超时 ${Math.round(ms / 1000)}s`);
      e.code = 'ETIMEOUT';
      reject(e);
    }, ms);
    // 注意：这里**不能** unref —— 否则当被等的 promise 没有任何句柄（如永不 resolve 的 Promise）时，
    // 事件循环会直接退出，超时永远不触发（实测表现为"进程静默退出、无输出"）。
  });
  return Promise.race([promiseFactory(ac.signal), timeout])
    .finally(() => clearTimeout(timer));
}

/** 当前谁在占着锁（给 health/status 用）。 */
export function listLocks(opts = {}) {
  const dir = opts.dir || process.env.ORCH_LOCK_DIR || DEFAULT_DIR;
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.lock')).map(f => {
      const info = readLock(path.join(dir, f)) || {};
      return { name: f.replace(/\.lock$/, ''), pid: info.pid, ageMs: Date.now() - (info.ts || 0), alive: info.pid ? pidAlive(info.pid) : false };
    });
  } catch { return []; }
}
