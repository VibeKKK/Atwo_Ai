# AI 使用规程（AI-USAGE）

> 这份文件写给**任何装上本插件的 DSH 实例**。
> 不是建议，是执行约定：每条都写了「必须怎么做」和「怎么自证做到了」。
> 违规不会报错，只会让协作退化成一个昂贵的聊天框——所以必须自查。

---

## 零、一句话总纲

**这是一个工具，也是一个技能。有任务就调用，不要放着。**

Orchestra 存在的唯一理由是吞吐：它能让四个外部 AI 并行替你干活。把它当摆设，等于花同样的机器成本只拿到 1/4 的产出。

---

## 一、开工第一件事：查有哪些 agent 可用

**必须动作**：任何任务开始前，先跑一次

```bash
node orchestra.mjs list
# 输出：agents: trae, codebuddy, workbuddy, doubao
```

**当前四个通道（2026-11-15 实测）**：

| agent | 类型 | 特点 | 默认工作区 |
|---|---|---|---|
| `trae` | DOM 客户端 | 评审 / 自然语言质量高；出代码会丢语法字符 | `D:\ai work replace\trae place\work test one` |
| `codebuddy` | **CLI 子进程** | **唯一能直出字节的通道**，零 DOM 损耗，出码可直接落盘 | 当前目录 |
| `workbuddy` | DOM 客户端 | 有快路 9224，~22s/次；语法字符会丢 | `D:\ai work replace\workbuddy place\work test one` |
| `doubao` | DOM 客户端 | 文件信箱模式，22.8s，字符零损伤 | `D:\ai work replace\doubao place\work test one` |

**如果没有 agent 可用**（`list` 为空 / 某个 agent 报错）：
1. 跑 `node orchestra.mjs doctor` 看是哪一环断了
2. 把具体断点告诉用户（端口没开 / 客户端没启动 / 额度用完 / CLI 没装）
3. **不要假装派活成功**——空结果比失败更有害

**怎么自证**：任务开始前的第一条命令必须是 `list` 或 `doctor`，日志里能查到。

---

## 二、派活之前必须先有工作区

**必须动作**：任何 agent 干活，产出的文件必须有确定的落盘位置。

**工作区规矩**：

```
D:\ai work replace\
├─ trae place\work test one\        ← trae 私有
├─ workbuddy place\work test one\   ← workbuddy 私有
├─ doubao place\work test one\      ← doubao 私有
└─ TDW place\                        ← 三通道公用（有特殊需求时用）
```

**没有工作区怎么办**：**自己建**。

```bash
mkdir -p "D:/ai work replace/<agent> place/work test one/.mailbox"
```

在代码里走 `opts.workspace` 或 `opts.shared`：
- `opts.workspace` = 指定路径（最高优先）
- `opts.shared = true` = 用公用区 `TDW place`
- 都不给 = 用该 agent 的私有默认区

**为什么必须**：DOM 通道的产物走文件信箱，没有信箱目录就没有交付物。裸问一句「写个函数」，它会答在聊天框里，然后被渲染器吃掉语法字符——这就是之前反引号全丢、井号全丢的事故来源。

**怎么自证**：派活前 `ls` 一次目标目录，确认存在。

---

## 三、工具与用法统一规范

### 3.1 派活的五个层级（按吞吐从低到高）

| 命令 | 用途 | 什么时候用 |
|---|---|---|
| `ask <agent> "<p>"` | 单次派活 | 问一句、审一段 |
| `ask auto "<p>"` | 自动挑 agent | 不确定该给谁 |
| `duo <a> <b> "<p>"` | 同题双跑对比 | 要选型 / 要比质量 |
| `batch <agent> <任务源>` | N 个小任务压一次调用 | 一堆小活，省 N−1 份固定开销 |
| `swarm <任务源>` | 跨 agent 并行 | **吞吐最高**，任务互相独立时首选 |
| `sub "<目标>" --n 3` | 拆子任务并行 | 一个大目标能拆成互不依赖的小块 |

**必须遵守**：任务数 ≥ 3 且彼此独立 → **不许用 ask 循环，必须用 swarm**。

