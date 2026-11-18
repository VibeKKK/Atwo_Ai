// 契约冻结：这条测试的唯一职责是「增删动词必须有人签字」。
// 它不测功能对不对（那由各功能测试负责），只测「接口有没有偷偷变形」。
// 改这里之前先写一条 docs/decisions/ 文档——见 docs/ATWO-CONTRACT.md。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { VERBS } from '../lib/cli-spec.mjs';
import { readHealthFromLog } from '../lib/lane-health.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok ' + name); return; }
  fail += 1;
  failures.push(name);
  console.log('  FAIL ' + name);
}

// 2026-11-19 冻结的 37 个动词。增一个减一个都会红——这是「只修不增」的机械实现。
const FROZEN = [
  'army', 'attest', 'batch', 'blind', 'board', 'check', 'cost', 'diff', 'doctor', 'done',
  'drain', 'edit', 'fanout', 'gate', 'go', 'health', 'hooks', 'judge', 'mode', 'models',
  'new', 'patch', 'pitfall', 'pool', 'queue', 'raw', 'review', 'score', 'selfcheck',
  'should', 'snapshot', 'stage', 'state', 'stop', 'tail', 'triage', 'try',
];

const actual = Object.keys(VERBS).sort();
ok(actual.length === FROZEN.length, '动词数量仍是 37 个（实际 ' + actual.length + '）');
const added = actual.filter((v) => !FROZEN.includes(v));
const removed = FROZEN.filter((v) => !actual.includes(v));
ok(added.length === 0, '没有偷偷新增动词' + (added.length ? '（多出：' + added.join(', ') + '）' : ''));
ok(removed.length === 0, '没有偷偷删掉动词' + (removed.length ? '（少了：' + removed.join(', ') + '）' : ''));

// cli-spec 的规格三件套：缺一个就会在别的地方以奇怪方式失败（已犯三次）。
const noSpec = actual.filter((v) => !VERBS[v] || typeof VERBS[v].summary !== 'string' || !VERBS[v].summary);
ok(noSpec.length === 0, '每个动词都有 summary' + (noSpec.length ? '（缺：' + noSpec.join(', ') + '）' : ''));
const noCost = actual.filter((v) => !VERBS[v] || !VERBS[v].cost);
ok(noCost.length === 0, '每个动词都有 cost' + (noCost.length ? '（缺：' + noCost.join(', ') + '）' : ''));
const noStrict = actual.filter((v) => !VERBS[v] || typeof VERBS[v].strict !== 'boolean');
ok(noStrict.length === 0, '每个动词显式声明 strict' + (noStrict.length ? '（缺：' + noStrict.join(', ') + '）' : ''));

// 契约文档必须在，且必须写明三处口子（别只在聊天里说过）。
const docPath = path.join(ROOT, 'docs', 'ATWO-CONTRACT.md');
ok(fs.existsSync(docPath), 'docs/ATWO-CONTRACT.md 存在');
const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
ok(doc.includes('派活入参'), '契约文档写了派活入参');
ok(doc.includes('产物回执'), '契约文档写了产物回执');
ok(doc.includes('账本字段'), '契约文档写了账本字段');
ok(doc.includes('ATWO_VERIFY_TESTS'), '契约文档写了验收吃测试的开关');

// 账本读取契约：lane-health 的行必须有这四个字段，否则 selfcheck / 选路会打印 undefined
// （2026-11-19 真实踩过：字段名写成 agent，结果 「可用 、、」）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-contract-'));
const logDir = path.join(tmp, 'memory');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'log.jsonl');
fs.writeFileSync(
  logPath,
  [
    JSON.stringify({ kind: 'ask', agent: 'codebuddy', model: 'glm-5.3-flash', multiplier: 0.08, points: 8, ok: true, elapsedMs: 1000, ts: '2026-11-19T00:00:00.000Z' }),
    JSON.stringify({ kind: 'review', agent: 'codebuddy', ok: false, elapsedMs: 2000, ts: '2026-11-19T00:01:00.000Z' }),
    JSON.stringify({ kind: 'quota', agent: 'codebuddy', ok: false, elapsedMs: 0, ts: '2026-11-19T00:02:00.000Z' }),
  ].join('\n'),
  'utf8',
);
const rows = readHealthFromLog(tmp);
const row = rows.find((r) => r.lane === 'codebuddy');
ok(!!row, 'lane-health 能读出通道（字段名是 lane）');
ok(row && typeof row.calls === 'number', '行里有 calls');
ok(row && typeof row.ok === 'number', '行里有 ok');
ok(row && typeof row.rate === 'number', '行里有 rate');
ok(row && row.calls === 2, 'quota 记录不计入派活数（实际 ' + (row && row.calls) + '）');
fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log('contract_freeze: ' + pass + ' passed / ' + fail + ' failed');
if (fail) { console.log('失败项：' + failures.join(' | ')); process.exit(1); }
