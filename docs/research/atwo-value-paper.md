# atwo 价值评估报告（专家论文级）

> 评估对象：`D:\ai project\ai team work`（atwo，AI 产出物裁决层 CLI）
> 评估日期：2026-11-16
> 评估方式：代码实读 + 全量回归实跑 + 疯狂模式四通道派活实验 + 与六类既有软件的机制级对比
> 撰写：主对话（dsh-lead）；素材包含 codebuddy 路独立成稿的 13,714 字节论文（存于 `lib/outcome.codebuddy.mjs`，见 §2.3 的实验事故）

---

## 1. 摘要

atwo 是一个 1,509 行入口（`atwo.mjs`）、90 个 `lib/*.mjs`、56 个测试文件、66 个测试脚本全绿的本地 CLI（证据：`wc -l atwo.mjs`；`node test/all.mjs` → 66/66，97.2s；`node atwo.mjs caps --json` → 20 个动词）。它回答一个现有工具都不直接回答的问题：**多通道 AI 干完活之后，「说成功了」与「产物真在盘上、真能跑、能被人复算」之间的鸿沟由谁裁定**。答案是四件东西的合成：产物优先判定（只认开工后新落地的文件 + 语法闸）、八步收工闸门（closure/syntax/contract/vm-smoke/tests/pollution/accept/uncommitted）、三值票决（ACCEPT/REVISE/unreviewed，到票率 < 0.8 一律不放行）、以及可复算凭证（sha256 落账，任何人可重算）。

横轴上它不替代任何一类软件，且不与任一类同赛道：编排框架（LangGraph/CrewAI/AutoGen）解决分工与状态流转；代码代理（Cursor/Cline/Claude Code）解决把活干出来；评测框架（promptfoo/DeepEval）解决好不好的打分；追踪平台（LangSmith/Langfuse）解决可观测；CI（Actions/pre-commit）解决确定性检查；MCP 解决工具发现与调用。atwo 的坐标是这些层之上的**裁决层**：它假设活已经派出去、结果已经回来，它只负责判「信不信」，并把判定结果做成可被第三方重算的证据。

结论（≤150 字）：**值得继续做，但只在一个前提成立时——先补上误放行率的证据。** 坐标（AI 产出物的诚实裁决）目前是空的，八步闸门与到票率硬闸两块资产可复用；但它自称「防谎报」，自己的防线从未被测量过，且本次实验里四路有三路交不出东西——这两件事比任何功能缺口都更该先解决。

---

## 2. 研究问题与方法

### 2.1 研究问题

1. atwo 在现有软件格局里占什么位置？与谁同赛道、与谁互补、与谁无关？
2. 它的新意是「机制新」还是「坐标空」？
3. 值不值得继续投入？若值得，下一步先做什么、不许做什么？

### 2.2 方法与证据等级

| 证据 | 手段 | 等级 |
|---|---|---|
| 机制存在性 | 逐文件实读（`atwo.mjs` 1509 行、`lib/outcome.mjs` 143、`lib/gate.mjs` 216、`vm/votes.mjs` 176、`vm/verdict.mjs` 121、`lib/review-feed.mjs` 119、`lib/army.mjs` 328） | **A（可核）** |
| 测试有效性 | 本机实跑 `node test/all.mjs` → 66/66，97.2s（68 个 `test/*.mjs`，其中 56 个 `*.test.mjs`） | **A（可复跑）** |
| 运行有效性 | 疯狂模式真跑（4 路 + 3 评审 + 返工 3 轮 + 禁缓存），日志 `/d/tmp/paper_run.log` | **A（本次实测）** |
| 成本与效率 | 倍率表（Hy3 0.00x / GLM-5.3-Flash 0.08x / DeepSeek-V4.1-Flash 0.11x / Kimi-K3.1-Pro 0.97x / Kimi-K3 1.62x）+ 账本 692 条 log、115 条 score | **B（自产自查）** |
| 误放行率 | **无数据** —— 没有红队样本集、没有对照实验、没有线上事故率 | **D（空白）** |

