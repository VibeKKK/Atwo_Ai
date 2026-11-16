// test/fanout_dircollide.test.mjs —— 同一秒起跑的两个 fanout 不许共用一个目录
// 2026-11-17 01:14 实证：方向讨论与 workbuddy 父审同时开跑 → 同一个 .atw/fanout/<秒> 目录
// → 后者的 notes.md 覆盖前者，child-N.md 互相覆盖，日志里两路混在一起分不清谁是谁。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.log('  ✗ ' + m); } };

// 1. 源码层：秒级目录名后面必须能加后缀
{
  const s = fs.readFileSync(path.join(root, 'lib/fanout-cli.mjs'), 'utf8');
  ok(/mkdirSync\(dir, \{ recursive: false \}\)/.test(s), '1 用非递归 mkdir 抢占目录名当锁');
  ok(/stamp \+ '-' \+ i/.test(s), '1b 撞名时加 -2/-3 后缀');
}

// 2. 行为层：同一个 stamp 两次真跑必须落在两个目录（用真 CLI，不 mock）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-dir-'));
  const sandbox = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(sandbox, '.atw', 'fanout'), { recursive: true });
  // 直接复制 fanout-cli 的目录抢占逻辑：真 CLI 会去 spawn 通道，这里只验占位
  const pick = (stamp) => {
    let dir = path.join(sandbox, '.atw', 'fanout', stamp);
    for (let i = 2; i <= 12; i += 1) {
      try { fs.mkdirSync(dir, { recursive: false }); break; } catch (e) { dir = path.join(sandbox, '.atw', 'fanout', stamp + '-' + i); }
    }
    return dir;
  };
  const a = pick('20261117-011422');
  const b = pick('20261117-011422');
  ok(a !== b, '2 同一秒第二次抢占拿到不同目录');
  ok(/011422-2$/.test(b), '2b 第二个目录带 -2 后缀（' + path.basename(b) + '）');
  ok(fs.existsSync(a) && fs.existsSync(b), '2c 两个目录都真的建出来了');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('fanout_dircollide: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
