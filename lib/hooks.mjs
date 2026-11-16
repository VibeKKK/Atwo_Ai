// file: lib/hooks.mjs
// git 钩子：把闸门装成「不跑就提不上去」。
//
// 为什么要有这个：全仓没有 CI（没有 .github），闸门靠人记得敲 —— 而「记得敲」在实测里
// 是不成立的（今天早上 vm/judge.mjs 被整段回答覆写，就是从没人跑闸门那段窗口里过去的）。
// 钩子是唯一不需要「想起来」的执行点：git 自己会调。
//
// 为什么是 pre-commit 而不是只 pre-push：这个仓库**没有远端**，pre-push 永不触发 ——
// 装一个不会跑的钩子等于自我安慰。pre-commit 每次提交都跑，代价是 gate --no-tests 约 9 秒
// （完整的 170 秒测试留给 atwo done 的闸门，不塞进每次提交）。
//
// 三条硬约束：
//   1. 钩子失败必须给出可执行的下一步，不是甩一句「gate failed」；
//   2. 允许 --no-verify 绕过 —— 但钩子脚本自己就写明怎么绕过、绕过意味着什么；
//   3. 必须能重装、能查状态、能卸掉，否则换台机器/重建 clone 就静默失效。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const HOOKS = ['pre-commit', 'pre-push'];
export const MARKER = '# atwo-gate-hook v1';
/** 钩子脚本正文。用 sh 而不是 node：git 在 Windows 上也用自带 sh 跑钩子，不依赖 node 在 PATH。 */
export function hookBody(name) {
  const stage = name === 'pre-push' ? 'push' : 'commit';
  const L = [
    '#!/bin/sh',
    MARKER,
    '# 由 atwo hooks install 生成，别手改（重装会覆盖）。卸掉：node atwo.mjs hooks remove',
    '# 这个钩子拦的是「没有过闸门的提交」。急用可以 git ' + stage + ' --no-verify 绕过，',
    '# 绕过之前先确认知道自己在放过什么：gate 查闭包、语法、契约、参考向量、污染、验收。',
    '',
    'if [ ! -f atwo.mjs ]; then',
    '  echo "[atwo] 不在仓库根，跳过闸门（钩子装错位置请重装）" >&2',
    '  exit 0',
    'fi',
    '',
    'echo "[atwo] 过闸门：node atwo.mjs gate --no-tests（约 9 秒；急用 git ' + stage + ' --no-verify 绕过）" >&2',
    'if node atwo.mjs gate --no-tests > /tmp/atwo-gate.out 2>&1; then',
    '  tail -n 3 /tmp/atwo-gate.out >&2',
    '  exit 0',
    'fi',
    'echo "[atwo] 闸门没过，这次 ' + stage + ' 被拦下。原因：" >&2',
    'tail -n 30 /tmp/atwo-gate.out >&2',
    'echo "" >&2',
    'echo "[atwo] 下一步：node atwo.mjs gate --no-tests 先在本机看全量，修完再提。" >&2',
    'echo "[atwo] 确认是误报才绕过：git ' + stage + ' --no-verify（会在审计里留空档）" >&2',
    'exit 1',
    '',
  ];
  return L.join('\n');
}
function hooksDir(cwd) {
  // 支持 worktree：.git 可能是个文件，指向真正的 git 目录
  const gitPath = path.join(cwd, '.git');
  if (!fs.existsSync(gitPath)) return null;
  const st = fs.statSync(gitPath);
  if (st.isDirectory()) return path.join(gitPath, 'hooks');
  const txt = fs.readFileSync(gitPath, 'utf8').trim();
  const m = /^gitdir:\s*(.+)$/i.exec(txt);
  if (!m) return null;
  return path.join(path.resolve(cwd, m[1].trim()), 'hooks');
}

/** 装钩子。已存在且不是我们装的 → 默认不覆盖（别人的钩子不该被静默顶掉）。 */
export function installHooks({ cwd = process.cwd(), force = false } = {}) {
  const dir = hooksDir(cwd);
  if (!dir) return { ok: false, installed: [], skipped: [{ name: '*', reason: '这里不是 git 仓库（找不到 .git）' }], dir: null };
  fs.mkdirSync(dir, { recursive: true });
  const installed = [];
  const skipped = [];
  for (const name of HOOKS) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      const cur = fs.readFileSync(p, 'utf8');
      if (!cur.includes(MARKER) && !force) {
        skipped.push({ name, reason: '已存在一个不是 atwo 装的钩子' });
        continue;
      }
    }
    fs.writeFileSync(p, hookBody(name), { mode: 0o755 });
    try { fs.chmodSync(p, 0o755); } catch (e) { void e; }
    installed.push(name);
  }
  return { ok: installed.length > 0, installed, skipped, dir };
}

/** 查状态：每个钩子在不在、是不是 atwo 装的。 */
export function hookStatus({ cwd = process.cwd() } = {}) {
  const dir = hooksDir(cwd);
  if (!dir) return { dir: null, hooks: [] };
  const hooks = HOOKS.map((name) => {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) return { name, state: 'missing' };
    const ours = fs.readFileSync(p, 'utf8').includes(MARKER);
    return { name, state: ours ? 'installed' : 'foreign' };
  });
  return { dir, hooks };
}

/** 卸掉（只卸我们装的）。 */
export function removeHooks({ cwd = process.cwd() } = {}) {
  const dir = hooksDir(cwd);
  if (!dir) return { removed: [], kept: [] };
  const removed = [];
  const kept = [];
  for (const name of HOOKS) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    if (fs.readFileSync(p, 'utf8').includes(MARKER)) { fs.rmSync(p); removed.push(name); }
    else kept.push(name);
  }
  return { removed, kept };
}

export function formatHookStatus(st) {
  if (!st.dir) return '不是 git 仓库，没有钩子目录。';
  const word = { installed: '已装', missing: '未装', foreign: '别人的（不是 atwo 装的）' };
  const lines = ['钩子目录：' + st.dir];
  for (const h of st.hooks) lines.push('  ' + h.name + '：' + word[h.state]);
  if (st.hooks.every((h) => h.state === 'missing')) lines.push('装：node atwo.mjs hooks install（每次提交前跑 gate --no-tests，约 9 秒）');
  return lines.join('\n');
}

export function formatInstall(res) {
  if (!res.dir) return '不是 git 仓库，不装钩子。';
  const lines = [];
  if (res.installed.length) lines.push('已装：' + res.installed.join(' / ') + '（每次触发时跑 gate --no-tests）');
  for (const s of res.skipped) lines.push('跳过 ' + s.name + '：' + s.reason + '（确实要覆盖加 --force）');
  if (!lines.length) lines.push('没有变化。');
  return lines.join('\n');
}
