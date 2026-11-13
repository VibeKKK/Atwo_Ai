# Orchestra

本机 AI 协作台。把任务派给真实在跑的三个 AI 客户端，并把它们的产出收回、记账、验收。

**一句话定位：单件活它必输，批量活它必赢。** 派一件活的成本（写 prompt + 等 + 验收）摊在一件事上是亏的；摊到 10 件事上才有意义。

## 三分钟上手

```bash
# 1. 看谁活着
node orchestra.mjs list
node orchestra.mjs health

# 2. 派一件活（快速验证）
node orchestra.mjs ask trae "只回复两个字：收到"

# 3. 真用：N 个独立任务同时甩出去
node orchestra.mjs swarm tasks.md
node orchestra.mjs swarm tasks.md --out report.md

# 4. 看并行到底省了多少
node orchestra.mjs top
```

## swarm —— 吞吐最高的一档

```bash
node orchestra.mjs swarm <任务源> [选项]
```

| 选项 | 作用 |
|---|---|
| `--agent auto\|trae\|codebuddy` | 分配策略，默认 auto（按任务性质分） |
| `--slots trae=1,codebuddy=6` | 各路并发数 |
| `--out report.md` | 报告落到文件（默认打 stdout） |
| `--resume` | 接着上次没跑完的批次继续 |
| `--no-switch` | 失败不换路重试（默认会 trae↔codebuddy 换一边再试一次） |

任务源三种写法：

```text
--- 分隔
---
每行一个（- 或 1. 开头）
- 也可以 ||| 内联分隔
```

### 分配规则（auto）

| 任务特征 | 给谁 | 为什么 |
|---|---|---|
| 要求产出代码/命令/测试（`写一个函数…`、`写条 bash 命令…`） | codebuddy | trae 的输出常编译不过；codebuddy 慢但准 |
| 散文短问答（≤800 字，不要代码） | trae | 20 秒出活，1 路串行也够快 |
| 超长文 / 超长工程活 | codebuddy | trae 单轮窗口吃不下 |

### 实测吞吐（2026-11-14，本机）

| 批次 | 任务 | 成功 | 墙钟 | 串行合计 | 提速 |
|---|---|---|---|---|---|
| 混合 6 个 | 6 | 6 | 103.3s | 255.4s | **2.47×** |
| 纯散文 10 个 | 10 | 10 | 136.5s | 293.1s | **2.15×** |

提速的来源不是「模型更快」，是 **trae 与 codebuddy 两条流水线同时跑**：总耗时 ≈ 最慢那一条，不是两者相加。

## 三个 agent 的能力边界（实测）

| agent | 传输 | 单次耗时 | 并发 | 强项 | 弱项 |
|---|---|---|---|---|---|
| `trae` | CDP 抓 Trae CN 的 Agent 页 | 19–36s | **1**（硬限制） | 散文问答、评审、快试错 | 代码常编译不过；会话约 8 回合后判据失灵 |
| `codebuddy` | CLI 子进程 | 54–118s | **6** | 整仓改造、要判据的活、结构化 JSON | 每次固定 ~7.6K input token；慢 |
| `workbuddy` | CDP 抓 WorkBuddy | 18–20s | 1 | 连续中文对话 | 需 WorkBuddy 开着；空产出风险 |

### Trae 的 8 回合天花板（重要）

Trae 会话列表是 DOM 虚拟化的，一条会话稳定承载约 8 个来回；超过之后「回合数」不再增长、文本指纹又可能撞车，判据失灵。开新会话这条路已被证伪（点新建后会话区读不到文本）。

所以 swarm 的做法不是硬修，而是**动态改派**：trae 组超过 8 个就自动把余下的转给 codebuddy（日志打 `⇄`）。用慢一点换「不失败」。

## 命令全表

```text
ask <agent> "<prompt>"      派一件活（自动附带共享工作记忆）
ask auto "<prompt>"         按任务性质自动挑 agent
review <agent> <file>        让对方审文件，结果存 reviews/
duo <a> <b> "p"             同题并行派给两个 agent，对比耗时与产出
batch <agent> <任务源>       N 个小任务压进一次调用（省 N-1 份固定开销）
swarm <任务源>               N 个独立任务跨 agent 并行（吞吐最高）
top [n]                      吞吐看板：每批墙钟 vs 串行、提速比
stats                        效率看板：次数/成功率/均耗时/token/成本
budget                       今天的额度账
health                       谁活着、谁占着锁、还剩多少额度
peek <agent>                 看它当前页面文本
list                         列出可用 agent
doctor                       环境体检
memory show|log|set-key      共享工作记忆
ctx "<任务>"                 看上下文分区预算表（零成本）
eph add|list|read            临时能力（会话级，不占常驻上下文）
```

## 成本模型

上下文六分区与上限（`lib/prompt.mjs`）：task 20000 / memory 1200 / project 900 / ephemeral 1200 / skill 3000 / contract 1400。

普通代码任务注入合计约 317 tok；带项目记忆约 377 tok。**真开销在适配层** —— codebuddy 每次固定 ~7,633 tok（CLI 自带 system prompt），所以省钱靠 `batch`，不是靠压 prompt。

结果缓存：同 agent + 同原始问题直接复用，不再付第二次钱。缓存键用**原始问题**而不是拼装后的 prompt（团队记忆每次都变，用拼装后的键永远不命中）。

## 已知限制（别踩）

- **trae 只有 1 路**，且 8 回合后要换会话 —— 大批散文任务的一半会自动改派给 codebuddy。
- **workbuddy 需要应用开着**，且历史上出现过 `ok:true` 但产出空的情况（2026-11-14 已加空产出判据，未复测）。
- **codebuddy 并发有上限**：6 路是默认，再高没有实测；积分会跟着路数烧。
- **失败会换路**：trae 失败自动换 codebuddy 再试一次，反过来也一样。这会拉长单任务耗时，但把整批成功率拉到接近 100%。
- **`.swarm/` 是批次产物**，含每任务的原始结果和 `_meta.json`，不进 git。

## 文件结构

```text
orchestra.mjs          命令入口（dispatch 内核在这里）
resume.mjs             项目记忆接续
pr.mjs                 提案式改动（PR 审阅门）
collab.mjs / pair.mjs  跨工作区通道
store.mjs              多 agent 并发共享库（事件日志，无锁）
agents/trae.mjs        Trae CDP 适配（含发送自愈、回合上限处理）
agents/codebuddy.mjs   CodeBuddy CLI 适配
agents/workbuddy.mjs   WorkBuddy CDP 适配
lib/swarm.mjs          群体派活引擎（分配 / 并发池 / 改派 / 报告）
lib/lock.mjs           锁池（同一 agent 多路并发）
lib/prompt.mjs         上下文六分区组装与预算
lib/contract.mjs       JSON 契约解析与 5 级修复链
lib/syntax.mjs         语法闸（py_compile / node --check）
lib/batch.mjs          批处理切分
lib/budget.mjs         额度记账
lib/cache.mjs          结果缓存
eval/                  24 任务评测集与结果
.swarm/                批次产物（不进 git）
```

## 纪律

- 派活前先 `node orchestra.mjs ctx "<任务>"` 看注入预算，零成本。
- 改 `orchestra.mjs` / `pr.mjs` / `collab/authority.json` / `package.json` 属 protected 级，走 PR 审阅门，rank1 放行。
- 项目状态不靠记忆：开工 `node resume.mjs list`，收工 `resume.mjs next` + `note`。
