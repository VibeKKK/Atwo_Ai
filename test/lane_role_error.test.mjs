import assert from 'node:assert';
import { planLanes } from '../lib/lanes.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0; let fail = 0;
const t = (name, fn) => { try { fn(); pass += 1; console.log('✓ ' + name); } catch (e) { fail += 1; console.log('✗ ' + name + ' —— ' + e.message); } };

// 2026-11-17 实测：--lanes workbuddy 抛裸栈 + exit 1，看不出 workbuddy 只能当评审。
t('GUI 通道当 writer：说清它是什么角色、谁能当', () => {
  assert.throws(() => planLanes(2, { role: 'writer', lanes: ['workbuddy'], probes: null }),
    (e) => /不能当 writer/.test(e.message) && /workbuddy=review/.test(e.message) && /能当 writer 的：.*codebuddy/.test(e.message));
});
t('未知通道名仍然报「未知通道」（不能被角色判据吞掉）', () => {
  assert.throws(() => planLanes(2, { role: 'writer', lanes: ['nope'], probes: null }), /未知通道/);
});
t('角色匹配时正常出编队（ollama 能 writer）', () => {
  const r = planLanes(2, { role: 'writer', lanes: ['ollama'], probes: null });
  assert.strictEqual(r.plan[0].lane, 'ollama');
});

// CLI 层：不许把栈甩出来，必须是干净退出码 5（通道问题）
t('CLI：角色不匹配 → 干净一句「没派成」+ 退出码 5', () => {
  const r = spawnSync(process.execPath, [path.join(HERE, 'atwo.mjs'), 'fanout', '问个问题', '--parts', '2', '--lanes', 'workbuddy', '--force-should'], { cwd: HERE, encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.strictEqual(r.status, 5, 'exit=' + r.status + ' ' + out.slice(0, 200));
  assert.match(out, /没派成：workbuddy 不能当 writer/);
  assert.ok(!/at Object\.cmdFanout|at async file:/.test(out), '不许出现栈');
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
