# 多池调度 + 每任务成本账（假云端第三、五步）

日期 2026-11-17 · rank2 dsh-work-replace · 授权 User said (m05642)

## 一、多池调度：并发不是标量，得挂在通道上

`lib/pool.mjs`（204 行，子会话产出，父审 PASS）· CLI `lib/pool-cli.mjs`（我接线）· `atwo pool run|plan`。

- `LANE_CAPS = { codebuddy: 6, codex: 6, ollama: 2, trae: 1, workbuddy: 1, doubao: 1 }`；GUI 通道 cap 写死 1，传 `caps.trae=8` 也无效（父审正是抓这一条把另一路判了 REVISE）。
- `planPool(jobs,{lanes,caps})`：按 cap 剩余装填，装不下进 `unassigned` —— **宁可留空也不超发**（超发会把通道打回「每路都变慢」，实测 12 路单路 4.85s→11.05s、吞吐停在 0.96/s）。
- `runPool(jobs,{ask,lanes})`：池内并发 ≤ cap、池间并行；某通道**连续 2 条失败**判 dead，池里没跑的改派给还有余量的 writer（`reassigned` 留痕）。
- 真跑：`atwo pool plan --max 6 --lanes codebuddy,ollama` → `codebuddy×4 · ollama×2`；`atwo pool run --max 3` → 领 3 成 3，`codebuddy ok=2` `ollama ok=1`。

## 二、每任务成本账

`lib/taskcost.mjs`（子会话产出，父审机械闸门两路都打回、我手工落地）· CLI `lib/cost-cli.mjs` · `atwo cost [--since ISO]`。

- `PRICE_PER_MTOK` 六价表 + `default`；`usdOf(model,in,out)` 按百万 token。
- `appendCost` 落 `memory/cost.jsonl`（一行一条），`readCost` 坏行计数不中断，`summarizeCost` 按 lane / model / taskId 三维聚合，`formatCost` 只返回字符串（不 console.log，免得污染 --json）。
- 接线：`atwo queue run` 与 `atwo pool run` 每跑完一条写一账（`taskId=作业 id`、`lane`、墙钟、calls=1）。
- **诚实限制**：CLI 的 json 里没有稳定 usage 字段，`tokensIn/tokensOut` 先记 0 并写 `note:'token 未采集'`。假数字比没数字更糟，所以宁可只报墙钟与调用数。

## 三、这一轮派活暴露的两件事

1. **文件名冲突是我的规格错误**：我让子会话写 `lib/cost.mjs`，但仓库里 Nov 14 就有同名文件（`summarize/fmtTokens/fmtCost/estimateCost/renderCostTable`）。
   子会话的 EVIDENCE 报 `lib/cost.mjs:189/227/243/253` —— 而真文件只有 178 行，机械闸门当场判 REVISE（判断没错）。
   落地时改名 `lib/taskcost.mjs`。**教训：派活前先查目标路径是否已存在**，否则要么覆盖别人的文件、要么被闸门正确拦下白跑一轮。
2. **机械闸门抓到了子会话的算术错**：`test/taskcost.test.mjs` 里 `usdOf(undefined,2000000,0)` 断言 2，而它自己的单价表 `default.in=0.5` 算出来是 1.0。
   跑起来才暴露（11 条里 1 红），我按表算出真值改成 1 并加了注释说明这是子会话算错。**自测能过 ≠ 断言写对**。

## 四、并发实测（cfs 上限，回答「云端靠机器、我们靠什么」）

`_probe/conc-scale.mjs` / `conc-scale32.mjs` 真跑 codebuddy（32/32 全成功）：

| 路数 | 墙钟 | 吞吐 |
|---|---|---|
| 1 | 7.8s | 0.13/s |
| 8 | 21.9s | 0.37/s |
| 16 | 27.6s | 0.58/s |
| 32 | 48.8s | **0.66/s**（不再涨） |

瓶颈在账号/上游侧，不在本机（20 核 31GB，跑 32 路时空闲内存反升到 10.3GB）。**所以租更多核不会更快**，云端六条优势里能靠本机模拟的只有：隔离（worktree）、持久（队列）、无界面绑定（GUI 降级异步）、观察计费（成本账）、网络（Kali 出口）。

## 五、改动文件

新：`lib/pool.mjs` · `lib/pool-cli.mjs` · `lib/taskcost.mjs` · `lib/cost-cli.mjs` · `test/pool.test.mjs`（13 条）· `test/taskcost.test.mjs`（11 条）。
改：`atwo.mjs`（table 加 cost / pool）· `lib/cli-spec.mjs`（两条 spec）· `lib/queue-cli.mjs`（每条作业记一账）。

## 六、验证

`node test/pool.test.mjs` 13/0 · `node test/taskcost.test.mjs` 11/0 · `node test/atwo_cli_spec.test.mjs` 39/0 · `node test/all.mjs` **95/95 · 302.8s**。

## 七、回滚

`git revert` 本提交即可（没有计划任务、没有仓库外的状态；`memory/cost.jsonl` 是运行时数据，留着无害）。
