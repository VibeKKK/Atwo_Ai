# Atwo

> **0.2.0-alpha**（2026-11-17） · 装：[SETUP.md](SETUP.md) · 边界：[KNOWN-LIMITS.md](KNOWN-LIMITS.md) · 决策记录：[docs/decisions/](docs/decisions/)

**给 AI 用的任务编排与验收 CLI。** 把一个大任务切成互不踩的小份，并行派给真实在跑的多个 AI 客户端（CodeBuddy / Trae / WorkBuddy / Ollama），收回来的每一份都要过三层闸门，最后给一句机器能读的结论。

一句话定位：**效率优先。** 派一件活的成本（写 prompt + 等 + 验收）摊在一件事上是亏的，摊到十件事上才有意义；验收是兜底，不是卖点。

---

## 它治三种病

| 病 | 症状 | 它怎么治 |
|---|---|---|
| **上下文爆炸** | 一个会话塞进十件事，爆窗之后所有工作瞬间不可访问，压缩也救不了 | 每个子会话独立上下文，只回产物；主对话只留结论 |
| **假完成** | 「做完了」= 模型说做完了。测试没跑、文件没生成、行号是编的 | 机械闸门先判（0 次 LLM，约 3ms），父审再核引用，两道都过才算 PASS |
| **结论不可复算** | 判定靠感觉，改一个阈值没人知道哪些结论失效了 | 判定跑在三值字节码机上，阈值只在 `vm/oracle-contract.json` 定义，凭证带契约哈希 |

## 四个机制（都能单独用）

### 1. `fanout` —— 派活 / 父审 / 自愈

```bash
node atwo.mjs fanout --task "把 lib 下 12 个模块各补一组边界用例" --parts 4 --follow
```

子会话默认 **只读**（`Read,Grep,Glob`）—— 这是被事故逼出来的：一次派活里子会话把 `vm/judge.mjs` 整份覆写成了 LLM 的回答正文。要写必须显式 `--allow-write`。

回来之后：机械闸门 → 父审（可异源）→ 打回的自动带理由重发一次 → 票面结算。`--allow-run` 打开后子会话可以在影子副本里真跑命令，`RUN ... → exit N` 这类证据会被机械层重跑核对，谎报 exit 码当场被抓。

### 2. `army` —— 三三制阵型

```bash
node atwo.mjs army --task-file spec.md --units api/a.mjs,api/b.mjs --reviewers 2
```

侦察 1 路（只给候选，不许当事实）→ 主力 N 路（一单元一路，异题并行）→ 评审 M 路（只找反例，不许重写）→ 票面结算。适合「一个 PRD 里有一堆互不相同的单元」；**单任务别用**，比直接干慢 72%。

### 3. `pregate` —— 机械闸门

不花钱、不调模型，先判死四类假产物：

- `EVIDENCE` 为空或占位
- 一处「文件:行」都没有
- 行号超出文件真实长度（编造的）
- 引用了那一行，但同行关键数字被改过（`MAX_PARTS = 6` 写成 `99`）

标定过 30 份真实产物：正常产物零重叠率 ≤17%，小模型编造产物 100%。

### 4. `judge` + `attest` —— 判定可复算

```bash
node atwo.mjs judge --z 1.2,1.1,1.3 --attest    # 给一组标准分，出三态结论 + 可复算凭证
node atwo.mjs attest                            # 扫凭证：哪些因文件改动而失效
```

`value` 唯一来自三值字节码机的真执行，并与直算结果对照，两者不一致按证据不足算。凭证绑程序、输入、输出、契约内容哈希 —— 契约换了尺子，旧凭证立刻标 `contract-changed`。

### 0. `gate` —— 九步闸门（收工前跑它，别靠印象）

```bash
node atwo.mjs gate --no-tests   # 约 12s
```

`closure`（import 的文件在不在）→ `syntax`（全量 `node --check`）→ `exports`（引用的导出名存在吗）→ `contract`（阈值有没有写死在代码里）→ `vm-smoke`（参考向量重算）→ `tests` → `pollution`（源文件里混进测试内容）→ `accept`（五层验收）→ `uncommitted`。任何一步红就 `exit 4`。

---

## 60 秒上手

```bash
py -3 .atw/scripts/init_developer.py <你的名字>   # 只做一次；不建它，new 会报 No developer set

node atwo.mjs doctor              # 环境体检：通道、端口、可执行文件
node atwo.mjs try                 # 两秒自检：闭包 + 判定 + 编队上限，三条断言
node atwo.mjs caps --json         # 全部动词 + 参数 + 退出码 + 上限，一屏 JSON

node atwo.mjs new "冒烟：确认能建任务"   # 第一次写盘；这三条全绿也不代表它能用
node atwo.mjs should "把 lib 下 12 个模块各补一组边界用例"   # 该派还是自己干（零成本）
node atwo.mjs state               # 当前任务 / 其他打开的任务 / 负载
```

前三条都是「读」，`new` 是第一次「写」—— 全新 clone 卡住的地方往往就在这里。完整步骤见 [SETUP.md](SETUP.md)。

退出码是契约，不是装饰：`0` 成功 · `2` 用法错 · `3` 前置不满足 · `4` 验收红 · `5` 通道拿不到 · `6` 预算。**4 表示「跑成了但结论是红」**，不是环境坏。

---

## 实测数字（本机，2026-11-17）

