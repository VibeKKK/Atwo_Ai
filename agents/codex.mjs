// agents/codex.mjs —— Codex CLI 通道（codex exec 非交互模式）。
//
// 现状（2026-11-16 实测）：CLI 存在（codex-cli 0.163.0），但本机跑不起来：
//   Error: failed to initialize in-process app-server client: 拒绝访问。 (os error 5)
//   连同 WARNING: proceeding, even though we could not create PATH aliases（写 ~/.codex/tmp/arg0-windows 被拒）
// 因此本通道默认 probe 判不可用，编队自动跳过。代码保留，等环境修好即可用。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CLI = process.env.CODEX_CLI || 'D:\\code app\\ai code\\Codex\\bin\\codex.exe';

export const meta = {
  name: 'codex',
  kind: 'cli-agent',
  transport: 'cli',
  port: 'stdin',
  strengths: ['整仓改造', '可 review 子命令', '独立供应商'],
  costModel: 'OpenAI 账号额度',
  quality: 'high',
  knownBroken: '本机 app-server 初始化被拒（os error 5），probe 会判不可用',
};

export function probeCodex() {
  if (!fs.existsSync(CLI)) return { lane: 'codex', available: false, reason: 'CLI 不存在：' + CLI };
  return { lane: 'codex', available: true, cli: CLI, unverified: true, note: 'CLI 在，但 app-server 可能起不来；真调用失败会回落' };
}

/** 深探测：真发一次极短任务。换机器时用它判 codex 到底能不能用（本机已知不行，别浪费 20s）。 */
export async function deepProbeCodex(timeoutMs = 25000) {
  const r = await askCodex('只回两个字：好', { timeoutMs: timeoutMs - 2000 });
  return { lane: 'codex', available: !!r.ok, reason: r.ok ? '' : (r.error || '调用失败'), ms: r.elapsedMs };
}

/** codex exec 的输出是分段散文，末尾一段才是答案；取最后一整段。 */
export function extractCodexAnswer(stdout) {
  const s = String(stdout || '');
  const m = s.split(/\n\s*\n(?=(?:codex|assistant)\b)/i);
  const tail = (m.length > 1 ? m[m.length - 1] : s).trim();
  return tail || s.trim();
}

export async function askCodex(prompt, opts = {}) {
  const { cwd = process.cwd(), timeoutMs = 240000 } = opts;
  const t0 = Date.now();
  if (!fs.existsSync(CLI)) return { ok: false, error: 'codex CLI 不存在：' + CLI, addedText: '', elapsedMs: 0 };
  return new Promise((resolve) => {
    const args = ['exec', '--skip-git-repo-check', '-c', 'model_reasoning_effort="low"', '-'];
    const child = spawn(CLI, args, { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve({ elapsedMs: Date.now() - t0, ...r }); } };
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => finish({ ok: false, error: String(e && e.message || e), addedText: '' }));
    child.on('close', (code) => {
      const text = extractCodexAnswer(out);
      const broken = /app-server client|os error 5|拒绝访问/.test(err + out);
      finish({ ok: code === 0 && !!text.trim() && !broken, addedText: broken ? '' : text, exitCode: code, stderr: err.slice(-500), error: broken ? 'app-server 初始化被拒（os error 5）' : (code === 0 ? null : 'exit ' + code) });
    });
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, timedOut: true, error: 'timeout ' + timeoutMs + 'ms', addedText: '' }); }, timeoutMs);
    child.on('close', () => clearTimeout(timer));
    try { child.stdin.end(String(prompt || '')); } catch {}
  });
}

export const ask = askCodex;
