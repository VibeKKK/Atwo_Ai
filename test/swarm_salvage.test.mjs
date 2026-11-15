// 通道超时抢救的回归测试。核心断言：判据是磁盘字节，不是通道的自我报告。
import { salvageFromDisk } from '../lib/swarm.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salv-'));
const p = path.join(dir, 'made.mjs');
let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? ' → ' + extra : '')); } };

fs.writeFileSync(p, 'export function f() { return 1; }' + 'x'.repeat(60));
const prompt = '写文件：' + p + '\n要求：…\n写完只回复「完成」';

t('刚写的文件能被抢救', !!salvageFromDisk(prompt, Date.now() - 5000));
const hit = salvageFromDisk(prompt, Date.now() - 5000);
t('抢救返回正确的路径', hit && hit.p === p, hit && hit.p);
t('抢救返回字节数', hit && hit.size > 40, hit && hit.size);

// 时间窗：如果文件比派活时间还早（上一轮的旧文件），不算本次产物
t('旧文件不抢救', salvageFromDisk(prompt, Date.now() + 60000) === null);
// 没有绝对路径的 prompt 不抢救
t('无路径不抢救', salvageFromDisk('随便写点东西', Date.now() - 5000) === null);
// 太小的是残留不是产物
fs.writeFileSync(path.join(dir, 'tiny.mjs'), 'x');
t('过小的文件不抢救', salvageFromDisk('写 ' + path.join(dir, 'tiny.mjs'), Date.now() - 5000) === null);

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + pass + '/' + (pass + fail) + ' 通过');
process.exit(fail ? 1 : 0);