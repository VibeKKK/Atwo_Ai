// 产出落盘（阶段 1 · 第一件）：把 agent 的输出变回磁盘上的文件。
//
// 为什么需要它：swarm 只负责「拿到文本」，不负责「变成文件」。
// 昨晚自举 7 个任务，6 个成功却没一个落地 —— 我是用手写脚本 _probe/land.cjs 从
// .swarm/<run>/<id>.json 的 output 字段里捞出来再写的。那一步必须自动化，
// 否则「跑完好像啥也没有」会一直是这个工具最大的体验缺陷。
//
// 核心难点不是写文件，是**认得出该写到哪、该写哪一段**：
//   - agent 的 output 有三种形态：契约 JSON（含 summary/code）、markdown 围栏、裸文本
//   - 目标路径可能写在任务文本里、写在契约的 target 字段里、或只在 summary 里提一句
// 所以这里把「识别」和「写入」拆成两步：先 plan（可预览、可 diff），再 apply（真正写盘）。

import fs from 'node:fs';
import path from 'node:path';

/** 允许落盘的目录白名单：防止任务文本里一个手滑的相对路径写到仓库外面去 */
const ALLOWED_ROOTS = ['lib', 'docs', 'agents', 'eval', 'collab', 'memory', 'tools', '_probe', '.swarm'];
/** 允许落盘的扩展名 */
const ALLOWED_EXT = ['.mjs', '.md', '.json', '.cjs', '.txt', '.yaml', '.yml'];
/** 目标路径的正则：先说目录，再说文件名，避免把正文里的「lib/dag.mjs」误判成唯一目标 */
const TARGET_RE = /((?:lib|docs|agents|eval|collab|memory|tools)\/[A-Za-z0-9_.\/-]+\.(?:mjs|cjs|js|md|json|txt|ya?ml))/;

