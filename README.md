# Orchestra

> **0.2.0-alpha（2026-11-17）** · 装：[SETUP.md](SETUP.md) · 边界：[KNOWN-LIMITS.md](KNOWN-LIMITS.md) · 判定层不依赖任何 AI 通道

本机 AI 协作台。把任务派给真实在跑的三个 AI 客户端，并把它们的产出收回、记账、验收。

**一句话定位：效率优先 —— 把一个大任务切成能完美契合的小任务，让并行的每一份都小、都确定、都不互相踩；验收是兜底，不是卖点。** 派一件活的成本（写 prompt + 等 + 验收）摊在一件事上是亏的；摊到 10 件事上才有意义。

**默认档只花小钱**：strict 档（默认）选出的模型，积分倍率必须 ≤ 0.50x，且倍率未知的模型一律不进默认档（未知不当作 0）。当前默认组合：Hy3 0.00x · GLM-5.3-Flash 0.08x · DeepSeek-V4.1-Flash 0.11x。要放开用 `atwo mode crazy`。

## 三分钟上手

```bash
# 安装（本地链接，不需要发布到 npm）
npm link          # 之后全局可用 orch

# 1. 看谁活着
orch list                 # 三个通道与各自强项
orch health               # 谁活着 / 谁占着锁 / 今天还剩多少额度

# 2. 派一件活（快速验证）
orch ask trae "只回复两个字：收到"

# 3. 真用：N 个独立任务同时甩出去
orch swarm tasks.md
orch swarm tasks.md --out report.md

# 4. 看并行到底省了多少
orch top
```

不想 `npm link` 也能直接用 `node orchestra.mjs <cmd>`，两者等价（`orch` 只是子命令路由）。

## 机器可读输出

所有查询类命令都支持 `--json`，输出 `{ok:true,…}`；错误输出 `{ok:false,code,message}`，并带非零退出码。这样别的 agent / 脚本不用正则解析中文表格。

```bash
orch list --json
orch stats --json
orch budget --json
orch health --json
orch db list project --json
orch db dbs --json
```

## 共享数据库（两套库，互不占用）

```bash
# 项目库：会过期的状态（进度 / 待办 / 交付物）
orch db put project orchestra '{"状态":"开发中","下一步":"接入 CI"}'

# 记忆库：不过期的方法（决策 / 教训 / 事实）
orch db put 原则 判据 "不要拿界面现象猜内部状态" --db memory --note "三次误判的总结"

orch db list project           # 看某库某表
orch db log --since 30m        # 看最近谁改了什么
orch db dbs                    # 两套库一起看
```

写入是追加式日志 + 每 agent 独立文件（单条 < 4096 字节时 append 原子），**读写都不加锁**；`compact` 折叠成快照，读路径会先读快照再叠日志。

## 并肩看板

```bash
orch peer                # 双方状态 + 未读信 + 两套库摘要
orch peer me "正在改存储层"
orch peer post "存储修复已提交" --topic 存储
```

## atw —— 把这套装成 MCP 工具

除了 CLI，Orchestra 还能以 **MCP server** 的形式挂在任意支持 MCP 的客户端里（DSH / Claude Desktop / 自研 agent 都行）。
服务端 `tools/atw-mcp.mjs` 零依赖，只用 newline-delimited JSON-RPC（不是 LSP 的 Content-Length 帧）。

```jsonc
// 客户端注册示例（DSH: ~/.dsh/profiles/desktop/cordis.yml）
{
  "id": "mcp-atw",
  "name": "@deepseek-ai/dsh-mcp-client",
  "config": {
    "serverName": "atw",
    "transport": "stdio",
    "command": "<node 可执行文件>",
    "args": ["<仓库>/tools/atw-mcp.mjs"],
    "env": { "ELECTRON_RUN_AS_NODE": "1" },
    "failOnStartupError": false   // 建议 false，但记得自己去验证工具真的挂上了
  }
}
```

| 工具 | 用途 |
|---|---|
| `atw_do` | 目标级派活：自动拆任务 → 派给各通道 → 并行 → 带落盘和验收回来 |
| `atw_ask` | 派一个已拆好的明确任务给指定通道，拿回结果文本 |
| `atw_swarm` | N 个独立任务跨通道并行，失败自动换路重试 |
| `atw_health` | 四条通道是否活着、当前额度、有没有卡住的锁 |
| `atw_stats` | 台账：调用次数 / 成功率 / 平均耗时 / 平均字符数 / 累计 token |
| `atw_db` | **直接读写两套共享库**（`list/get/put/del/history/tables/stat`，不派活、不花额度、毫秒级） |
| `atw_peer` | **并肩看板与投信**（`board/post/read`），走 `pair.mjs` 的文件信箱 |

`atw_db` / `atw_peer` 与 CLI 完全同一份数据：从 MCP 里 `put` 的一行，`orch db list` 立刻看得见，反之亦然。

### 派活自动记账
`atw_ask` / `atw_do` / `atw_swarm` 每次调用都会往**记忆库**的 `atw` 表写一行：
`{tool, argv, code, ok, ms, head}`，`by = "atw-mcp"`。
于是「今天派了多少活、成功几成、平均多慢」不再靠翻日志，`atw_stats` / `orch db list atw` 直接给。

### 起不来怎么查（按顺序）
1. `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node tools/atw-mcp.mjs` —— 有 `serverInfo` 说明服务端没问题
2. 客户端里看不到 `atw_*` → 是客户端侧加载失败，`failOnStartupError: false` 会把它静默吞掉，**别以为配好了**
3. 宿主是 Electron（如 DSH）时必须带 `env.ELECTRON_RUN_AS_NODE=1`，否则 node 脚本会被当成 GUI 入口

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

- 派活前先 `orch ctx "<任务>"` 看注入预算，零成本。
- 改 `orchestra.mjs` / `pr.mjs` / `collab/authority.json` / `package.json` 属 protected 级，走 PR 审阅门，rank1 放行。
- 项目状态不靠记忆：开工 `node resume.mjs list`，收工 `resume.mjs next` + `note`。
- 查询类命令一律优先用 `--json` 取值，不要解析中文文本。

## 测试

```bash
npm test              # 纯函数 31 项 + 锁池 + 脱机 batch
npm run eval:check    # 评测判据自检 9/9
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
