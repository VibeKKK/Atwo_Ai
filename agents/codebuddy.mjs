// CodeBuddy Code CLI 驱动 —— 官方完整版（@tencent-ai/codebuddy-code v2.183.0）
//
// 为什么走 CLI 而不是 CDP：
//   它是纯命令行，有 -p/--print 非交互模式 + --output-format json，
//   stdout 直接就是结构化结果，不用赌 GUI 的 DOM 结构，比抓 Trae 网页稳得多。
//
// 入口变更史（2026-11-13）：
//   · WorkBuddy 内置的 cli/dist/codebuddy-lite-wb.mjs 是 lite/headless 构建 ——
//     没有 TUI、没有登录页，doctor/ps 路由被裁掉，永远拿不到凭据，弃用
//   · 改用官方 npm 包解压版：C:\Users\kkk\Tools\codebuddy-cli\package
//     下载源用 cdn.npmmirror.com（npmjs 直连被限速到 0.3MB/分钟）
//
// 前置：已登录（凭据在 ~/.codebuddy/app，2026-11-13 00:44 通过 --serve Web UI 完成）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const DEFAULTS = {
  node: process.env.CODEBUDDY_NODE
    || 'C:\\Users\\kkk\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe',
  cli: process.env.CODEBUDDY_CLI
    || 'C:\\Users\\kkk\\Tools\\codebuddy-cli\\package\\bin\\codebuddy',
  gitBash: process.env.CODEBUDDY_GIT_BASH
    || 'D:\\code app\\hub code\\Git\\bin\\bash.exe',
};

export const meta = {
  name: 'codebuddy',
  kind: 'cli-agent',
  transport: 'cli',
  port: 'stdin',
  strengths: ['整仓多文件改造', '跑命令改代码', '结构化 JSON 输出', '可后台可 swarm'],
  costModel: '积分（CodeBuddy 账号内扣减）',
};

/** 跑一次 CLI，拿 stdout/stderr；退出码非 0 也返回，由调用方判断 */
function runCli(args, opts = {}) {
  const { cwd, timeoutMs = 300000, env = {} } = opts;
  return new Promise((resolve) => {
    const e = {
      ...process.env,
      CODEBUDDY_SKIP_GIT_BASH_CHECK: '1',
      ...(fs.existsSync(DEFAULTS.gitBash) ? { CODEBUDDY_CODE_GIT_BASH_PATH: DEFAULTS.gitBash } : {}),
      ...env,
    };
    delete e.ELECTRON_RUN_AS_NODE;
    delete e.NODE_OPTIONS;
    const child = spawn(DEFAULTS.node, [DEFAULTS.cli, ...args], {
      cwd: cwd || process.cwd(),
      env: e,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', done = false;
    const finish = (code, extra = {}) => { if (done) return; done = true; clearTimeout(t); resolve({ code, out, err, ...extra }); };
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e2) => finish(-1, { spawnError: e2.message }));
    child.on('close', (code) => finish(code ?? -1));
    const t = setTimeout(() => { try { child.kill(); } catch {} finish(-2, { timedOut: true }); }, timeoutMs);
  });
}

/** 从混杂输出里捞出 CLI 的 JSON 结果对象 */
function extractJson(text) {
  const pick = (arr) => Array.isArray(arr)
    ? [...arr].reverse().find((o) => o && (o.type === 'result' || o.result !== undefined || o.subtype))
    : null;

  // 完整版 2.183.0 的 --output-format json 输出的是一个 JSON 数组 [{type:'system'},...,{type:'result'}]
  const whole = text.trim();
  if (whole.startsWith('[')) {
    try { const hit = pick(JSON.parse(whole)); if (hit) return hit; } catch { /* 数组没闭合，往下找 */ }
  }
  const arrStart = whole.lastIndexOf('\n[');
  if (arrStart >= 0) {
    try { const hit = pick(JSON.parse(whole.slice(arrStart + 1))); if (hit) return hit; } catch { /* ignore */ }
  }

  const rows = text.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  for (let i = rows.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(rows[i]);
      if (o && (o.type === 'result' || o.result !== undefined || o.subtype)) return o;
    } catch { /* 不是纯 JSON 行，继续往前找 */ }
  }
  const idx = text.lastIndexOf('{"type":"result"');
  if (idx >= 0) {
    try { return JSON.parse(text.slice(idx)); } catch { /* ignore */ }
  }
  return null;
}