/** 从契约 JSON 里拿 code；拿不到就退回围栏；再退回全文。 */
export function extractCode(raw) {
  const s = String(raw || '');
  if (!s.trim()) return { code: '', source: 'empty', summary: '', target: '', notes: '' };

  // 形态 1：契约 JSON（codebuddy 走这条）
  let obj = null;
  const trimmed = s.trim();
  if (trimmed.startsWith('{')) {
    try { obj = JSON.parse(trimmed); } catch { obj = null; }
  }
  if (obj && typeof obj === 'object') {
    const code = obj.code || obj.content || obj.implementation || '';
    if (code) {
      return {
        code: String(code),
        source: 'contract',
        summary: String(obj.summary || ''),
        target: String(obj.target || obj.path || obj.file || ''),
        notes: String(obj.notes || ''),
      };
    }
  }

  // 形态 2：markdown 围栏（trae / workbuddy 走这条）
  const m = s.match(/\`\`\`[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)\`\`\`/);
  if (m && m[1].trim()) return { code: m[1], source: 'fence', summary: '', target: '', notes: '' };

  // 形态 3：裸文本（只在明显是代码/文档时接受）
  return { code: s, source: 'raw', summary: '', target: '', notes: '' };
}

/** 认目标路径：契约 target 优先 → 任务文本 → summary */
export function detectTarget(text, parsed) {
  if (parsed && parsed.target) return norm(parsed.target);
  const fromTask = String(text || '').match(TARGET_RE);
  if (fromTask) return norm(fromTask[1]);
  if (parsed && parsed.summary) {
    const fromSummary = String(parsed.summary).match(TARGET_RE);
    if (fromSummary) return norm(fromSummary[1]);
  }
  const fromOut = String((parsed && parsed.code) || '').slice(0, 300).match(TARGET_RE);
  if (fromOut) return norm(fromOut[1]);
  return '';
}

function norm(p) {
  const v = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  return v;
}

/** 安全检查：目录白名单 + 扩展名白名单 + 不许 .. */
export function safeTarget(target) {
  if (!target) return { ok: false, why: '没有识别出目标路径' };
  if (target.includes('..')) return { ok: false, why: '路径含 ..（拒绝越界写入）' };
  if (path.isAbsolute(target)) return { ok: false, why: '只接受仓库内相对路径' };
  const top = target.split('/')[0];
  if (!ALLOWED_ROOTS.includes(top)) return { ok: false, why: '目录不在白名单：' + top };
  const ext = path.extname(target).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return { ok: false, why: '扩展名不在白名单：' + ext };
  return { ok: true, why: '' };
}

/**
 * 生成落盘计划（不写盘）。
 * 返回 [{ id, agent, target, action, bytes, reason, content, summary, source }]
 *   action: create（新文件）| overwrite（覆盖，需 --force）| skip（跳过）
 */
export function planLanding(results, opts = {}) {
  const minBytes = Number(opts.minBytes || 200);
  const plan = [];
  const claimed = new Map();   // 目标路径 → 已有任务 id（互斥检查，防两个任务写同一文件互相覆盖）

  for (const r of results || []) {
    const item = { id: r.id, agent: r.agent, target: '', action: 'skip', bytes: 0, reason: '', content: '', summary: '', source: '' };
    if (r.status !== 'done') { item.reason = '任务失败：' + String(r.error || '').slice(0, 80); plan.push(item); continue; }

    const parsed = extractCode(r.output);
    const target = detectTarget(r.text, parsed);
    item.target = target;
    item.content = parsed.code;
    item.bytes = Buffer.byteLength(parsed.code || '', 'utf8');
    item.summary = parsed.summary;
    item.source = parsed.source;

    if (!target) { item.reason = '没有识别出目标路径（任务文本里没写 lib/xxx.mjs 这类路径）'; plan.push(item); continue; }
    const safe = safeTarget(target);
    if (!safe.ok) { item.reason = safe.why; plan.push(item); continue; }
    if (item.bytes < minBytes) { item.reason = '内容太短（' + item.bytes + 'B < ' + minBytes + 'B），可能是残答'; plan.push(item); continue; }
    if (claimed.has(target)) { item.reason = '与 #' + claimed.get(target) + ' 目标路径相同（拒绝互相覆盖）'; plan.push(item); continue; }

    claimed.set(target, r.id);
    item.action = fs.existsSync(path.join(process.cwd(), target)) ? 'overwrite' : 'create';
    plan.push(item);
  }
  return plan;
}

/** 真正写盘。dryRun 只回报不动作；没有 force 就不覆盖。 */
export function applyLanding(plan, opts = {}) {
  const { dryRun = false, force = false } = opts;
  const done = [];
  for (const item of plan) {
    if (item.action === 'skip') { done.push({ ...item, result: 'skipped' }); continue; }
    if (item.action === 'overwrite' && !force) { done.push({ ...item, result: 'need-force' }); continue; }
    if (dryRun) { done.push({ ...item, result: 'dry' }); continue; }
    try {
      fs.mkdirSync(path.dirname(path.join(process.cwd(), item.target)), { recursive: true });
      const body = String(item.content || '').replace(/\s+$/, '') + '\n';
      fs.writeFileSync(path.join(process.cwd(), item.target), body, 'utf8');
      done.push({ ...item, result: 'written' });
    } catch (e) {
      done.push({ ...item, result: 'error', reason: String((e && e.message) || e).slice(0, 160) });
    }
  }
  return done;
}

/** 给终端看的对齐表 */
export function renderPlan(plan) {
  const rows = plan.map((p) => {
    const tag = p.action === 'skip' ? '·  跳过' : (p.action === 'create' ? '+  新建' : '~  覆盖');
    const tgt = (p.target || '(无目标)').padEnd(24);
    const sz = String(p.bytes).padStart(6);
    return '  ' + tag + ' #' + String(p.id).padEnd(2) + ' ' + tgt + sz + 'B  ' + (p.reason || (p.source === 'contract' ? '契约 code' : p.source === 'fence' ? '围栏代码' : '裸文本'));
  });
  return rows.join(String.fromCharCode(10));
}