### 3.2 要产物就必须开验收

```bash
node orchestra.mjs swarm tasks.md --land --verify
```

- `--land`：把代码抽出来写到文件
- `--verify`：落盘后跑语法检查 + 断言
- `--max-fix N`：验收失败自动重试次数

**不带这两个开关，等于让对方在聊天框里写给你看** —— 语法字符会丢，缩进会丢，回来的是残缺品。

带了这两个开关，swarm 会自动切到文件信箱模式（`askViaMailbox`），产物由对方写进磁盘、我方读文件，字节零损耗。

**怎么自证**：`git status` 能看到新文件，`node --check` 通过。

### 3.3 额度是闸门，不是额度

```bash
node orchestra.mjs health   # 谁活着、谁占锁、还剩多少次
node orchestra.mjs budget    # 今天的账
```

额度存在 `memory/budget.json`，判定在 `lib/budget.mjs:63`：

```js
if (lim.dailyCalls && used.calls >= lim.dailyCalls) { /* 拦住 */ }
```

那个 `&&` 意味着 **`0` = 无限**。想让某通道放开就写 0；想限量就写具体数字。

**当前上限（2026-11-15 起）**：四条通道各 400 次/天，codebuddy token 上限 300 万。

### 3.4 记忆与提案

```bash
node resume.mjs init <路径> --name 项目名   # 建项目记忆
node resume.mjs list                        # 所有项目的下一步/卡住
node resume.mjs <项目> --slim               # 一行版，塞进 prompt

node pr.mjs start "<标题>"     # 开提案
node pr.mjs finish             # 收尾提交
node pr.mjs review <id> --by rank2 --note "..."   # 审阅
node pr.mjs approve <id>       # 合并
node pr.mjs list               # 全部提案
```

**审阅门按风险分级**：
- `docs`（文档/记忆）→ rank2 审过即可
- `code`（代码）→ 必须 rank1
- `protected`（`orchestra.mjs` / `pr.mjs` / `SHARED.md` / `authority.json` / `lib/vcs.mjs` / `package.json`）→ 必须 rank1，且 rank2 必须知情

**必须遵守**：改任何 `lib/` 或 `agents/` 之前先 `pr.mjs start`；完工立刻 `finish`。
**永远不要 `git add -A`** —— 共享工作区里那等于替别人签字（`SHARED.md` §9.5 有真实事故记录）。

---

## 四、会话用完必须自己删（软件层面，不许点 UI）

**规则**：项目/工作区的会话在**彻底结束后**，由 AI 自己清理，走文件与 sqlite 层面，不操控鼠标键盘。

**工具**：`node tools/wb-clean.mjs`

```bash
node tools/wb-clean.mjs --list            # 先看：会话 + 磁盘占用（只读）
node tools/wb-clean.mjs --purge-backups   # 删 modify_backup（体积大户）
node tools/wb-clean.mjs --purge-empty     # 删空目录
node tools/wb-clean.mjs --purge-orphans   # 删 sqlite 里已不存在的目录
node tools/wb-clean.mjs --soft <id>       # 软删（写 deleted_at，UI 里消失）
node tools/wb-clean.mjs --hard <id>       # 硬删（行 + 目录，不可恢复）
node tools/wb-clean.mjs --vacuum          # 回收 sqlite 空间
```

**必须遵守**：
1. 破坏性操作默认 dry-run，**必须加 `--yes` 才真执行**
2. 删之前先 `--list`，确认哪些是「已完工」而不是「还在跑」
3. 删会话用 `--soft` 优先；`--hard` 只在确认无价值时用

**实测战果**：`--purge-backups` 一次释放 908.4 MB（915.1 MB → 6.9 MB）。

**怎么自证**：`--list` 前后对比磁盘占用。

---

## 五、别人在写代码时，你不许发呆

**规则**：总管（rank1）和副总管（rank2）把任务派给其余 agent 时，**下派者本人必须同时有产出**——要么写自己那份交付物，要么产出规划/评审/验收结论。

