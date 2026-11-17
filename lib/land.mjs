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
// 2026-11-16 加 vm：三值虚拟机的四层产物都在 vm/ 下。这个白名单每加一个新目录都要改，// 而这次的症状是「AI 交了 15115 字节的完整代码，账本记 done、却一个字没落盘」——// detectTarget 匹配不到 vm/ 就返回空，planLanding 于是报『没有识别出目标路径』。// 宁可放宽一点，也不要让产物在路上凭空消失。
const ALLOWED_ROOTS = ['lib', 'docs', 'agents', 'eval', 'collab', 'memory', 'tools', 'vm', 'test', 'packages', 'atw', '_probe', '.swarm'];
/** 允许落盘的扩展名 */
// 2026-11-16 放宽：实测 codebuddy 交了完整代码却被「扩展名不在白名单：.js」拦在门外，
// 症状与之前 vm/ 那次一样——产物在路上凭空消失。宁可放宽一点。
const ALLOWED_EXT = ['.mjs', '.js', '.ts', '.py', '.md', '.json', '.jsonl', '.cjs', '.txt', '.yaml', '.yml'];
/** 目标路径的正则：先说目录，再说文件名，避免把正文里的「lib/dag.mjs」误判成唯一目标 */
const TARGET_RE = /((?:lib|docs|agents|eval|collab|memory|tools|vm|test|packages|atw)\/[A-Za-z0-9_.\/-]+\.(?:mjs|cjs|js|md|json|txt|ya?ml))/;

/** 从契约 JSON 里拿 code；拿不到就退回围栏；再退回全文。 */

/**
 * 剥掉「契约 JSON」的外壳，露出里面的正文。
 *
 * 为什么要单独剥一层：codebuddy 这类通道会把回答包成 {"answer": "...", "notes": [...]}，
 * 而落盘器只认 code/content/implementation 三个键 —— 于是整段 JSON 被当成代码写进 .mjs，
 * 语法闸到那一刻才炸（2026-11-17 实测：一个 589 字节的 lib/zz_probe_add.mjs 里躺着 JSON）。
 * 剥壳放在落盘入口做，splitByFileMarker 与 extractCode 才都能看到真正的正文。
 */
export function unwrapEnvelope(raw) {
  const s = String(raw == null ? '' : raw);
  const trimmed = s.trim();
  if (!trimmed.startsWith('{')) return s;
  let obj = null;
  try { obj = JSON.parse(trimmed); } catch { return s; }
  if (!obj || typeof obj !== 'object') return s;
  // 只认「字符串型正文」的键，且必须非空：空字符串当正文等于把产物清空，比不剥更糟。
  for (const k of ['answer', 'text', 'body', 'content', 'code', 'implementation']) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return s;
}

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

/**
 * 一次输出里交多个文件：靠 `// file: <path>` 行切段。
 *
 * 为什么需要（2026-11-16 实测）：doubao 一次交了 vm/compiler.mjs + vm/judge.mjs +
 * test/judge.behavior.mjs 三个文件、共 18KB，质量很高（它甚至自己写了适配解释器
 * 并注明「等 machine 支持 0x0C 后两者语义必须一致」）。但输出里没有围栏、没有契约 JSON，
 * 只有三个 `// file:` 标记 —— 旧逻辑把这三段当成一个文件全塞进第一段的目标里，
 * 另外两个文件凭空消失，而账本记的是 done。
 *
 * 少于两个标记就返回 null（单文件输出仍然走原路径，不要给它加复杂度）。
 */
/**
 * 剥掉代码段首尾的围栏与空行。
 *
 * 为什么必须有：AI 交「多文件」时的实际形态是
 *   // file: vm/logic.mjs
 *   ```js
 *   <code>
 *   ```
 *   // file: test/x.behavior.mjs
 *   ```js
 *   ...
 * splitByFileMarker 按 `// file:` 切片后，每段首尾都带着围栏行；
 * 只去空行不够 —— 落盘后 `node --check` 会报
 *   SyntaxError: Unexpected identifier 'js'
 * 而账本记 done、字节数也不算小，看起来像「产物质量差」，其实是落盘没洗干净。
 */