> 方法论声明：凡本文写「不知道」，都是真的没有数据，不是谦虚。凡写数字，都能用同一条命令复现。

### 2.3 本次实验：疯狂模式四路派活（失败面本身是证据）

设置：`.atw/mode.json` = crazy（四路全上 + 三评审 + 返工三轮 + 超时 ×1.5 + 禁缓存），模型分档 `Kimi-K3.1-Pro (0.97x)`，超时 codebuddy/workbuddy 450s、trae/doubao 180s。

结果（抄自 `/d/tmp/paper_run.log`）：

```
[15:39:53] ! #1 trae 失败（空产出），同通道换模型重试 → Seed-Code
[15:39:58] ! #1 workbuddy 失败（空产出）→ 换 Hy3
[15:39:59] ↻ #1 workbuddy→trae 换路（空产出 | GUI 换模型失败：菜单里没有「Hy3」）
[15:41:44] ✗ #1 workbuddy 281.4s
[15:42:09] ! doubao 信箱失败，退回直连：等结果文件超时 300s
[15:42:13] ✗ #1 trae 309.9s
[15:44:33] ! #1 codebuddy 失败（超时 450s）→ 换模型重试
[15:46:38] ⚠ #1 验收未过 lib/outcome.codebuddy.mjs（内容像 markdown，.mjs 应以代码开头）
```

三个事实：

1. **四路里只有一路（codebuddy）交出了正文**，13,714 字节、九节齐全、带证据标记；`trae`/`workbuddy`/`doubao` 三路空产出或超时。它最终被判「验收未过」，原因不是内容不行，而是**落盘把 markdown 文章写进了 `.mjs`**（目标识别被 PRD 里提到的代码路径带走）。
2. **GUI 通道的模型切换在"生成中/异常会话"下点不动**（`点了但按钮没变`、`菜单里没有「Hy3」`），三级自愈空转 —— 这是「多路并行」在 GUI 通道上的硬上限。
3. **归档格式与内容格式没有对齐**：内容是一篇文章，落盘契约只认代码/数据文件。这暴露出 atwo 的落盘器只服务「写代码」这一种任务形态。

> 这三条不是 bug 清单，而是评估结论的一部分：**atwo 目前是「代码任务的裁决器」，还不通用。**

---

## 3. 横轴对比：六类软件，逐一给「它解决什么 / 与 atwo 的关系」

### 3.1 编排框架（LangGraph / CrewAI / AutoGen）

- **它解决**：多 agent 如何分工、状态如何在图上流转、失败如何重试与恢复。
- **atwo 与它**：**互补，且明显更弱**。atwo 的派活只是 `spawn` 子进程 + 流式守护（`atwo.mjs` 的 `orchestraSupervised`），没有图、没有 checkpoint、没有中断恢复；`lib/army.mjs` 的三三制是「阵型模板」，不是状态机。
- **可抄**：LangGraph 的 checkpointer（状态快照 + 从节点续跑）。

### 3.2 代码代理（Cursor / Cline / Claude Code / Codex）

- **它解决**：把活干出来。
- **atwo 与它**：**互补 + 寄生**。atwo 不写代码，它是四个第三方通道（codebuddy/trae/workbuddy/doubao）的调用方与验收方。任何一路自己开始做「诚实回报」，atwo 对应路就贬值。
- **可抄**：Claude Code 的 hooks 事件模型（pre/post 钩子），让项目方挂自己的检查而不改 atwo 本体。

### 3.3 评测框架（promptfoo / DeepEval / LangSmith eval）

- **它解决**：给定输入与输出，打分。
- **atwo 与它**：**互补**。atwo 判的是产物属性（在不在、能不能跑、结构对不对），不判质量。它没有模型评分层。
- **可抄**：声明式断言（YAML）+ 可选 LLM-as-judge 做第六层。

### 3.4 可观测 / 追踪（LangSmith / Langfuse）