**为什么**：外部 agent 是并行资源，不是替代品。四个通道满负荷跑，指挥席空转，等于花了四份钱只拿三份产出，而且**失去了验收能力**（没人验收，错误交付会一路流到用户手上）。

**必须动作**（三选一，不许都不做）：

| 角色 | 必须产出 |
|---|---|
| 派活者 | 自己那份交付物（可以是验收脚本、文档、测试用例） |
| 派活者 | 设计规划（拆解依据、接口约定、失败回退路径） |
| 派活者 | 验收结论（逐条对照需求，指出哪里不符、怎么改） |

**实证**：验收机制连续三次抓住真实错交付——`docs/EXTENDING.md` 装的是 JS 不是文档、星号被 markdown 吃掉导致语法错误、串味的旧答案。**这三次都是「派活者自己动脑」才发现的，纯等待的流程一次都发现不了。**

---

## 六、最重要的一条：有任务就调用，一直用到额度见底

**这不是「有空时可以用」，是「有任务就必须用」。**

### 6.1 判断标准（满足任一就调）

- 任务需要写超过 30 行代码
- 任务需要第二种视角（评审 / 找错 / 对比方案）
- 任务有 ≥ 3 个可并行的独立部分
- 任务里有一段「我写起来会重复劳动」的部分（文档、用例、样板）
- 你正准备回答「这个问题我可以直接答」——**先问自己：这答案值不值得拿一个外部通道去验证**

### 6.2 用满，不要省

额度见底之前不要停。理由：

- 额度是**本地闸门**（`memory/budget.json`），不是平台配额，改一个数字就放宽了
- 空转的额度**不会累积到明天**（按天清零）
- 四个通道的真实成本差异极大：`codebuddy` 出字节零损耗，`trae` 评审质量最高，`doubao` 信箱模式 22.8s 且字符无损——**用错通道才是浪费，用满不是**

### 6.3 反例（真实发生过的浪费）

- 手写了 137 行 `docs/EXTENDING.md`，让 codebuddy 写大约 30 秒 —— 没派，结果 codebuddy 把「写指南」理解成「写可执行 demo」，交付的是 178 行 JS，被验收抓住
- 三个通道全部登记好了，主流程还在用 DOM 抓取 —— 信箱躺了整整一晚没人调

### 6.4 收尾动作

每次用完之后**必须**记一笔：

```bash
node orchestra.mjs stats      # 次数 / 成功率 / 均耗时 / 均字符 / token
node orchestra.mjs health     # 四个通道各剩多少
```

数字进 `memory/STATE.md`，下一次开工的人（可能是另一个工作区的你）能直接读到哪条通道更快、哪条更容易丢字符。

---

## 七、清单（开工前对着念一遍）

- [ ] `orchestra.mjs list` 或 `doctor` —— 有哪些 agent 可用？有没有断的？
- [ ] 工作区存在吗？不存在就 `mkdir`
- [ ] 任务数 ≥ 3 且独立 → 用 `swarm`，不许 ask 循环
- [ ] 要产物 → 带 `--land --verify`
- [ ] 改 `lib/` `agents/` → 先 `pr.mjs start`
- [ ] 我在派活的同时，我自己在写什么？
- [ ] 用完了 → `stats` + `health` 记数
- [ ] 会话完工了 → `wb-clean.mjs --list` 看一眼，然后清

---

## 附：文件地图

| 文件 | 作用 |
|---|---|
| `orchestra.mjs` | 主入口，20+ 命令 |
| `agents/*.mjs` | 四个通道的适配器（trae / codebuddy / workbuddy / doubao） |
| `lib/swarm.mjs` | 并行调度 + 文件信箱接管 |
| `lib/budget.mjs` | 额度闸门（0 = 无限） |
| `lib/verify.mjs` / `lib/land.mjs` | 落盘 + 验收 |
| `pr.mjs` | 提案 + 审阅门（protected） |
| `resume.mjs` | 项目记忆接续 |
| `collab/SHARED.md` | 两个总管之间的规程（protected） |
| `tools/wb-clean.mjs` | 会话清理（纯文件层） |
| `memory/STATE.md` | 已确认的事实 |
| `memory/budget.json` | 额度配置 |