export function stripFence(s) {
  const lines = String(s || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && (/^\s*$/.test(lines[0]) || /^\s*```/.test(lines[0]))) lines.shift();
  while (lines.length && (/^\s*$/.test(lines[lines.length - 1]) || /^\s*```/.test(lines[lines.length - 1]))) lines.pop();
  return lines.join('\n');
}
export function splitByFileMarker(raw) {
  const s = String(raw || '');
  // 契约（本土化）：交付内容里写明要写到哪个文件，落盘就只认它，不再从任务文本猜路径。
  // 认得的写法 —— 国际版 / markdown 三连 / 中文冒号都收：
  //   // file: lib/a.mjs      # file: lib/a.mjs      /* file: lib/a.mjs */
  //   === FILE: lib/a.mjs ===   --- FILE: lib/a.mjs ---   ### FILE: lib/a.mjs
  //   文件：lib/a.mjs           文件: lib/a.mjs           路径：lib/a.mjs
  // 认任何扩展名：不认识的交给 safeTarget 明确拒绝（报「扩展名不在白名单」），
  // 而不是解析失败后回退去猜路径 —— 回退猜测会把 .exe 这类块头悄悄变成写错文件。
  const EXT = '\\w{1,6}';
  const re = new RegExp(
    '^[ \\t]*(?:' +
      '\\/\\/[ \\t]*file[ \\t]*[:：]' +          // // file:
      '|#[ \\t]*file[ \\t]*[:：]' +                    // # file:
      '|\\/\\*[ \\t]*file[ \\t]*[:：]' +           // /* file:
      '|={2,}[ \\t]*file[ \\t]*[:：]' +                // === FILE:
      '|-{3,}[ \\t]*file[ \\t]*[:：]' +                // --- FILE:
      '|#{1,6}[ \\t]*file[ \\t]*[:：]' +               // ### FILE:
      '|文件[ \\t]*[:：]' +                              // 文件：
      '|路径[ \\t]*[:：]' +                              // 路径：
    ')[ \\t]*([A-Za-z0-9_.\\/-]+\\.(?:' + EXT + '))[ \\t]*(?:\\*\\/|={2,}|-{3,})?[ \\t]*$',
    'gmi'
  );
  const marks = [...s.matchAll(re)];
  if (!marks.length) return null;   // 没有显式契约 → 交给 detectTarget，但在报告里标 guessed
  return marks.map((m, i) => ({
    target: m[1].replace(/\\/g, '/'),
    code: s.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : s.length)
      .replace(/^\s*\n/, ''),
  })).map((x) => ({ target: x.target, code: stripFence(x.code) })).filter((x) => x.code.trim());
}

