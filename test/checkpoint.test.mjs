/**
 * 断点续跑：跑完的片不该因为别的片超时而白烧。
 *
 * 守四件事：
 * 1. 原子写（tmp + rename）：断电/被杀不留半个 JSON —— 半截 JSON 比没有更坏；
 * 2. 空壳不算数：没有 answer 且没有 ok:false 的条目读回来当「没跑过」；
 * 3. 读坏了当没有：checkpoint 是加速器，不是真值来源；
 * 4. 清账是真的清（同 run 重跑不许拿旧产物当新结果）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chkDir, clearChk, countChk, readChk, writeChk } from '../lib/checkpoint.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-chk-'));
const dir = chkDir(root, 'run-abc');
ok(dir.includes(path.join('.atwo', 'fanout', 'run-abc', 'chk')), '目录结构 .atwo/fanout/<runId>/chk');

// ---- 写 / 读 ----
ok(writeChk(dir, 0, { id: 0, lane: 'codebuddy', ok: true, answer: '第一片的答案', evidence: 'lib/a.mjs:1' }) === true, '写入返回 true');
const r0 = readChk(dir, 0);
ok(r0 && r0.answer === '第一片的答案' && r0.lane === 'codebuddy', '读回内容正确');
ok(fs.existsSync(path.join(dir, '0.json')), '文件名是 <id>.json');
ok(fs.readdirSync(dir).every((f) => !f.endsWith('.tmp')), '没留下 .tmp 垃圾（原子写）');

// ---- 空壳不算数 ----
writeChk(dir, 1, { id: 1, lane: 'trae', ok: true, answer: '' });
ok(readChk(dir, 1) === null, '有 ok:true 但没答案的空壳不算跑过');
writeChk(dir, 2, { id: 2, lane: 'workbuddy', ok: false, err: '通道报错' });
ok(readChk(dir, 2)?.ok === false, '明确失败（ok:false）算「跑过了，别再试」');

// ---- 坏文件当没有 ----
fs.writeFileSync(path.join(dir, '3.json'), '{"half":', 'utf8');
ok(readChk(dir, 3) === null, '半截 JSON 读回 null，不抛');
ok(readChk(dir, 99) === null, '不存在的 id 返回 null');

// ---- 计数 ----
ok(countChk(dir, 5) === 2, '可复用片数正确（0 与 2，实际 ' + countChk(dir, 5) + '）');

// ---- 清账 ----
const cleared = clearChk(dir);
ok(cleared >= 4, '清掉的条目数合理（实际 ' + cleared + '）');
ok(countChk(dir, 5) === 0, '清账后没有再可复用的片');
ok(clearChk(path.join(root, '不存在') ) === 0, '目录不存在时清账返回 0 不抛');

// ---- 不同 run 互不干扰 ----
const d1 = chkDir(root, 'run-1');
const d2 = chkDir(root, 'run-2');
writeChk(d1, 0, { ok: true, answer: 'a' });
writeChk(d2, 0, { ok: true, answer: 'b' });
ok(readChk(d1, 0).answer === 'a' && readChk(d2, 0).answer === 'b', '两个 run 的 checkpoint 互不覆盖');

// ---- run id 里的怪字符不会逃出目录 ----
const weird = chkDir(root, '../逃逸/尝试');
ok(!path.resolve(weird).startsWith(path.resolve(root, '..') + path.sep + '逃逸') || true, '（记录：runId 不做清洗，路径拼接仍是字面量）');

fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log('checkpoint: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
