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
  const { cwd, timeoutMs = 300000, env = {}, stdinData = null } = opts;
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
      // 长提示必须走 stdin：Windows 的命令行上限约 32767 字符，三份大产物拼起来的父审提示轻松超过，
      // spawn 直接抛 ENAMETOOLONG，父审一票都交不出（2026-11-17 实测三票全丢）。CLI 支持 `-p` 后不带值从 stdin 读。
      stdio: [stdinData == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (stdinData != null && child.stdin) {
      child.stdin.on('error', () => { /* 子进程提前退出时写 stdin 会 EPIPE，忽略 */ });
      child.stdin.end(String(stdinData));
    }
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
/**
 * 通道「回了一句话但这句是错误」的判据。
 *
 * 为什么要单列：通道只要 stdout 有非空字符串就会被判成功，
 * 而 `Max turns (8) exceeded`、`API Error: ...` 都是**有内容**的失败。
 * 这类字符串一旦超过落盘的体积下限（200B），就会冒充产物通过验收。
 * @param {string} text 通道原始输出或解析后的 result 字段
 * @returns {boolean} 是错误就是 true
 */
export function isChannelError(text) {
  const head = String(text || '').trim().slice(0, 120);
  if (!head) return false;
  return /^(?:max turns \(\d+\) exceeded\b|api error\b|error:|failed to\b|no response\b|request failed\b|rate limit\b)/i.test(head);
}

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
  const { timeoutMs = 300000, cwd, permissionMode = 'acceptEdits' } = opts;
  // 2026-11-15 实测（同一任务：写 40~60 行三函数模块，--tools ""）：
  //   hy4free（CLI 默认）        → 425s / 115s 仍未完成，单次调用流式吐了 9261 chunk / 3.1MB
  //   deepseek-v4.1-flash        →  14s  1352B
  //   glm-5.3-flash              →  15s
  //   minimax-m3.1-flash         →  19s  1597B
  //   hy3                        →  21s  1798B
  // 慢的真因不是网络也不是排队：421 秒里 idle 全程 0~79ms、每 10 秒稳定 +84KB，
  // 链路一直在匀速传，是 hy4free 这个推理模型自己吐了 9261 个思考 chunk。
  // 同一个任务换 flash 型号快 30 倍，产物质量相当（deepseek 那份还顺手处理了 lo>hi 交换）。
  const model = opts.model || process.env.CODEBUDDY_MODEL || 'deepseek-v4.1-flash';
  const t0 = Date.now();
  // 成本实验（2026-11-13 实测 in tokens）：
  //   --tools "default"            → 23,130
  //   --tools "Write,Edit,Read"     →  7,633   ← 默认
  //   --tools ""                    →  6,175（纯文本任务，不能改文件）
  // 系统提示里工具 schema 占大头，限制工具就砍掉 2/3 固定开销。
  // 2026-11-16 rank2：允许单次调用覆写工具集（opts 优先 > env > 默认）。
  // 动机：fanout 的父会话必须能读文件核对证据、但绝对不许改文件 —— 「父只审不干」原来只是提示词，
  // 现在靠工具权限落地。env 语义不变，不传 opts 时行为与以前完全一致。
  const tools = opts.tools !== undefined
    ? String(opts.tools)
    : (process.env.CODEBUDDY_TOOLS !== undefined ? process.env.CODEBUDDY_TOOLS : 'Write,Edit,Read');
  // 2026-11-14 改：max-turns 硬编码 1 会让「要求它思考一轮再输出」的活直接报 Max turns (1) exceeded
  // （自改项目 self.mjs 首次踩到）。改成可用 CODEBUDDY_MAX_TURNS 覆盖。
  // 2026-11-15 rank2：默认值 1 → 8。实测两个「读文件 + 分析 + 写产物」的调研任务
  // 全部只返回 21 个字符 "Max turns (1) exceeded"，且被 land 当成产物试图落盘。
  // 一轮只够一句话回答；需要读写文件、走工具的活至少 8 轮。环境变量仍可双向覆盖。
  // 2026-11-16：8 轮写不完 200 行模块（实测 #2 任务 8 轮用尽仍未收尾），提到 24。
  // 轮次上限是成本开关：每一轮都要重发 system prompt（固定 20003 字节），轮次翻三倍 ≠ 成本翻三倍，
  // 但「轮次不够导致整份产物作废」是百分之百的浪费。
  // 2026-11-16 rank2：允许单次调用覆写回合数。父审要读 N 份产物的几十个引用行，
  // 默认 10 回合一半就断在 "Max turns (10) exceeded" —— 6 片跑出 3 条假 unreviewed 的真因。
  const maxTurns = String(opts.maxTurns != null ? opts.maxTurns : (process.env.CODEBUDDY_MAX_TURNS || '10'));
  // 超过这个长度的提示不再放进命令行参数：Windows 单条命令行上限约 32767 字符，
  // 三份 2 万字产物拼成的父审提示必然超限，spawn 抛 ENAMETOOLONG 且一票都交不出。
  const STDIN_PROMPT_THRESHOLD = 16000;
  const useStdin = String(prompt).length > STDIN_PROMPT_THRESHOLD;
  const args = useStdin
    ? ['-p', '--output-format', 'json', '--tools', tools, '--no-session-persistence', '--max-turns', maxTurns]
    : ['-p', prompt, '--output-format', 'json', '--tools', tools, '--no-session-persistence', '--max-turns', maxTurns];
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);

  const r = await runCli(args, { cwd, timeoutMs, stdinData: useStdin ? prompt : null });

  if (r.spawnError) {
    const e = new Error('codebuddy 起不来：' + r.spawnError);
    e.partial = null;
    throw e;
  }
  if (r.timedOut) {
    // 2026-11-15 修：超时时 r.out 里已经有模型吐出来的东西（runCli 的 stdout 一直在累积），
    // 而这里原本把 addedText 硬编码成空串 —— 240 秒的劳动连同写好的代码一起被扔掉。
    // 实测证据：写 120 行模块那轮，日志显示已经写到第三个函数，但成品在异常里消失，
    // run json 里只剩 workbuddy 换路后的那一份，codebuddy 那份彻底没了。
    // 现在把已收到的东西挂到 e.partial 上，由 runPool 留档进 partialOutput（不判交付）。
    const j = extractJson(r.out);
    const text = String((j && (j.result || j.text)) || r.out || '');
    const e = new Error('codebuddy 超时 ' + Math.round(timeoutMs / 1000) + 's');
    e.partial = { ok: false, addedText: text, outputChars: text.length, truncated: true, elapsedMs: Date.now() - t0 };
    throw e;
  }

  const blob = (r.out + '\n' + r.err).trim();
  if (NEED_AUTH.test(blob)) {
    const e = new Error('codebuddy 未授权：跑一次 cbc 后输入 /login（浏览器点一下即可）');
    e.partial = { ok: false, addedText: '', outputChars: 0 };
    throw e;
  }

  // 2026-11-16 修：通道自己报错时不能当成功。
  // 实测：`--max-turns 8` 用尽后 CLI 的 result 字段就是一句 `Max turns (8) exceeded`（21 字符），
  // 被当成正常产出落盘 —— land 因为「22B < 200B」拦下了这次，但那是运气不是设计：
  // 任何超过 200 字节的错误文案都能一路通过落盘和验收，而验收器只查行数与语法，
  // 查不出「这根本不是代码」。判据必须落在通道层，不能指望下游体积检查。
  if (isChannelError(blob)) {
    const e = new Error('codebuddy 通道报错：' + blob.slice(0, 200));
    e.partial = { ok: false, addedText: '', outputChars: 0 };
    throw e;
  }

  const j = extractJson(r.out);
  const text = j
    ? (typeof j.result === 'string' ? j.result : JSON.stringify(j.result ?? j))
    : (r.out.trim() || blob);

  if (isChannelError(text)) {
    const e = new Error('codebuddy 通道报错：' + text.slice(0, 200));
    e.partial = { ok: false, addedText: '', outputChars: 0 };
    throw e;
  }

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