| 项 | 数字 | 口径 |
|---|---|---|
| 多任务并行 | **6.5×** | 12 个互不相同的任务：并行 216.8s vs 串行 1416s；墙钟等于最慢那一个 |
| 并发曲线 | 6–8 路是拐点 | 1/3/6/12 路 = 4.85 / 4.92 / 7.18 / 12.46s；12 路时单路从 4.85s 涨到 11.05s |
| 上游封顶 | 32 路 0.66/s | 本机不是瓶颈（32 路时空闲内存反升），瓶颈在账号与上游 |
| 长尾切分 | 1.2–1.4× | 8 文件 53s → `--split 4` 38s；但「一条命令能扫完」的活切了反而慢（0.60×） |
| 父审固定成本 | 约 50s 地板 | 单片父审不随内容变；所以省时间靠流水线重叠，不靠切得更碎 |
| 闸门 | 九步 12s / 带测试约 50s | `gate --no-tests` 与 `gate` |
| 测试 | **130 / 130 · 92s** | 干净检出（`git worktree add --detach HEAD`）跑全量；有负载时会假红，runner 会复跑判定 |

---

## 它不做什么

- **不生产智能。** 模型还是你选的。同一道题、同一个模型，单通道速度与直接用它一样（甚至多一层 spawn）。省的是上下文与返工，不是推理。
- **不是云端。** 单机 + GUI 窗口独占。CodeBuddy 是 CLI 子进程（6–8 路），Trae / WorkBuddy 走 CDP 抓窗口（各 1 路）。
- **异源评审有门槛。** 「探活通过」不等于「能审真产物」：GUI 通道的 Read 在它自己的工作区跑，读不到本仓库，所以它说「文件不存在」时是核不了，不是产物错。
- **没有盲测基线。** 父审抓错的证据目前来自自造对照组与真实事故，不是统计意义上的准确率。

详细边界见 [KNOWN-LIMITS.md](KNOWN-LIMITS.md)，每处设计为什么这么定见 [docs/decisions/](docs/decisions/)。

---

## 附：多通道编排（`orchestra`，老一层）

`atwo` 之上的派活引擎仍然保留，入口是 `orchestra.mjs`（`npm link` 后可简写 `orch`）：

```bash
orch list                 # 四条通道与各自强项
orch health               # 谁活着 / 谁占着锁 / 今天还剩多少额度
orch ask trae "只回复两个字：收到"
orch swarm tasks.md       # N 个独立任务跨通道并行
orch top                  # 吞吐看板：每批墙钟 vs 串行、提速比
```

| 通道 | 传输 | 单次耗时 | 并发 | 强项 | 弱项 |
|---|---|---|---|---|---|
| `codebuddy` | CLI 子进程 | 54–118s | **6** | 整仓改造、要判据的活、结构化 JSON | 每次固定 ~7.6K input token；慢 |
| `trae` | CDP 抓 Trae CN | 19–36s | 1 | 散文问答、评审、快试错 | 代码常编译不过；会话约 8 回合后判据失灵 |
| `workbuddy` | CDP 抓 WorkBuddy | 18–20s | 1 | 连续中文对话 | 需应用开着；空产出风险 |
| `ollama` | 本地 HTTP | 2–10s | 2 | 零成本草稿、草稿分层 | 8B 会编造引用（机械闸门抓得到） |

**Trae 的 8 回合天花板**：会话列表是 DOM 虚拟化的，一条会话稳定承载约 8 个来回，超过之后回合数不再增长、文本指纹可能撞车。`swarm` 的处理不是硬修，而是自动改派（`⇄`）—— 用慢一点换不失败。

**成本模型**：上下文六分区上限（`lib/prompt.mjs`）task 20000 / memory 1200 / project 900 / ephemeral 1200 / skill 3000 / contract 1400；普通代码任务注入约 317 tok。真开销在适配层，所以省钱靠 `batch`，不是靠压 prompt。

还有两套无锁共享库（项目库 / 记忆库，事件日志 + 每 agent 独立文件）与跨工作区信箱（`pair.mjs`），用法见 `orch db` / `orch peer`。

## 文件结构

```text
atwo.mjs                任务编排 CLI 入口（35 个动词）
lib/cli-spec.mjs        动词 / 参数 / 退出码的单一真源
lib/fanout*.mjs         派活 → 闸门 → 父审 → 自愈
lib/army*.mjs           三三制阵型（侦察 / 主力 / 评审）
lib/pregate.mjs         机械闸门（空证据 / 编造行号 / 改数字 / RUN 不符）
lib/gate.mjs            九步收工闸门
lib/sandbox.mjs         影子副本 + 命令白名单（执行面）
lib/blind*.mjs          盲测与客观标签器
vm/                     三值字节码机、判定服务、双实现对拍
agents/                 各通道适配（codebuddy / trae / workbuddy / ollama / deepseek）
orchestra.mjs           多通道派活引擎（swarm / ask / health / stats）
test/                  131 个测试文件 · 一条命令跑 130 项（发现式入口）
docs/decisions/         每处设计为什么这么定（30+ 篇）
```

## 测试

```bash
node test/all.mjs        # 全部：约 92s，失败会单跑复验一次（区分假红与真红）
node test/all.mjs --dir test   # 只跑某个目录
npm test                 # = node test/all.mjs
```

## 许可证

MIT，见 [LICENSE](LICENSE)。