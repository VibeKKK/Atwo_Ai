// atwo diff 的落盘测试：屏幕上的结论不算产物，两份文件才��。
// 每条对着一件真事：文件没生成、JSON 结构塌了、md 少了人话标题、--out 被当成文件名。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ATWO = path.join(ROOT, 'atwo.mjs');
const FIX = path.relative(ROOT, path.join(ROOT, 'fixtures', 'div_sample.mjs')).replace(/\\/g, '/');

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-diff-'));

const r = spawnSync(process.execPath, [ATWO, 'diff', FIX, '--out', outDir], { cwd: ROOT, encoding: 'utf8' });
ok('退出码 0', r.status === 0, 'status=' + r.status + ' ' + (r.stderr || '').slice(0, 200));
ok('屏幕上说了要落盘', /已落盘/.test(r.stdout || ''), (r.stdout || '').slice(-200));

const jsonPath = path.join(outDir, 'decisions.json');
const mdPath = path.join(outDir, 'decisions.md');
ok('decisions.json 生成', fs.existsSync(jsonPath));
ok('decisions.md 生成', fs.existsSync(mdPath));

let json = null;
try { json = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { ok('JSON 能解析', false, e.message); }
ok('JSON 能解析', json !== null);
if (json) {
  ok('带 agents', Array.isArray(json.agents) && json.agents.join(',') === 'keep,clamp', JSON.stringify(json.agents));
  ok('带用例数', json.caseCount === 1, json.caseCount);
  ok('分歧被记下', json.divergenceCount >= 1, json.divergenceCount);
  ok('决策点非空', Array.isArray(json.decisions) && json.decisions.length >= 1, json.decisions && json.decisions.length);
  const d = json.decisions[0] || {};
  ok('决策点有 id 与 scope', typeof d.id === 'string' && typeof d.scope === 'string', d.id + '/' + d.scope);
  ok('每个决策点有选项', Array.isArray(d.options) && d.options.length >= 2, d.options && d.options.length);
  ok('选项带通道归属', (d.options || []).every((o) => Array.isArray(o.agents)));
  ok('带生成时间', typeof json.generatedAt === 'string' && !Number.isNaN(Date.parse(json.generatedAt)));
  ok('来源是相对路径', typeof json.source === 'string' && !path.isAbsolute(json.source), json.source);
}

if (fs.existsSync(mdPath)) {
  const md = fs.readFileSync(mdPath, 'utf8');
  ok('md 有人话标题', /^# 分歧清单/m.test(md), md.slice(0, 40));
  ok('md 写了通道名单', /keep、clamp|keep|clamp/.test(md));
  ok('md 含决策点正文', /推荐：/.test(md), '');
  ok('md 提醒可只答字母', /字母/.test(md));
}

// 默认目录必须是 _probe：写错地方等于没写。
// 但真跑一次会覆盖仓库里已有的 _probe/decisions.*，所以先备份、跑完原样还回去。
const probeJson = path.join(ROOT, '_probe', 'decisions.json');
const probeMd = path.join(ROOT, '_probe', 'decisions.md');
const backup = new Map();
for (const p of [probeJson, probeMd]) if (fs.existsSync(p)) backup.set(p, fs.readFileSync(p));

// 人话版默认落 docs/decisions/<slug>-<日期>.md —— 那是**源码目录**，不是 _probe。
// 不给 --out 跑一次就会在里面留一个未跟踪的 adhoc-YYYY-MM-DD.md，会被误提交。
// 先记下跑之前的 .md 清单，跑完只删新增的（已有的绝不动）。
const humanDirAbs = path.join(ROOT, 'docs', 'decisions');
const humanBefore = new Set(
  fs.existsSync(humanDirAbs) ? fs.readdirSync(humanDirAbs).filter((f) => f.endsWith('.md')) : [],
);

const r2 = spawnSync(process.execPath, [ATWO, 'diff', FIX], { cwd: ROOT, encoding: 'utf8' });
ok('不给 --out 时也成功', r2.status === 0, r2.status);
ok('不给 --out 时默认落 _probe', /_probe\/decisions\.(json|md)/.test(r2.stdout || ''), (r2.stdout || '').slice(-200));

for (const p of [probeJson, probeMd]) {
  if (backup.has(p)) fs.writeFileSync(p, backup.get(p));
  else fs.rmSync(p, { force: true });
}
// 人话版也还原：只删这次新冒出来的，别人手写的决策记录不动。
if (fs.existsSync(humanDirAbs)) {
  for (const f of fs.readdirSync(humanDirAbs)) {
    if (f.endsWith('.md') && !humanBefore.has(f)) fs.rmSync(path.join(humanDirAbs, f), { force: true });
  }
}

// 参数解析：--out 的值不能被当成用例文件
const r3 = spawnSync(process.execPath, [ATWO, 'diff', '--out', outDir, FIX], { cwd: ROOT, encoding: 'utf8' });
ok('--out 在前也不误判文件', r3.status === 0 && !/用例文件不存在/.test(r3.stdout || ''), (r3.stdout || '').slice(0, 200));

fs.rmSync(outDir, { recursive: true, force: true });
console.log(`atwo_diff_land: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
