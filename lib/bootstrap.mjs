// lib/bootstrap.mjs —— 「这台机器现在能干什么」。
//
// 为什么需要它：atwo 的目标形态是「扔到另一台机器上，那个 AI 不被迫用，但它自己
// 觉得好用就一直用」。而陌生的 AI 打开它时，第一个问题不是「有哪些动词」，
// 是「在我这台机器上，哪条路真的能跑」。
//
// 今天把 atwo 搬到新机器，会撞上四个硬事实：
//   1. 四个通道的可执行文件路径默认指着这台机器的 D 盘（agents/*.mjs 的 DEFAULTS）；
//   2. 没有 doctor，报错方式是「spawn ENOENT」，陌生 AI 会直接判定这东西坏了；
//   3. 没有一个不依赖外部客户端的通道 —— ollama 本机就有，却没人告诉它可以当唯一通道；
//   4. 无从「试一次就知道值不值」的入口。
//
// 所以这个文件的职责只有一个：把「能 / 不能 / 怎么改」讲清楚，
// 并且如实标注局限 —— 只查文件存不存在，不代表现在能连上。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

/** 环境变量优先还是默认值，说清楚才有用 —— 换机器就是要改这些环境变量。 */
function probe(label, value, envName, hint) {
  const ok = exists(value);
  return {
    label,
    ok,
    path: value || null,
    env: envName || null,
    fix: ok ? null : (envName ? '设 ' + envName + ' 指向可执行文件' : null) || hint || null,
  };
}

/** 沿相对 import 走一遍，找缺失（新机器上最容易出现的坑就是少一个文件）。 */
export function closureOf(entry) {
  const seen = new Set();
  const missing = [];
  const walk = (file) => {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    if (!exists(abs)) { missing.push(abs); return; }
    seen.add(abs);
    let src = '';
    try { src = fs.readFileSync(abs, 'utf8'); } catch { return; }
    const re = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const target = path.resolve(path.dirname(abs), m[1]);
      walk(exists(target) ? target : (exists(target + '.mjs') ? target + '.mjs' : target));
    }
  };
  walk(entry);
  return { files: [...seen], missing };
}

