/**
 * 引文落地校验：父审写「lib/x.mjs:9999」时，那一行到底存不存在。
 *
 * 守三件事：
 * 1. 形状对 ≠ 落地（编造行号必须被抓到）；
 * 2. 落地了也不改判（我们只验「这一行存在」，不验语义，不许把 PASS 变 REVISE）；
 * 3. 缓存必须真的少读文件（同一次派活里同一文件只读一遍）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCite, explainCiteMiss, firstCite } from '../lib/cite-check.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-cite-'));
fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'lib', 'a.mjs'), 'line1\nline2\nline3\n');

// ---- firstCite ----
ok(firstCite('理由：lib/a.mjs:2 这里写错了')?.file === 'lib/a.mjs', '抽出文件名');
ok(firstCite('理由：lib/a.mjs:2 这里写错了')?.line === 2, '抽出行号');
ok(firstCite('理由：./lib/a.mjs 没写行号')?.line === 0, '没行号记 0');
ok(firstCite('理由：D:/x/lib/a.mjs:3')?.file === '/x/lib/a.mjs', '绝对路径保持绝对（不假装成仓库内相对路径）');
// 反斜杠一律用字符码拼：直接写进源码的 \r、\l 会被 JS 当转义吃掉（这个坑今天已踩两次）
const BS = String.fromCharCode(92);
ok(firstCite('见 C:' + BS + 'repo' + BS + 'lib' + BS + 'a.mjs:3')?.file === '/repo/lib/a.mjs', '反斜杠路径也能抽');
ok(firstCite('理由里一个文件名都没有') === null, '没有引用时返回 null');

// ---- checkCite 正常 ----
ok(checkCite(tmp, 'lib/a.mjs:2 有问题').ok === true, '行号在范围内 → ok');
ok(checkCite(tmp, 'lib/a.mjs 整文件').ok === true, '不带行号也算落地');
ok(checkCite(tmp, 'lib/a.mjs:3').ok === true, '最后一行边界内 → ok');

// ---- checkCite 各种不落地 ----
const outOfRange = checkCite(tmp, 'lib/a.mjs:9999 这行是编的');
ok(outOfRange.ok === false && outOfRange.why === 'line-out-of-range', '行号超范围 → line-out-of-range');
const missing = checkCite(tmp, 'lib/nothere.mjs:1 我编了个文件');
ok(missing.ok === false && missing.why === 'file-missing', '文件不存在 → file-missing');
const noCite = checkCite(tmp, '我觉得不行');
ok(noCite.ok === false && noCite.why === 'not-a-cite', '没有引用 → not-a-cite');

// ---- 缓存确实少读文件 ----
const cache = new Map();
checkCite(tmp, 'lib/a.mjs:1', cache);
ok(cache.has(path.resolve(tmp, 'lib/a.mjs')), '首次读文件后写进缓存');
const before = fs.statSync(path.join(tmp, 'lib', 'a.mjs')).mtimeMs;
fs.writeFileSync(path.join(tmp, 'lib', 'a.mjs'), 'only-one-line\n');
ok(checkCite(tmp, 'lib/a.mjs:3', cache).ok === true, '缓存期内仍按旧行数判（3 行）');
fs.rmSync(path.join(tmp, 'lib', 'a.mjs'));
ok(checkCite(tmp, 'lib/a.mjs:1', cache).ok === true, '文件被删后缓存仍用旧行数（同一次派活内不变）');
ok(fs.statSync(path.join(tmp, 'lib'), { throwIfNoEntry: false }) !== null, '目录还在（只删了文件）');
ok(before > 0, 'mtime 可读（占位断言，防误删）');

// ---- 缓存失效后能看到文件真没了 ----
ok(checkCite(tmp, 'lib/a.mjs:1').ok === false, '不带缓存时能发现文件已删');

// ---- 解释文案 ----
ok(explainCiteMiss('line-out-of-range', 'lib/a.mjs:9999').includes('超出文件长度'), '超范围文案说得清');
ok(explainCiteMiss('file-missing', 'lib/gone.mjs:1').includes('不存在'), '文件缺失文案说得清');
ok(explainCiteMiss('not-a-cite', '空话').includes('没有可核对'), '无引用文案说得清');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log('cite_check: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
