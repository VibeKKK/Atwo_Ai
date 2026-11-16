# 2026-11-16 · 三值机的融合三刀 + 分诊台

## 一、为什么做
融合审计（今日 22:0x）给出的断口是「引擎装对了，钥匙还在 CLI 上」：
- 断口①：改契约 cut.high 0.45→0.50，gate 全绿 —— 闸门替被改的契约背书。
- 断口②：vm/votes.mjs 里 runVerdict/compileVerdict 零命中，票通道仍是 JS 直算，而 done 拦提交用的正是 judgeVotes。
- 断口③：插件 8 工具里只有 atwo_attest 碰三值机（审旧凭证），没有发起新判定的入口。
用户口径：融合要与速度搭配、为提速铺路。

## 二、四刀
1. **vm-smoke 进 gate**（断口①）：lib/gate.mjs 在 contract 步之后新增第八步，spawn `node vm/smoke.mjs`，解析最后一行 JSON；红则 detail「参考向量重算不一致（N 组）」并 exit 4。112ms。
2. **票面走 VM**（断口②）：vm/verdict.mjs 新增 compileVotes / runVotesVerdict；vm/votes.mjs 用模块级 VOTES_PROGRAM 做第二重对照，不一致 → value 0 / state unreviewed / reason 'votes-mismatch'；返回 votesProgram{value,steps,length,agrees}。
3. **插件 atwo_judge**（断口③）：plugins-src/dsh-atwo 注册第 9 个工具，参数 z / votes / expected / remote / timeoutMs，一律 --json + 退出码原样透传。_verify.mjs 20/20。
4. **分诊台 atwo triage**（第四刀，配合提速）：lib/triage.mjs + lib/triage-cli.mjs。一批子产物先过机械闸门（pregate + ref-match），路由只有 reject / review 两条，报出「这轮真正要花的 LLM 次数」。实测父审单片固定成本约 50s，所以省下的次数就是省下的墙钟。

## 三、实测
- gate 篡改实验：cut.high 0.45→0.50，旧 gate 全绿 6146ms；补四条贴线向量后 gate 真红（RC=4），还原后 16/16。
- 契约：contractVersion 3，向量 9→13（新增 贴线·高线上方 0.46 / 高线下方 0.44 / 中线上方 0.23 / 中线下方 0.21），smoke checked 16。
- 跨主机对拍 _probe/parity-kali.mjs：judge 13 组不一致 0，votes 5 条不一致 0；Kali /health 报 contractVersion 3 / votesArity 0.8。
- 票面 9 条路径全 agrees true（1 ACCEPT 0.762 / 0 insufficient 0.457 / -1 insufficient 0.000 / 0 no-roster / 1 REVISE / -1 0.109 / -1 0.040 …）。
- 测试：node test/all.mjs → 67/67 · 169.6s（含新增 test/triage.test.mjs 17 条）；atwo gate --no-tests 全绿（closure 41 / syntax 89 文件 8.9s / contract / vm-smoke 112ms / pollution）。

## 四、四个真 bug（都有断言钉死）
1. 门不过原写成 -1 → 2:1 分歧当场炸 votes-mismatch（node votes-mismatch vs py insufficient）。语义是「+1 降级成 0」，零票的 -1 要保留。
2. machine.mjs 的 PUSHNUM 只写 num 寄存器、不压栈（THRESH 读它），写 `emit(OP.PUSHNUM, 0, OP.OR)` 想让 0 入栈 → 栈下溢。必须 `emit(OP.PUSH, 0, OP.OR)`。
3. 用 `replace()` 改常量只替换第一处 → compileVerdict 与 compileVotes 的哨兵互换（差点毁掉 rank1 的判定程序）。教训：多函数同常量名禁止全局 replace。
4. 测试里用 `new URL(import.meta.url).pathname` 取仓库根 → 路径含空格被编码成 %20 → cwd 不存在 → spawnSync ENOENT。必须 fileURLToPath。

## 五、改动文件
- 判定层：vm/verdict.mjs（票面程序段）· vm/votes.mjs（第二重对照）· vm/smoke.mjs（新）· vm/export-contract.mjs（贴线向量）· vm/oracle-contract.json（v3）· vm/judge.mjs（contractVersion 进 loadContract）· vm/server.mjs 与 vm/oracle_server.py（/health 报版本）
- 闸门：lib/gate.mjs（第八步）
- 分诊：lib/triage.mjs（新）· lib/triage-cli.mjs（新）· atwo.mjs（table + 1 行 import）· lib/cli-spec.mjs（triage 规格）
- 测试：test/triage.test.mjs（17）
- 插件：C:/Users/kkk/.dsh/plugins-src/dsh-atwo/lib/index.js（atwo_judge）+ _verify.mjs（20/20）

## 六、回滚
1. `git revert <本提交>`：契约会同时回到 v2，代码与契约必须一起回滚（vm-smoke 会因向量数不符而红，这是设计）。
2. 只想关掉 vm-smoke 一步：删 lib/gate.mjs 里 `steps.push(step('vm-smoke'...))` 那一段（会重新回到「契约被改也绿」的状态，别当长期方案）。
3. 只想关掉票面第二重对照：vm/votes.mjs 里删 `votesProgram` 比对块 —— 会退回到纯 JS 直算（断口②复现）。
4. 插件 atwo_judge：删 lib/index.js 那段 register（不影响其余 8 个工具）。

## 七、已知不对称
- Kali 侧 python 的票面仍是 python 直算 + 复刻，不是跑 node VM；对拍只能证明「结论一致」，不能证明「同一台机器算的」。
- 分诊台只做机械判定，不做语义；它省的是明确不合格的那部分钱，不代表剩下的都合格。
- atwo_judge 走 remote 时若拿不到服务，按 exit 5 fail-closed，不给本地兜底结论。
