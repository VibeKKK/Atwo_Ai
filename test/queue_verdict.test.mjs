import test from 'node:test';
import assert from 'node:assert/strict';
import { jobVerdict } from '../lib/queue-cli.mjs';

test('exit 4 = 跑成了但结论红，不是作业失败', () => {
  const v = jobVerdict(4);
  assert.equal(v.ok, true);
  assert.equal(v.red, true);
  assert.equal(v.why, 'accept-red');
});

test('exit 0 = 正常完成', () => {
  assert.deepEqual(jobVerdict(0), { ok: true, red: false, why: 'ok' });
});

test('exit 2/3/5/6 与环境异常都算失败（可重试）', () => {
  for (const c of [2, 3, 5, 6, 1, null]) {
    const v = jobVerdict(c);
    assert.equal(v.ok, false, 'exit ' + c);
  }
  assert.equal(jobVerdict(null).why, 'no-exit-code');
});
