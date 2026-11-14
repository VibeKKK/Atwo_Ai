// ui_smoke.mjs —— 界面层的「冒烟测试」：不花钱、不发消息，只检查选择器还认不认页面。
//
// 为什么需要它：契约层和纯函数层已经有 selftest，但 CDP 适配层一行自动化测试都没有。
// 每次 Trae / WorkBuddy 自动更新，都得等我手工发现「回车发不出去」「答案读成空」才知道坏了。
// 这个脚本把「界面是否还是那个界面」变成可以一键回答的问题：
//
//   node test/ui_smoke.mjs          # 客户端没开就自动跳过（不算失败）
//   node test/ui_smoke.mjs --json   # 机器可读
//
// 判据只做一件事：**用真实 DOM 查询验证 SEL 里的选择器仍能命中**。
// 它不判断答案对不对（那是 eval 的活），也不发消息（不消耗积分/额度）。

import { SEL } from '../agents/trae.mjs';
import { preflightTrae, clearPreflightCache } from '../lib/preflight.mjs';

const JSON_OUT = process.argv.includes('--json');
const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failed++;
  if (!JSON_OUT) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

// ── 1. 静态断言：选择器表本身不能是空的 ────────────────────────────────
// 这一层不碰浏览器，任何机器都能跑。曾经出现过 SEL.edit 被误改成 [] 这种低级故障。
for (const key of ['turn', 'renderer', 'edit']) {
  const list = SEL[key];
  check(`SEL.${key} 非空`, Array.isArray(list) && list.length > 0, `${Array.isArray(list) ? list.length : 0} 个候选`);
}
// 发送键不在 SEL 里（是 clickSend 内部常量），这里只确认关键选择器字符串没被写坏
check('发送键选择器形状', typeof SEL.edit[0] === 'string' && SEL.edit[0].length > 3, SEL.edit[0] || '(空)');

// ── 2. 动态断言：客户端在跑就顺手验一遍真实页面 ────────────────────────
// preflightTrae 内部就是「body 可读 / 回合容器存在 / 输入框存在」三条，正是改版最敏感的三处。
// 它自带缓存，所以这里先清一次，保证测的是当下状态。
clearPreflightCache();
let live = null;
try {
  live = await preflightTrae();
} catch (e) {
  live = { ok: false, reason: 'preflight 抛错：' + e.message };
}

if (live && live.skipped) {
  if (!JSON_OUT) console.log(`  · 跳过真实页面检查（${live.reason}）`);
  results.push({ name: 'live', ok: true, skipped: true, detail: live.reason });
} else if (live && live.ok) {
  for (const c of live.checks || []) check(`live:${c.name}`, c.ok, c.detail);
} else {
  check('live:preflight', false, (live && live.reason) || '未知原因');
  for (const c of (live && live.checks) || []) check(`live:${c.name}`, c.ok, c.detail);
}

// ── 输出 ───────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failed === 0, failed, results }, null, 2));
} else {
  console.log(failed === 0 ? '\nUI 冒烟测试通过' : `\nUI 冒烟测试失败 ${failed} 项`);
}
process.exit(failed === 0 ? 0 : 1);
