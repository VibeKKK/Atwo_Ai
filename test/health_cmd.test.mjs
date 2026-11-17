/**
 * atwo health 动词：选路的依据必须能被人看见。
 *
 * 断言重点不是排版，而是三条口径透到了 CLI：
 * quota 不算干活、时间窗外的不算、坏通道不消失。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATWO = path.join(HERE, '..', 'atwo.mjs');

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-health-cli-'));
const log = path.join(tmp, 'log.jsonl');
const now = Date.now();
const t = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
const lines = [
  ...Array.from({ length: 4 }, () => ({ kind: 'swarm', agent: 'codebuddy', ok: true, elapsedMs: 70000, time: t(0) })),
  { kind: 'swarm', agent: 'codebuddy', ok: false, elapsedMs: 0, time: t(1) },
  ...Array.from({ length: 6 }, () => ({ kind: 'review', agent: 'doubao', ok: false, elapsedMs: 120000, time: t(0) })),
  { kind: 'swarm', agent: 'trae', ok: true, elapsedMs: 15000, time: t(0) },
  ...Array.from({ length: 30 }, () => ({ kind: 'quota', agent: 'codebuddy', model: '', multiplier: 1, points: 100, ok: false, elapsedMs: 0, time: t(0) })),
  '{"kind":"swarm","agent":"half",', // 半行：必须被跳过而不是崩
];
fs.writeFileSync(log, lines.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n', 'utf8');

const cli = (args) => spawnSync(process.execPath, [ATWO, ...args], {
  cwd: HERE,
  env: { ...process.env, ATWO_LOG: log, ATWO_HEALTH: '0' },
  encoding: 'utf8',
});

const r = cli(['health']);
ok(r.status === 0, 'health 退出码 0（实际 ' + r.status + '）');
ok(r.stdout.includes('codebuddy') && r.stdout.includes('doubao'), '输出里两个通道都在');
ok(/codebuddy\s+5\s+4/.test(r.stdout), 'codebuddy 派活 5 单成功 4（quota 没被算进去）');
ok(r.stdout.includes('80%'), '成功率显示成百分比（4/5 = 80%）');
ok(r.stdout.includes('Wilson'), '把排序口径写出来，不让人猜');
ok(!r.stdout.includes('half'), '半行坏 JSON 被跳过，不进表');

const j = cli(['health', '--json']);
ok(j.status === 0, '--json 退出码 0');
const parsed = JSON.parse(j.stdout.slice(j.stdout.indexOf('{')));
ok(parsed.ok === true && parsed.verb === 'health', 'JSON 里 ok/verb 正确');
ok(Array.isArray(parsed.data.health) && parsed.data.health.length === 3, 'data.health 是三行（codebuddy/doubao/trae，实际 ' + (parsed.data.health || []).length + '）');
ok(parsed.data.health[0].lane === 'codebuddy', '第一行是健康度最高的 codebuddy');
ok(parsed.data.health.find((x) => x.lane === 'doubao').rate === 0, 'doubao 0% 如实报出，不被藏起来');

// 空账本
const empty = path.join(tmp, 'empty.jsonl');
fs.writeFileSync(empty, '', 'utf8');
const e = spawnSync(process.execPath, [ATWO, 'health'], { cwd: HERE, env: { ...process.env, ATWO_LOG: empty, ATWO_HEALTH: '0' }, encoding: 'utf8' });
ok(e.status === 0 && e.stdout.includes('还没有派活记录'), '空账本给一句人话，不报错');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log('health_cmd: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