- **它解决**：记录 trace、token、延迟，并提供查询。
- **atwo 与它**：**互补，量级差两个数量级**。atwo 的账本是 append-only jsonl（`memory/log.jsonl` 692 行、`score.jsonl` 115 行、`attest.jsonl` 3 行），查询能力约等于 grep。唯一比追踪平台多做一步的地方是：**账本直接喂判定**（`predictRun` 用历史 p50 预测本次墙钟）。
- **可抄**：trace_id/span 的结构化 schema，让账本能被现有分析工具消费。

### 3.5 CI 门禁（GitHub Actions / pre-commit）

- **它解决**：合入前跑确定性检查。
- **atwo 与它**：**部分替代、主要互补**。`lib/gate.mjs` 的八步里有两步是传统 CI 不做的、且专为「AI 生成代码」设计：
  - `contract`：阈值不许写死进代码，必须从契约读（对应 cut.high 0.45→0.50 被偷改而 gate 全绿的真实事故）；
  - `pollution`：源文件里混进测试内容要红。
- **可抄**：按变更文件裁剪测试集 + 依赖缓存（现在 gate 是全量串行跑）。

### 3.6 协议层（MCP）

- **它解决**：工具如何被模型发现与调用。
- **atwo 与它**：**无关偏互补**。atwo 是 CLI，`caps --json` 与退出码表（0/2/3/4/5/6）是给 AI 操作者读的手写 capability 约定。
- **可抄**：把 `caps` 对齐 MCP 的 `tools/list` schema，包一层 `atwo mcp` 即零成本接入任何 MCP client。

---

## 4. 纵轴定位

**一句话**：atwo 坐在「**AI 产出物的诚实裁决**」这个坐标上 —— 即 `产物存在性 × 可运行性 × 多评审一致性` 的合成判定层，且判定本身可被第三方复算（凭证 sha256 + VM 字节码重算与代码路径对拍）。

**它不是什么**（这一节比上面那句更重要）：

- 不是编排框架：没有图、没有 checkpoint、没有恢复。
- 不是代码代理：自己不写代码。
- 不是评测平台：没有模型打分、没有质量维度。
- 不是追踪平台：没有查询界面，账本只能 grep。
- 不是通用 CI：`lib/gate.mjs:30` 的扫描目录、`lib/should.mjs` 的热点文件都是写死本仓库的。
- 不是协议：没有传输层。
- 更不是「更好的 Cursor」—— 一次都没往这个方向设计过。

**新意判定**：机制层面没有发明（三值票决 ≈ selective prediction；到票率 ≈ 参与率阈值；凭证 ≈ 内容寻址），**新意在于坐标选择与纪律执行**：把这些学术上早已存在的想法，做成一个人每天真在用的 CLI，并且让「不通过」有退出码、有回执、有凭证。

---

## 5. 优势（每条带可核证据）

1. **成败语义只有一份，且看产物不看嘴**。`go`/`swarm`/`army` 三入口共用 `lib/outcome.mjs:23-57` 的 `judgeOutcome`：mtime ≥ 开工时刻、size ≥ 8B、`.mjs/.js/.cjs` 过 `node --check`，ok/partial/failed 三档，退出码跟随 verdict。这直接堵住「通道报成功但产物没落盘」——注释记录了真事故：177.2s 写完的产物被 180s 超时判死。
2. **到票率硬闸，缺席不算同意**。`vm/votes.mjs:104-132`：到票率 < 0.8（契约 `votes.arity`）一律 `unreviewed`；未声明应评名单时绝不允许落 ACCEPT。头注记录了改前漏洞：3 张 ACCEPT、应评 5 人、置信度 0.457 ≥ 0.45 就放行。
3. **判定结果双重计算对拍**。票决合成逻辑编译成 VM 字节码真执行一遍，与代码路径比对，不一致降级 `unreviewed`（`vm/votes.mjs:140-151`）；gate 的 `vm-smoke` 用契约参考向量重算，专抓「阈值被改但 gate 全绿」。
4. **收工闸门把「做完了」变成可验证**。`done` 依次过交付物验收 → gate 八步 → 评审票裁决，任一层不过退出码 4；`--yes` 硬结留审计标记；状态只写 `task.json` 一处（消除双写）。
5. **机器可读出口是一等公民**。任意动词 `--json` 只出 `{ok, verb, exitCode, data, log}`；退出码表定死；`--help` 在 dispatch 层被护栏拦截（注释记录了 `--help` 被当任务文本真派出三个子会话的事故）。
6. **失败便宜**。死通道 20s 出 `⏳`、可选 `ATWO_STALL_ABORT_MS` 硬掐；产物已落即判 ok（62 次回归里专门有一条反例测试防「拿旧产物冒充本次产出」）。

