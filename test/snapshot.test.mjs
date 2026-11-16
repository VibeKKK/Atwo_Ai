import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refsFromTexts, writeSnapshot, materializeSnapshot, SNAPSHOT_CONTRACT } from '../lib/snapshot.mjs';
import { snapCwdFor } from '../lib/blind.mjs';

function test(name, fn) { try { fn(); console.log('✓ ' + name); } catch (e) { console.log('✗ ' + name + ' —— ' + e.message); process.exitCode = 1; } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'lib', 'a.mjs'), 'export const A = 1;\n', 'utf8');
fs.writeFileSync(path.join(tmp, 'lib', 'b.mjs'), 'export const B = 2;\n', 'utf8');

test('refsFromTexts 抠出路径并去重', () => {
  const r = refsFromTexts(['看 lib/a.mjs:12 与 lib/b.mjs', '再看 lib/a.mjs:9']);
  assert.deepStrictEqual(r, ['lib/a.mjs', 'lib/b.mjs']);
});
test('refsFromTexts 丢掉 URL', () => {
  assert.deepStrictEqual(refsFromTexts(['https://x.com/a.md']), []);
});
test('writeSnapshot 落 SNAPSHOT.json 与 snap 副本', () => {
  const dir = path.join(tmp, 'out');
  const s = writeSnapshot(dir, { cwd: tmp, texts: ['引 lib/a.mjs:1'] });
  assert.strictEqual(s.contract, SNAPSHOT_CONTRACT);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'SNAPSHOT.json'), 'utf8'));
  assert.strictEqual(onDisk.files.length, 1);
  assert.ok(onDisk.files[0].sha256);
  assert.ok(fs.existsSync(path.join(dir, onDisk.files[0].snap)));
});
test('writeSnapshot 缺文件记 missing 而不是静默通过', () => {
  const dir = path.join(tmp, 'out2');
  const s = writeSnapshot(dir, { cwd: tmp, texts: ['引 lib/nope.mjs:1'] });
  assert.strictEqual(s.files[0].missing, 'not-found');
});
test('writeSnapshot 拒绝 cwd 之外的文件', () => {
  const dir = path.join(tmp, 'out3');
  const s = writeSnapshot(dir, { cwd: tmp, texts: ['引 ../../etc/passwd.txt:1'] });
  assert.strictEqual(s.files[0].missing, 'outside-cwd');
});
test('materializeSnapshot 铺回原路径', () => {
  const src = path.join(tmp, 'out');
  const dst = path.join(tmp, 'flat');
  const m = materializeSnapshot(src, dst);
  assert.strictEqual(m.ok, true);
  assert.strictEqual(fs.readFileSync(path.join(dst, 'lib/a.mjs'), 'utf8'), 'export const A = 1;\n');
});
test('materializeSnapshot 没快照时给 no-snapshot', () => {
  assert.strictEqual(materializeSnapshot(path.join(tmp, 'nodir'), path.join(tmp, 'x')).reason, 'no-snapshot');
});
test('snapCwdFor 有快照时切到快照目录，无快照时退回原 cwd', () => {
  const withSnap = snapCwdFor('out/child-1.md', tmp);
  assert.notStrictEqual(withSnap.cwd, tmp);
  assert.ok(withSnap.snap);
  const noSnap = snapCwdFor('lib/a.mjs', tmp);
  assert.strictEqual(noSnap.cwd, tmp);
  assert.strictEqual(noSnap.snap, null);
});
test('快照里的字节就是当时的字节：改了源文件不影响快照核对', () => {
  const dir = path.join(tmp, 'out');
  fs.writeFileSync(path.join(tmp, 'lib', 'a.mjs'), '改了\n', 'utf8');
  const dst = path.join(tmp, 'flat2');
  materializeSnapshot(dir, dst);
  assert.strictEqual(fs.readFileSync(path.join(dst, 'lib/a.mjs'), 'utf8'), 'export const A = 1;\n');
});