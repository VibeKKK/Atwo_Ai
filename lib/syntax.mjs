// 语法闸（B）：契约只保证「有 code 字段」，保证不了「这段代码能编译」。
// 这里在交付前替调用方跑一次编译器 —— 编译不花钱，返工才花钱。
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.mjs';

// PATH 上的 python 可能是 Microsoft Store 的占位壳（运行即报 "Python was not found"），
// 所以按候选列表实测一次，记住真正能跑的那个。
// 候选清单统一由 lib/config.mjs 提供（ORCH_PYTHON 或 config.local.json 的 python 可覆盖），
// 换机器时不用再改这个文件。
const PY_CANDIDATES = [...config.pythonCandidates, 'py', 'python3', 'python'].filter(Boolean);
let PY = null;
function resolvePython() {
  if (PY) return PY;
  for (const c of PY_CANDIDATES) {
    const r = spawnSync(c, ['-c', 'print(1)'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && String(r.stdout || '').trim() === '1') { PY = c; return PY; }
  }
  PY = '';   // 一个都不行 → 语法闸对 python 跳过
  return PY;
}
const NODE = process.env.ORCH_NODE || 'node';

export function detectLang(code, hint) {
  const h = String(hint || '').toLowerCase();
  if (/^(py|python|python3)$/.test(h)) return 'python';
  if (/^(js|javascript|mjs|cjs|node)$/.test(h)) return 'javascript';
  if (/^(ts|typescript|tsx|jsx)$/.test(h)) return 'skip';   // 需要 tsc，不在本机必装范围
  const s = String(code || '');
  if (/^\s*(def |import |from .+ import |class .+:)/m.test(s) && !/\bfunction\b|=>|\bconst\b/.test(s)) return 'python';
  if (/\bfunction\b|=>|\bconst \w+ =|require\(|import .+ from /.test(s)) return 'javascript';
  if (/^\s*(#include|int main|public class)/m.test(s)) return 'skip';
  return 'skip';
}

export function checkSyntax(code, hint) {
  const src = String(code || '');
  if (!src.trim()) return { ok: true, lang: 'skip', error: '' };
  const lang = detectLang(src, hint);
  if (lang === 'skip') return { ok: true, lang, error: '' };

  const dir = mkdtempSync(join(tmpdir(), 'orch-syntax-'));
  try {
    if (lang === 'python') {
      const f = join(dir, 'snippet.py');
      writeFileSync(f, src, 'utf8');
      const py = resolvePython();
      if (!py) return { ok: true, lang, error: '', skipped: 'no-python' };
      const r = spawnSync(py, ['-c', 'import py_compile,sys;py_compile.compile(sys.argv[1],doraise=True)', f], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0) return { ok: true, lang, error: '' };
      const msg = ((r.stderr || '') + (r.stdout || '')).trim().split('\n').filter(Boolean).slice(-3).join('\n');
      return { ok: false, lang, error: msg || ('python 退出码 ' + r.status) };
    }
    // javascript
    const f = join(dir, 'snippet.mjs');
    writeFileSync(f, src, 'utf8');
    const r = spawnSync(NODE, ['--check', f], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return { ok: true, lang, error: '' };
    const msg = ((r.stderr || '') + (r.stdout || '')).trim().split('\n').filter(Boolean).slice(-3).join('\n');
    return { ok: false, lang, error: msg || ('node 退出码 ' + r.status) };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
}