---

## 6. 可学习部分（机制级，不是口号）

| 来源 | 该抄什么 | 为什么现在缺 |
|---|---|---|
| LangGraph | checkpointer：派活状态落 `.atw/fanout/<id>/state.json`，崩了 `--resume` 只重跑死的那路 | 现在崩了只能整批重来 |
| promptfoo | 声明式断言 YAML + 可选 LLM-judge | 断言写死在 `packages/accept`，加一个断言要改代码 |
| Langfuse | trace_id/span schema 与按任务聚合查询 | 账本只能 grep，「这个月哪条通道变慢了」答不出 |
| GitHub Actions | 按变更裁剪测试 + 缓存 | gate 每次全量串行（97s 起） |
| Claude Code | pre-go / post-go hooks | 护栏全写死在 dispatch 层，项目方改不了 |
| MCP | `tools/list` schema 对齐 `caps --json` | 想被别的 agent 用，得手工抄参数 |

---

## 7. 缺点与风险（含两条一票否决级）

1. **误放行率拿不出证据（一票否决级）**。整套卖点是「不放行坏产物」，但没有任何数据回答「放行的产物里有多少其实是坏的」。gate 全绿只证明闸门在跑，不证明闸门抓得住东西。**这是价值主张的核心缺口。**
2. **额度是别人给的，通道是别人的（一票否决级）**。四个通道全是第三方闭源产品，靠 GUI 自动化或 CLI 驱动。任何一路改界面/改协议/改定价，对应功能即死，且无法提前发现（`atwo doctor` 只能查「现在通不通」）。本次实验里 trae 的模型切换就因为界面状态而失败。
3. **有效性数字全自产自查**。账本 692 条 log、115 条 score 里混着测试与假 orchestra 造的样本；`score` 报出的 0.385 通过率是脏的。没有基准集、没有复跑脚本、没有外部评审。
4. **单仓库纪律写死，泛化未证**。`lib/gate.mjs:30` 的扫描目录、`lib/should.mjs` 的热点文件、`vm/oracle-contract.json` 路径全是本仓库专用。换个项目全要重配——它现在是「这个仓库的工作流」，不是「一个产品」。
5. **`--yes`/`--force` 会侵蚀闸门**。硬结合法且没有频率统计与告警；若硬结成为常态，闸门形同虚设，而系统无法自己发现这一点。
6. **落盘器只服务「写代码」**。本次实验把一篇 markdown 论文落进了 `lib/outcome.codebuddy.mjs`，因「内容像 markdown」被判验收未过——**不是内容差，是归档格式没对齐**。
7. **GUI 通道不支持真并行**。模型选择是界面全局状态，并发 >1 会互相改档位，所以被迫加 `concurrentSame` 闸门；"四路并行"实际退化成串行排队 + 换路空转（本次 10 分钟里三路在换模型/换通道）。
8. **测试体系未被外部验证**。测试与源码同仓库、同作者；发现式跑测器防漏加，防不住断言本身写错。

---

## 8. 将来方向（P0/P1/P2，判据均可机器验证）

### P0 —— 补核心缺口，不做则一切说服力为零

