// atwo 的命令行契约测试：护栏、规格真源、机器可读出口。
//
// 为什么这些必须钉死：atwo 是给 AI 用的，AI 不会「感觉不对」——
// 它照着文档敲，然后相信退出码。所以三件事一旦漂了，没人会发现：
//   1. 文档（cli-spec）说 A、实现做 B；
//   2. 一个拼错的开关被静默吞掉，AI 以为自己改了档位；
//   3. --help 变成任务文本，真派活花钱。
// 2026-11-16 13:58 第三条真发生过：atwo fanout --help 派出三个子会话跑了 61 秒。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = await import(pathToFileURL(path.join(root, 'lib/cli-spec.mjs')).href).catch((e) => ({ __missing: String(e && e.message) }));
const FR = await import(pathToFileURL(path.join(root, 'lib/fanout-run.mjs')).href).catch((e) => ({ __missing: String(e && e.message) }));

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

/** 跑一次 atwo，拿退出码与输出。cwd 固定仓库根，绝不进 .atw/fanout 之外的目录。 */
function atwo(args) {
  const r = spawnSync(process.execPath, ['atwo.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const fanoutDirs = () => {
  const d = path.join(root, '.atw/fanout');
  try { return fs.readdirSync(d).length; } catch { return 0; }
};

if (S.__missing) check('lib/cli-spec.mjs 可加载', false, S.__missing);
else {
  // —— 规格表本身 ——
  const names = Object.keys(S.VERBS);
  // 不写死数量：写死一个数字，加动词就要改测试，等于用测试绑住产品。
  // 真正要钉的是「spec 与实现是同一张表」——从 atwo.mjs 里扒出 table，键集合必须完全一致。
  const atwoSrc = fs.readFileSync(new URL('../atwo.mjs', import.meta.url), 'utf8');
  const line = atwoSrc.split('\n').find((l) => l.startsWith('const table = {'));
  const impl = line ? [...line.matchAll(/([A-Za-z_][\w]*)\s*:\s*cmd/g)].map((m) => m[1]) : [];
  const onlySpec = names.filter((v) => !impl.includes(v));
  const onlyImpl = impl.filter((v) => !names.includes(v));
  check('VERBS 与 atwo.mjs 的 table 是同一张表（新增动词不会一处写一处漏）',
    impl.length >= 11 && onlySpec.length === 0 && onlyImpl.length === 0,
    'spec ' + names.length + ' 个 / 实现 ' + impl.length + ' 个' + (onlySpec.length ? ' · 只有 spec：' + onlySpec : '') + (onlyImpl.length ? ' · 只有实现：' + onlyImpl : ''));
  check('每个动词都有 summary/cost/strict', names.every((k) => {
    const v = S.VERBS[k];
    return typeof v.summary === 'string' && v.summary.length > 4 && ['none', 'io', 'spawn'].includes(v.cost) && typeof v.strict === 'boolean';
  }));
  check('会花钱的动词被标成 spawn', ['go', 'fanout', 'batch', 'raw'].every((v) => S.VERBS[v].cost === 'spawn'),
    ['go', 'fanout', 'batch', 'raw'].map((v) => v + '=' + S.VERBS[v].cost).join(' '));
  check('本地动词不标 spawn', ['check', 'judge', 'state'].every((v) => S.VERBS[v].cost !== 'spawn'));
  check('EXIT_CODES 正好 0/2/3/4/5/6', Object.keys(S.EXIT_CODES).join(',') === '0,2,3,4,5,6', Object.keys(S.EXIT_CODES).join(','));

  // —— 求助识别：这是那场事故的根 ——
  check('isHelp 认常见写法', ['-h', '--help', 'help', 'HELP', '--Help'].every((x) => S.isHelp(x)));
  check('isHelp 不认近似拼错（交给未知参数处理）', ['--helpp', '-hh', 'helpme', '--h'].every((x) => !S.isHelp(x)));
  check('isHelp 对空值不炸', S.isHelp(undefined) === false && S.isHelp('') === false);

  // —— 未知参数 ——
  check('new --szi 被拦', !S.checkFlags('new', ['--szi', 'S']).ok, JSON.stringify(S.checkFlags('new', ['--szi', 'S']).unknown));
  check('new --size S 放行', S.checkFlags('new', ['--size', 'S']).ok);
  check('judge --z 负数值不被误拦', S.checkFlags('judge', ['--z', '-0.5,-0.4,-0.3']).ok);
  check('judge --z=负数 等号形式放行', S.checkFlags('judge', ['--z=-0.5,-0.4']).ok);
  check('fanout --dry-run 是全局开关', S.checkFlags('fanout', ['--dry-run']).ok);
  check('go 透传未知开关（不拦）', S.checkFlags('go', ['--whatever', 'x']).ok, 'go 必须透传，否则新参数没法用');
  check('raw 透传未知开关', S.checkFlags('raw', ['--stats']).ok);
  check('未登记的动词不抛错', S.checkFlags('nosuch', ['--x']).ok);

  // —— 位置参数 ——
  check('positional 跳过带值开关与其值', JSON.stringify(S.positional('judge', ['--z', '1,2', 'x.md'])) === '["x.md"]',
    JSON.stringify(S.positional('judge', ['--z', '1,2', 'x.md'])));
  check('positional 保留任务文本', JSON.stringify(S.positional('fanout', ['--parts', '3', '干活'])) === '["干活"]');

  // —— 规格自洽：usage 里出现的开关必须是登记过的 ——
  const badUsage = [];
  for (const k of names) {
    const s = S.specOf(k);
    const known = new Set([...Object.keys(s.flags), ...s.switches, ...Object.keys(S.GLOBAL_FLAGS)]);
    for (const m of s.usage.matchAll(/(--[a-z-]+)/g)) if (!known.has(m[1])) badUsage.push(k + ':' + m[1]);
  }
  check('usage 里没有未登记的开关', badUsage.length === 0, badUsage.join(' '));

  // —— 跨文件真源对照：spec 的上限必须等于实现的上限 ——
  if (!FR.__missing) {
    check('LIMITS.maxParts 与 fanout-run 的 MAX_PARTS 一致', S.LIMITS.maxParts === FR.MAX_PARTS,
      'spec=' + S.LIMITS.maxParts + ' impl=' + FR.MAX_PARTS);
    check('clampParts 真的夹在上限', FR.clampParts(99) === FR.MAX_PARTS && FR.clampParts(0) === 1);
  }

  // —— caps JSON ——
  const caps = S.capsJson();
  check('caps 带契约版本', caps.contract === 'atwo-caps/1');
  check('caps 的 verbs 数量与表一致', Object.keys(caps.verbs).length === names.length);
  check('caps 带退出码与上限', !!caps.exitCodes && !!caps.limits && caps.limits.maxParts === S.LIMITS.maxParts);
  check('caps 的第一条自我说明就写明 help 不派活', /help/.test(caps.note[1]) && /不会/.test(caps.note[1]), caps.note[1]);

  // —— 真 CLI：护栏必须在 dispatch 层生效，不能靠每个动词自觉 ——
  const before = fanoutDirs();
  const h = atwo(['fanout', '--help']);
  check('atwo fanout --help 退出 0', h.code === 0, 'rc=' + h.code);
  check('atwo fanout --help 打的是规格不是任务', /用法：atwo fanout/.test(h.out), h.out.split('\n')[0]);
  check('atwo fanout --help 没有派活（目录数不变）', fanoutDirs() === before, 'before=' + before + ' after=' + fanoutDirs());

  const d = atwo(['fanout', '随便写点什么', '--dry-run']);
  check('atwo fanout --dry-run 退出 0 且不派活', d.code === 0 && fanoutDirs() === before, 'rc=' + d.code);
  check('atwo fanout --dry-run 打的是计划', /试跑/.test(d.out) && /子会话/.test(d.out), d.out.split('\n')[0]);

  const unk = atwo(['new', '--szi', 'S']);
  check('atwo new --szi 退出 2', unk.code === 2, 'rc=' + unk.code);
  check('atwo new --szi 说明没派活也没改东西', /不认识的参数/.test(unk.out) && /没有派活/.test(unk.out));

  const capsCli = atwo(['caps', '--json']);
  let capsParsed = null;
  try { capsParsed = JSON.parse(capsCli.out); } catch { /* 下面断言会红 */ }
  check('atwo caps --json 是合法 JSON', !!capsParsed, capsCli.out.slice(0, 80));
  check('atwo caps --json 带 exitCode 字段', capsParsed && capsParsed.exitCode === 0 && capsParsed.data && capsParsed.data.contract === 'atwo-caps/1');

  const hs = atwo(['help', 'fanout', '--json']);
  let hsParsed = null;
  try { hsParsed = JSON.parse(hs.out); } catch { /* noop */ }
  check('atwo help <动词> --json 出机器规格', hsParsed && hsParsed.data && hsParsed.data.verb === 'fanout' && !!hsParsed.data.flags);

  check('atwo help（无参）退出 0', atwo(['help']).code === 0);
  check('不认识的动词退出 2', atwo(['nosuchverb']).code === 2);
  check('batch --dry-run 被拦住（还没实现）', atwo(['batch', 'a.md', '--dry-run']).code === 2);
  check('check --dry-run 明说无意义后照常跑', /无意义/.test(atwo(['check', 'lib/cli-spec.mjs', '--dry-run']).out));
}

let pass = 0; let fail = 0;
for (const x of results) {
  if (x.ok) { pass++; console.log('  ✓ ' + x.name); }
  else { fail++; console.log('  ✗ ' + x.name + (x.detail ? '  → ' + x.detail : '')); }
}
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
