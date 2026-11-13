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