async function probeOllama(timeoutMs = 1200) {
  if (typeof fetch !== 'function') return { ok: false, why: 'node 太老（没有 fetch）', models: [] };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: ctl.signal });
    if (!r.ok) return { ok: false, why: 'HTTP ' + r.status, models: [] };
    const j = await r.json();
    const models = (j.models || []).map((m) => m.name).slice(0, 6);
    return { ok: true, why: null, models };
  } catch (e) {
    return { ok: false, why: '连不上 127.0.0.1:11434（ollama 没启动）', models: [] };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 探测。返回的结构就是 doctor --json 的输出，别在别处再拼一份。
 */
export async function detectEnvironment(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const here = path.resolve(cwd);

  // 通道：路径从 lib/config.mjs 来（它已经支持 local.json 与环境变量覆盖），
  // 这里只做「在不在」的判断，不做启动尝试 —— 拉GUI 太贵，而且会打扰用户。
  let cfg = {};
  try { ({ config: cfg } = await import('./config.mjs')); } catch { cfg = {}; }

  const channels = {
    codebuddy: probe('codebuddy', cfg.codebuddyCli || process.env.CODEBUDDY_CLI, 'CODEBUDDY_CLI'),
    trae: probe('trae', cfg.traeExe || process.env.TRAE_EXE, 'TRAE_EXE'),
    workbuddy: probe('workbuddy', cfg.workbuddyExe || process.env.WB_EXE, 'WB_EXE'),
    doubao: probe('doubao', process.env.DB_EXE || '', 'DB_EXE', 'doubao 没有默认路径，必须设 DB_EXE'),
  };
  const channelUp = Object.entries(channels).filter(([, v]) => v.ok).map(([k]) => k);

  const ollama = await probeOllama(opts.ollamaTimeoutMs);

  const repo = {
    isGit: exists(path.join(here, '.git')),
    atw: exists(path.join(here, '.atw')),
    tests: exists(path.join(here, 'test', 'all.mjs')),
    accept: exists(path.join(here, 'packages', 'accept', 'bin', 'accept.mjs')),
    atwo: exists(path.join(here, 'atwo.mjs')),
  };

  // 能力判定：不按「动词表有什么」写，按「现在真能跑什么」写。
  const can = [];
  const cannot = [];
  if (repo.atwo) {
    can.push('check（只跑验收器，不派活）');
    can.push('diff / judge / state / mode（本地判定）');
    can.push('try（零依赖自检）');
    if (channelUp.length || ollama.ok) can.push('fanout --dry-run（只算参数不派活）');
  }
  if (channelUp.length) {
    can.push('fanout / go（真派活，走 ' + channelUp.join(' / ') + '）');
  } else {
    cannot.push('fanout / go 真派活 —— 四个通道一个都没找到');
  }
  if (!ollama.ok) cannot.push('本地降级通道 —— ollama 没启动');
  if (!repo.tests) cannot.push('全量回归 —— 找不到 test/all.mjs');

  const advice = [];
  if (repo.atwo) advice.push('先跑 atwo try（2 秒，不花钱，看它真能干活）');
  advice.push('atwo caps --json 拿全部动词与代价');
  if (!channelUp.length) {
    advice.push(ollama.ok
      ? '当前只有 ollama 可用：可以用它当唯一通道练手，但质量与四通道不同量级'
      : '设一个通道的环境变量，或拉起 ollama（本机已有的本地模型），否则只剩本地判定能用');
  }
  if (channelUp.length && !repo.tests) advice.push('缺 test/all.mjs：派活的活没有闸门兜着，先补测试再派');

  return {
    contract: 'atwo-doctor/1',
    platform: process.platform + ' ' + process.arch,
    node: process.version,
    cwd: here,
    channels,
    channelUp,
    ollama,
    repo,
    can,
    cannot,
    advice,
  };
}

/**
 * try：零依赖自检三连。目的不是「证明功能齐全」，是让陌生 AI 在两秒内
 * 看到「它真的能干活」，而且全程不花钱、不联网、不派活。
 */
export async function quickSelfCheck(opts = {}) {
  const t0 = Date.now();
  const here = path.resolve(opts.cwd || process.cwd());
  const steps = [];

  // ① 闭包完整性 —— 新机器上最常见的问题是少一个文件
  try {
    const c = closureOf(path.join(here, 'atwo.mjs'));
    steps.push({
      name: '运行闭包',
      ok: c.missing.length === 0,
      detail: c.files.length + ' 个文件，缺失 ' + c.missing.length + (c.missing.length ? '：' + c.missing.slice(0, 3).join(', ') : ''),
    });
  } catch (e) {
    steps.push({ name: '运行闭包', ok: false, detail: '跑不起来：' + (e && e.message) });
  }

  // ② 三值判定（纯本地，0 文件依赖）
  try {
    const { judge } = await import('../vm/judge.mjs');
    // 9 个同值 0.5：去重后只有 1 个来源，agreement 必须被按住 → 结论必须是 -1（别判）。
    // 这条断言的意义是「闸门还在」：一旦有人把 sd<eps 那三条改回去，这里立刻变 +1。
    const r = judge({ zValues: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] });
    const ok = r.value === -1;
    steps.push({
      name: '三值判定',
      ok,
      detail: '9 个同值输入 → ' + r.value + '（' + (r.reason || '?') + '，置信度 ' + Number(r.confidence).toFixed(3) + '）' + (ok ? '' : ' ← 期望 -1（别判），闸门可能被改坏了'),
    });
  } catch (e) {
    steps.push({ name: '三值判定', ok: false, detail: '跑不起来：' + (e && e.message) });
  }

  // ③ fanout 参数计算（不派活）
  try {
    const { clampParts, MAX_PARTS } = await import('./fanout-run.mjs');
    const ok = clampParts(99) === MAX_PARTS && clampParts(1) === 1;
    steps.push({ name: '并发上限', ok, detail: 'clampParts(99) = ' + clampParts(99) + '（上限 ' + MAX_PARTS + '）' });
  } catch (e) {
    steps.push({ name: '并发上限', ok: false, detail: '跑不起来：' + (e && e.message) });
  }

  const failed = steps.filter((s) => !s.ok);
  return {
    contract: 'atwo-try/1',
    ok: failed.length === 0,
    elapsedMs: Date.now() - t0,
    steps,
    next: failed.length
      ? '有步骤没过 —— 先修它，别在这个状态下派活'
      : '一切正常。想真派活用 atwo fanout "<任务>" --dry-run 先看它打算干什么',
  };
}