const NEED_AUTH = /Authentication required|Please use .login|not logged in|未登录/i;

/** 派一次活。返回 { ok, addedText, elapsedMs, outputChars, raw } */
export async function askCodeBuddy(prompt, opts = {}) {
  const { timeoutMs = 300000, cwd, permissionMode = 'acceptEdits', model } = opts;
  const t0 = Date.now();
  // 成本实验（2026-11-13 实测 in tokens）：
  //   --tools "default"            → 23,130
  //   --tools "Write,Edit,Read"     →  7,633   ← 默认
  //   --tools ""                    →  6,175（纯文本任务，不能改文件）
  // 系统提示里工具 schema 占大头，限制工具就砍掉 2/3 固定开销。
  const tools = process.env.CODEBUDDY_TOOLS !== undefined ? process.env.CODEBUDDY_TOOLS : 'Write,Edit,Read';
  // 2026-11-14 改：max-turns 硬编码 1 会让「要求它思考一轮再输出」的活直接报 Max turns (1) exceeded
  // （自改项目 self.mjs 首次踩到）。改成可用 CODEBUDDY_MAX_TURNS 覆盖，默认行为不变。
  const maxTurns = String(process.env.CODEBUDDY_MAX_TURNS || '1');
  const args = ['-p', prompt, '--output-format', 'json', '--tools', tools, '--no-session-persistence', '--max-turns', maxTurns];
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);

  const r = await runCli(args, { cwd, timeoutMs });

  if (r.spawnError) {
    const e = new Error('codebuddy 起不来：' + r.spawnError);
    e.partial = null;
    throw e;
  }
  if (r.timedOut) {
    const e = new Error('codebuddy 超时 ' + Math.round(timeoutMs / 1000) + 's');
    e.partial = { ok: false, addedText: '', outputChars: 0 };
    throw e;
  }

  const blob = (r.out + '\n' + r.err).trim();
  if (NEED_AUTH.test(blob)) {
    const e = new Error('codebuddy 未授权：跑一次 cbc 后输入 /login（浏览器点一下即可）');
    e.partial = { ok: false, addedText: '', outputChars: 0 };
    throw e;
  }

  const j = extractJson(r.out);
  const text = j
    ? (typeof j.result === 'string' ? j.result : JSON.stringify(j.result ?? j))
    : (r.out.trim() || blob);

  const elapsedMs = Date.now() - t0;
  if (r.code !== 0 && !text) {
    const e = new Error('codebuddy 退出码 ' + r.code + '：' + blob.slice(-400));
    e.partial = { ok: false, addedText: '', outputChars: 0 };
    throw e;
  }

  return {
    ok: r.code === 0 || !!text,
    addedText: text,
    elapsedMs,
    outputChars: text.length,
    cost: j && (j.total_cost_usd != null || j.cost_usd != null) ? { estUsd: j.total_cost_usd ?? j.cost_usd } : null,
    usage: j && j.usage ? { in: j.usage.input_tokens, out: j.usage.output_tokens } : null,
    sessionId: j && j.session_id,
    raw: { code: r.code, stderrTail: r.err.slice(-600) },
  };
}

/** CLI 没有「当前页面」概念，回一个能力自述 */
export async function peekCodeBuddy() {
  const r = await runCli(['--version'], { timeoutMs: 60000 });
  const m = (r.out + r.err).match(/(\d+\.\d+\.\d+)/);
  return 'CodeBuddy Code CLI ' + (m ? m[1] : '?') + '（CLI 模式，无页面。用 ask 派活）';
}