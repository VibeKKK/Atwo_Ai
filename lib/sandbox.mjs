// lib/sandbox.mjs —— 判定链的第五层：能跑起来看的，就别只读文本。
//
// 2026-11-17 现状问题：子会话只有 Read/Grep/Glob，父审也只有 Read。全系统没有一处
// 执行过被测代码 —— 一个「引用全真、逻辑全错」的模块可以拿满分通过。
//
// 这一层只做两件事：
//   1) 白名单内的命令可以在影子副本里跑（不让它碰真仓库、不让它 rm/git/curl）；
//   2) 产物声称的 RUN 结果由机械层重跑核对（声称 exit 0 而实跑 2 → 判死）。
//
// 纪律：白名单是 fail-closed 的 —— 认不出的命令一律拒，不猜、不放行。
import fs from 'node:fs';
import os from 'node:os';
import { createWorktreeSync, overlayWorkingTree } from './worktree.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SANDBOX_CONTRACT = 'atwo-sandbox/1';

// 允许跑的命令：只读、无副作用、结果可与声明比对。
const ALLOW = [
  /^node --check [\w./-]+\.(?:mjs|js|cjs)$/,
  /^node test\/[\w.-]+\.test\.mjs$/,
  /^node test\/all\.mjs(?: --dir [\w./-]+)?$/,
  /^node vm\/smoke\.mjs$/,
  /^node atwo\.mjs gate --no-tests$/,
  /^node atwo\.mjs judge --z [-\d.,]+$/,
  /^node atwo\.mjs attest$/,
];

// 出现这些字符说明对方在拼 shell，不是在跑一条命令（反引号写作 \x60，避免模板字面量截断）。
const SHELLISH = /[|&;<>$(){}[\]*?~!\n\r\t"'\\\x60]/;

/** 判一条命令能不能跑。返回 { ok, reason }。 */
export function allowCommand(cmd) {
  const c = String(cmd == null ? '' : cmd).trim();
  if (!c) return { ok: false, reason: '空命令' };
  if (SHELLISH.test(c)) return { ok: false, reason: '命令里有 shell 元字符（管道/重定向/引号/通配），沙箱只跑单条命令' };
  if (c.length > 300) return { ok: false, reason: '命令过长（>300 字符）' };
  if (!ALLOW.some((re) => re.test(c))) return { ok: false, reason: '不在白名单：只许 node --check / node test/<文件> / node vm/smoke.mjs / node atwo.mjs {gate --no-tests,judge,attest}' };
  return { ok: true, reason: '' };
}

const tail = (s, n = 800) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(-n) : t;
};

/** 在 cwd 里跑一条白名单命令。绝不抛，失败用返回值表达。 */
export function runSandboxed(cmd, { cwd = process.cwd(), timeoutMs = 120000, env } = {}) {
  const c = String(cmd == null ? '' : cmd).trim();
  const verdict = allowCommand(c);
  if (!verdict.ok) return { contract: SANDBOX_CONTRACT, ok: false, allowed: false, reason: verdict.reason, cmd: c, code: null, ms: 0 };
  const argv = c.split(/\s+/);
  if (argv[0] === 'node') argv[0] = process.execPath;
  const t0 = Date.now();
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { NO_COLOR: '1', FORCE_COLOR: '0' }, env || {}),
  });
  const ms = Date.now() - t0;
  const timedOut = !!res.error && /timed?\s*out|ETIMEDOUT/i.test(String(res.error.message || res.error));
  return {
    contract: SANDBOX_CONTRACT,
    ok: !timedOut && res.status === 0,
    allowed: true,
    cmd: c,
    code: typeof res.status === 'number' ? res.status : null,
    signal: res.signal || null,
    timedOut,
    ms,
    stdout: tail(res.stdout),
    stderr: tail(res.stderr || (res.error ? String(res.error.message || res.error) : '')),
  };
}

const SKIP = new Set(['node_modules', '.git', '.atw', '.agents', 'reviews', '__pycache__']);

/**
 * 造一份影子副本，优先用 git worktree（实测真仓库 406ms / 3.7MB，cpSync 是 5.9s / 27MB）。
 * worktree 检出的是 ref 的字节，所以必须把工作区里脏的与未跟踪的文件叠上去，
 * 否则「校验一条刚改过的文件的 RUN」会在副本里跑到旧版本，退出码与真实不符。
 * 非 git 仓库或 worktree 失败 → 退回 cpSync，行为与以前一致。
 */
function makeShadowByWorktree(srcDir) {
  const wt = createWorktreeSync(srcDir);
  if (!wt.ok) return { ok: false, dir: null, reason: wt.reason || 'worktree-failed', cleanup() {} };
  const ov = overlayWorkingTree(srcDir, wt.dir);
  if (!ov.ok) {
    try { wt.cleanup(); } catch {}
    return { ok: false, dir: null, reason: '叠加工作区没成：' + (ov.reason || ''), cleanup() {} };
  }
  let entries = [];
  try { entries = fs.readdirSync(wt.dir); } catch {}
  if (!entries.length) {
    try { wt.cleanup(); } catch {}
    return { ok: false, dir: null, reason: 'worktree 副本是空的：' + srcDir, cleanup() {} };
  }
  return { ok: true, dir: wt.dir, reason: '', bytes: 0, ms: wt.ms, isolation: 'worktree', overlaid: ov.copied, cleanup() { try { wt.cleanup(); } catch {} } };
}

/** 造一份影子副本：真仓库一个字节都不动。返回 { dir, ok, reason, cleanup() }。 */
export function makeShadow(srcDir, { prefix = 'atwo-shadow-', maxBytes = 64 * 1024 * 1024, isolation = 'worktree' } = {}) {
  if (isolation === 'worktree') {
    const wt = makeShadowByWorktree(srcDir);
    if (wt.ok) return wt;
    // 不是 git 仓库是常态（测试里的临时目录），退回复制，不报错。
    const copy = makeShadowByCopy(srcDir, { prefix, maxBytes });
    copy.fallbackFrom = wt.reason;
    return copy;
  }
  return makeShadowByCopy(srcDir, { prefix, maxBytes });
}

function makeShadowByCopy(srcDir, { prefix, maxBytes }) {
  const dir = path.join(os.tmpdir(), prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
  let bytes = 0;
  const tooBig = { hit: false };
  try {
    fs.cpSync(srcDir, dir, {
      recursive: true,
      dereference: false,
      filter: (src) => {
        if (tooBig.hit) return false;
        const base = path.basename(src);
        if (SKIP.has(base)) return false;
        try {
          const st = fs.statSync(src);
          if (st.isFile()) { bytes += st.size; if (bytes > maxBytes) { tooBig.hit = true; return false; } }
        } catch { return false; }
        return true;
      },
    });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, dir: null, reason: '影子副本没建成：' + (e && e.message), cleanup() {} };
  }
  if (tooBig.hit) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, dir: null, reason: '仓库超过影子副本上限（' + Math.round(maxBytes / 1048576) + ' MB）', cleanup() {} };
  }
  // cpSync 对不存在的源在 Windows 上会「成功」造出空目录 —— 空副本一律当失败，
  // 否则 RUN 校验会在一个空目录里跑出 ENOENT，看起来像产物写错，其实是副本没成。
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch {}
  if (!entries.length) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, dir: null, reason: '影子副本是空的（源目录不存在？）：' + srcDir, cleanup() {} };
  }
  return { ok: true, dir, reason: '', bytes, isolation: 'copy', cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}