| # | 做什么 | 完成判据（可机器验） |
|---|---|---|
| 1 | **误放行率测量**：≥50 个「已知坏产物」红队样本（语法过但行为错 / 落盘但跑不了 / 两路产物行为矛盾） | `node test/redteam.mjs` 存在，输出 `拦截 X/50`，X=50，退出码 0 |
| 2 | **bypass 可观测**：`memory/bypass.jsonl` 每次 `--yes/--force` 落一条 | `atwo score --bypass` 输出数字 == `wc -l memory/bypass.jsonl`，且可被测试 diff |
| 3 | **落盘格式对齐**：认 `.md` 交付物（文章/报告类任务不该逼成 `.mjs`） | 用本次这份 markdown PRD 重跑，产物落成 `docs/research/*.md`，`judgeOutcome` 判 ok |

### P1 —— 扩有效性证据

| # | 做什么 | 完成判据 |
|---|---|---|
| 4 | **断点续跑**：派活状态落盘，`--resume <id>` 只重跑死路 | 杀掉第 2 路后 resume，日志显示该路重跑、其余命中缓存，总耗时 < 全量 60% |
| 5 | **断言声明化**：`packages/accept` 支持 YAML 断言 | 同一份样本，YAML 版与手写版 accept 退出码一致（对拍脚本 exit 0） |
| 6 | **MCP 包装**：`atwo mcp` 起 server | 官方 MCP inspector 连上后工具数 == `caps` 动词数（20），diff 为空 |

### P2 —— 泛化与生态

| # | 做什么 | 完成判据 |
|---|---|---|
| 7 | **配置外置**：扫描目录/热点文件/契约路径进 `atwo.config.json` + schema 校验 | 在一个不含 `vm/` 的样例仓库里 `gate` 跑通，exitCode=0 |
| 8 | **模型评分层**：可选 LLM-judge 作第六层，默认关闭 | 开 10 好 / 10 坏产物，排序与人工标注一致率 ≥80%，脚本打印该数字 |

---

## 9. 结论（≤150 字）

值得继续做。坐标（AI 产出物的诚实裁决）横轴上六类软件都不占，两块资产（八步闸门、到票率 0.8 的三态票决）已可复用，且都带回归测试。但继续的前提是 P0 第一件：**一个自称防谎报的系统，如果自己的防线从未被测量，它现在只是一套纪律，不是一件工具。**

---

## 附录 A：功能清单（20 个动词，`atwo caps --json`）

`doctor`（体检通道）· `try`（试一次）· `should`（该不该这么干）· `gate`（八步闸门）· `score`（分数账本/趋势）· `attest`（凭证审计）· `pitfall`（坑账本）· `new`（开任务）· `go`（派活）· `check`（验收产物）· `diff`（多路分歧）· `judge`（三值判定）· `fanout`（长尾切分）· `triage`（失败三分类）· `army`（三三制阵型）· `batch`（批量）· `done`（收工闸门）· `state`（看状态）· `mode`（档位 strict/crazy/off）· `raw`（透传 orchestra）

## 附录 B：账本与退出码

- 账本：`memory/log.jsonl`（692 行，逐请求：agent/model/multiplier/points/ok/elapsedMs/usage/cached）· `score.jsonl`（115 行，逐验收断言）· `attest.jsonl`（3 行，逐文件凭证）· `pitfalls.jsonl`（坑账本）
- 退出码：`0` ok · `2` 用法错 · `3` 前置条件不满足 · `4` 验收不过 · `5` 通道失败/超时 · `6` 预算超支
- 通道与模型：4 通道 / 59 个模型；倍率 Hy3 **0.00x**、GLM-5.3-Flash 0.08x、DeepSeek-V4.1-Flash 0.11x、Kimi-K3.1-Pro 0.97x、Kimi-K3 1.62x

## 附录 C：本次评估的可复现命令

```bash
cd "/d/ai project/ai team work"
node test/all.mjs --quiet          # 66/66，97.2s
node atwo.mjs caps --json          # 20 动词
node atwo.mjs score                # 分数账本现状
node atwo.mjs attest               # 凭证审计（能抓出文件被改过）
node atwo.mjs mode crazy           # 切疯狂模式（四路+三评审+返工三轮+禁缓存）
node atwo.mjs go _probe/paper_prd/prd.md --size L --plan   # 四行预测
```
