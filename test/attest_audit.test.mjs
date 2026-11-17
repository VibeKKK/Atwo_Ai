// 凭证审计（auditAttestations / formatAudit / atwo attest）：确认「过了就是过了」能被复查。
// 只跑纯函数 + 两次真实 CLI 调用，不碰网络、不改仓库文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditAttestations, formatAudit, makeAcceptAttestation } from '../lib/accept-attest.mjs';

const HERE = path.resolve(import.meta.dirname, '..');
const ATWO = path.join(HERE, 'atwo.mjs');

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed += 1; }
};
const eq = (a, b, why) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${why || ''} 期望 ${B}，实际 ${A}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-audit-'));
const f = path.join(tmp, 'a.mjs');
fs.writeFileSync(f, 'export const a = 1;\n', 'utf8');
const good = makeAcceptAttestation({ task: 'demo', file: f, acceptExit: 0, now: '2026-11-16T00:00:00.000Z' });

// —— 一、单条凭证的三种命运 ——
t('没动过 → ok', () => {
  const r = auditAttestations([good], { cwd: HERE });
  eq(r.checked, 1, '份数');
  eq(r.failed.length, 0, '失效数');
  eq(r.ok, true, '整体');
});
t('文件内容变了 → 必须抓到', () => {
  const bad = { ...good, digest: 'deadbeef' };
  const r = auditAttestations([bad], { cwd: HERE });
  eq(r.ok, false, '整体');
  eq(r.failed.length, 1, '失效数');
});
t('文件被删 → file-missing', () => {
  const gone = path.join(tmp, 'gone.mjs');
  fs.writeFileSync(gone, 'export const b = 2;\n', 'utf8');
  const att = makeAcceptAttestation({ task: 'demo', file: gone, acceptExit: 0 });
  fs.unlinkSync(gone);
  const r = auditAttestations([att], { cwd: HERE });
  eq(r.ok, false, '整体');
  eq(r.failed[0].reason, 'file-missing', '理由');
});

// —— 二、按任务归类 ——
t('byTask 按任务分开计数（含失效）', () => {
  const bad = { ...good, digest: 'x' };
  const other = makeAcceptAttestation({ task: 'other', file: f, acceptExit: 0 });
  const r = auditAttestations([good, bad, other], { cwd: HERE });
  eq(r.byTask.demo, { total: 2, ok: 1, bad: 1 }, 'demo');
  eq(r.byTask.other, { total: 1, ok: 1, bad: 0 }, 'other');
});
t('空账本 → ok 且 0 份（不是 NaN）', () => {
  const r = auditAttestations([], { cwd: HERE });
  eq(r.checked, 0, '份数');
  eq(r.ok, true, '整体');
});

// —— 三、人话报告 ——
t('报告含总数与失效清单', () => {
  const bad = { ...good, digest: 'x' };
  const txt = formatAudit(auditAttestations([good, bad], { cwd: HERE }));
  if (!txt.includes('共 2 份')) throw new Error('缺总数：' + txt);
  if (!txt.includes('失效清单')) throw new Error('缺失效清单：' + txt);
});
t('全通时报告说「全部可复算」', () => {
  const txt = formatAudit(auditAttestations([good], { cwd: HERE }));
  if (!txt.includes('全部可复算')) throw new Error('措辞不对：' + txt);
});

// —— 四、CLI 语义：审计通过 → 0；有失效 → 4 ——
t('atwo attest 的退出码与失效数一致', () => {
  const p = spawnSync(process.execPath, [ATWO, 'attest', '--json'], { cwd: HERE, encoding: 'utf8' });
  const j = JSON.parse(p.stdout);
  const bad = (j.data.attest.files.failed || []).length + (j.data.attest.judge.bad || []).length;
  eq(j.exitCode, bad ? 4 : 0, 'JSON 里的退出码');
  eq(p.status, bad ? 4 : 0, '真实退出码');
  eq(j.ok, bad === 0, 'ok');
});
t('审计不会改动账本文件', () => {
  const ledger = path.join(HERE, 'memory', 'attest.jsonl');
  const before = fs.existsSync(ledger) ? fs.statSync(ledger).size : -1;
  spawnSync(process.execPath, [ATWO, 'attest'], { cwd: HERE });
  const after = fs.existsSync(ledger) ? fs.statSync(ledger).size : -1;
  eq(after, before, '文件大小');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nattest_audit: ${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