/** 认目标路径：契约 target 优先 → 任务文本 → summary */
export function detectTarget(text, parsed) {
  // 2026-11-16：任务文本里同时提到「交付物 lib/x.mjs」和「数据文件 memory/log.jsonl」时，
  // 正则先命中的是后者 —— 实测把 3858 字节的库写成了 memory/log.js（数据文件被当成交付物）。
  // 数据文件不是交付物：.jsonl 一律不认，继续找下一个候选。
  const pick = (v) => { const t = norm(v); return /.jsonl$/i.test(t) ? "" : t; };
  if (parsed && parsed.target) { const t = pick(parsed.target); if (t) return t; }
  const fromTask = String(text || '').match(TARGET_RE);
  if (fromTask) { const t = pick(fromTask[1]); if (t) return t; }
  if (parsed && parsed.summary) {
    const fromSummary = String(parsed.summary).match(TARGET_RE);
    if (fromSummary) { const t = pick(fromSummary[1]); if (t) return t; }
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
/**
 * 多路同题写时的落盘分叉：lib/a.mjs + trae → lib/a.trae.mjs
 *
 * 为什么必须分叉：同题多写的 N 份产物都想写同一个路径，先到的占住，
 * 后到的会被 applyLanding 判 need-force 直接丢掉。实测证据（2026-11-15）：
 * 豆包跑了 150.3 秒、写出 4772 字节、status=done，land 却报
 * need-force 拒绝覆盖 → 产物一行没进磁盘，等于白跑。
 * 「一起写」这条路卡的不是模型，是落盘只认一个格子。
 * 分叉之后每一路都能落盘，再由程序（accept）+ 异源评审 + 人 来挑。
 */
export function laneTarget(target, agent) {
  const v = String(target || '');
  const ag = String(agent || '').trim().toLowerCase();
  if (!v || !ag) return v;
  const m = v.match(/^(.*?)(\.[A-Za-z0-9]+)$/);
  if (!m) return v + '.' + ag;
  // 已经有自己的后缀就别叠两层：lib/x.trae.mjs + trae 必须原样返回。
  // 第一版拿 m[2].slice(1) 判，m[2] 永远是 '.mjs'，于是叠成 x.trae.trae.mjs。
  if (m[1].toLowerCase().endsWith('.' + ag)) return v;
  return m[1] + '.' + ag + m[2];
}


/**
 * 判「这个目标是不是 AI 自己用文件工具写出来的」。
 *
 * 2026-11-16 修的洞，附实测：codebuddy 有 Write 工具，它会把产物直接写进磁盘，
 * 而回归到回答通道的内容是空的。于是 planLanding 判「内容太短（0B < 200B）」→
 * 账本记落盘 0/验收 0/评审不跑，可磁盘上躺着完整产物。
 * 实测那次：学术评估任务 4 路派活，产物 252 行 13813 字节在 docs/academic-review.md，
 * 账本却是「落盘 0/4、验收 0/1、没有可评审的落盘产物」。货是真的，账是假的。
 *
 * 判据只看两件可核对的事：路径认得出来 + 该文件在本次派活开始**之后**被写过。
 * 不看通道的自我报告 —— 它正是不可信的那一方。
 */
export function selfLanded(target, sinceMs, opts = {}) {
  const minBytes = Number(opts.minBytes || 200);
  if (!target) return null;
  const abs = path.resolve(process.cwd(), String(target));
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size < minBytes) return null;
    if (st.mtimeMs < Number(sinceMs) - 2000) return null;
    return { path: String(target), size: st.size, mtimeMs: st.mtimeMs };
  } catch { return null; }
}
export function planLanding(results, opts = {}) {
  const minBytes = Number(opts.minBytes || 200);
  const plan = [];
  const claimed = new Map();   // 目标路径 → 已有任务 id（互斥检查，防两个任务写同一文件互相覆盖）

  for (const r of results || []) {
    const item = { id: r.id, agent: r.agent, target: '', action: 'skip', bytes: 0, reason: '', content: '', summary: '', source: '' };
    if (r.status !== 'done') { item.reason = '任务失败：' + String(r.error || '').slice(0, 80); plan.push(item); continue; }

    // 多文件输出优先：一个通道一次交三个模块是常态，按 // file: 切段，别让后两个凭空消失。
    // 先剥契约外壳：不剥的话整段 JSON 会被当成代码写进目标文件（2026-11-17 实测事故）。
    const outText = unwrapEnvelope(r.output);
    const multi = r.status === 'done' ? splitByFileMarker(outText) : null;
    // 2026-11-16：以前要求 ≥2 段才走多文件分支，一段显式 FILE: 会被当成「没写」继续猜路径，
    // 结果昨天 3858 字节的库被写成了 memory/log.js。显式契约哪怕只有一段也必须独占。
    if (multi && multi.length >= 1) {
      for (const seg of multi) {
        const sub = { id: r.id, agent: r.agent, target: '', action: 'skip', bytes: 0, reason: '', content: '', summary: '', source: 'multifile' };
        const safeSeg = safeTarget(seg.target);
        sub.target = seg.target;
        sub.content = seg.code;
        sub.bytes = Buffer.byteLength(seg.code || '', 'utf8');
        if (!safeSeg.ok) { sub.reason = safeSeg.why; plan.push(sub); continue; }
        if (sub.bytes < minBytes) { sub.reason = '内容太短（' + sub.bytes + 'B < ' + minBytes + 'B）'; plan.push(sub); continue; }
        if (claimed.has(seg.target)) { sub.reason = '与 #' + claimed.get(seg.target) + ' 目标路径相同'; plan.push(sub); continue; }
        claimed.set(seg.target, r.id);
        sub.action = fs.existsSync(path.join(process.cwd(), seg.target)) ? 'overwrite' : 'create';
        plan.push(sub);
      }
      continue;
    }

    const parsed = extractCode(outText);
    // laneSuffix 为真 = 这批是同题多写：每条通道写自己的分叉路径，不互相抢同一格。
    // 用 r.lane（派活时指定的那一路）而不是 r.agent（真正交活的那一路）：
    // 换路会把 agent 改写成替补通道，若按 agent 命名，codebuddy lane 换到 workbuddy 后
    // 会和 workbuddy 自己的 lane 撞同一格 → 四路变三路，其中一份被静默覆盖。
    const laneName = r.lane || r.agent;
    // source 标记来源：guessed = 从任务文本猜的（本次改动的起因），显式契约不会走到这里
    const target = opts.laneSuffix ? laneTarget(detectTarget(r.text, parsed), laneName) : detectTarget(r.text, parsed);
    item.target = target;
    item.content = parsed.code;
    item.bytes = Buffer.byteLength(parsed.code || '', 'utf8');
    item.summary = parsed.summary;
    item.source = parsed.source || 'guessed';

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
