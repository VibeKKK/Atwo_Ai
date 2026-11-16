# 切分的两把读盘尺子 + 异源父审台账（2026-11-17 01:30）

用户口述的排序是「效率优先，其次验收，就是把大任务分成可以完美契合的小任务」。
这一轮补的两件都属于「分得对」而不是「分得多」：
① 谁去哪片 —— 按字节而不是按单元个数（`lib/split-load.mjs`）
② 谁有资格当父审 —— 按台账而不是按记忆（`lib/reviewer-ledger.mjs`）

## 一、负载与耦合：为什么按个数均衡是错的

原 `planSplit` 的分配是 `units.forEach((u, i) => chunks[i % count].push(u))` —— 一个 60 行的
`lib/score.mjs` 与一个 1400 行的 `lib/gate.mjs` 各算一个单元。片大小差 40 倍时，
「4 片」实际是「1 片干一半 + 3 片分另一半」，墙钟仍由最大那片决定。

实测（6 个真文件，3 片，2026-11-17 01:12）：

| 分配方式 | 三片字节 | 最大/最小 | 判定 |
|---|---|---|---|
| 轮分（按个数） | 41KB / 23KB / 14KB | 2.84× | ✗ 超 2.5× 上限 |
| LPT（按字节，大的先放给最轻的片） | 28KB / 24KB / 26KB | 1.18× | ✓ |

片数、片序、`label`（`chunk-i/n`）都不变 —— `mergeParts` 靠 label 对齐，改分配不该动它。

第二条读盘尺子是**耦合**：`a.mjs` import `b.mjs` 被切到两片时，两路子会话会各自去读对方的文件、
各自给一份结论，合并出两个互相矛盾的「同一件事」。这是切分唯一会造成**错误**的副作用，
不只是慢 —— 所以它必须能被机器数出来，而不是靠人记得「这两个文件有关」。

## 二、三条判据（都只降级 weak，不判死）

| 判据 | 判什么 | 不过时的动作 |
|---|---|---|
| `load-balanced` | 最大片/最小片字节 ≤ 2.5× | 打印告警，照跑（慢不是错） |
| `coupling` | 跨片 import 边数必须 0，非 0 报前三条 `a→b` | 打印告警，照跑（父审能发现矛盾） |
| `load-covered` | 每片字节 > 0（有 0 字节片说明 stat 全失败） | 打印告警：此时均衡数字没有意义 |

口径与 `split.mjs` 现有七判据一致：**机器只能报警，切分的错要人来定**。
`split.mjs` 的 `bad` 会拒跑（`EXIT.precondition=3`），这里三条只加 `weak`。

## 三、接线

- `lib/fanout-run.mjs`：新增 `opts.splitPlan` —— 外部算好并均衡过的计划优先，
  不再自己重算（均衡要 stat 每个单元，属于「读盘的尺子」，放 CLI 侧算一次、把结果当纯数据传进来，
  `runFanout` 才能保持可注入、可测）。
- `lib/fanout-cli.mjs`：`planSplit` → `checkSplit`（bad 拒跑）→ `rebalanceByLoad` → `checkLoad`（weak 告警）
  → `splitPlan` 传下去。真跑时多打一行 `负载质量`。

## 四、异源父审台账：`lib/reviewer-ledger.mjs`

异源评审的价值全压在「另一家真的能读、真的会给票」。而这件事昨天只有一句话的证据：

```
codebuddy  25.2s  两票 PASS 引原文                   → 可用（同源）
trae      187.4s  先回「思考中」占位，然后不答        → 不可用
workbuddy  19.6s  「抱歉，发生未知错误暂无响应…」      → 不可用
ollama     29.0s  理由同一句循环 + 自相矛盾判 REVISE   → 不可用
```

台账把每次探活（`atwo doctor --reviewers`）与每次真跑父审都写一行到
`memory/reviewer-ledger.jsonl`（`memory/` 在 .gitignore 里 —— 运行时证据，不进源码）：

```json
{"v":1,"contract":"atwo-reviewer-ledger/1","ts":"...","lane":"workbuddy","ok":true,"ms":30300,"source":"probe"}
```

判读（只看**最近 5 次**，老战绩不续命）：

| verdict | 条件 | 含义 |
|---|---|---|
| `usable` | 最近 5 次里 ≥3 次成，且失败不连续 ≥3 | 可以当父审 |
| `flaky` | 成过，但不够门槛 | 可试，不许在报告里写成「异源评审通过」 |
| `dead` | 连败 ≥3 次，或窗口内全败 | 别用 |
| `unknown` | 没有样本 | **不等于可用，也不等于不可用** —— 没测过的东西不许说成可用 |

`recommendReviewers()` 只推荐 `usable` 且中位耗时更短的；一个都没有时明说
「先跑 `atwo doctor --reviewers` 探活」，不拿 flaky 顶上。

## 五、改动文件

| 文件 | 改动 | 归属 |
|---|---|---|
| `lib/split-load.mjs` | 新建（unitBytes / loadOfChunk / rebalanceByLoad / importEdges / crossChunkEdges / checkLoad / renderLoadLine） | 本会话 |
| `lib/reviewer-ledger.mjs` | 新建（appendEntry / readLedger / summarizeLane / summarizeLedger / recommendReviewers / renderLedger / recordProbes） | 本会话 |
| `lib/fanout-run.mjs` | `opts.splitPlan` 支持 + `assembleReviews` 返回 `errs` + 真跑父审记账 | 本会话 |
| `lib/fanout-cli.mjs` | 负载质量打印 + 传 `splitPlan` | 本会话 |
| `lib/reviewer-probe.mjs` | `probeReviewers` 探活记账（`record:false` 可关） | 本会话 |
| `test/split_load.test.mjs` | 22 条 | 本会话 |
| `test/reviewer_ledger.test.mjs` | 21 条 | 本会话 |

没动 `lib/split.mjs`（`checkSplit` 正被对端改）、没动 `atwo.mjs`（同上）。
新判据宁可另起一个文件，也不往别人正在写的文件里插行。

## 六、已知不对称（别当成完备）

1. `coupling` 只数**直接** import（`from './x.mjs'` / `import()` / `require()`），
   传递依赖（a→b→c，a 与 c 分两片）不会报。做传递闭包要建全图，代价比收益大。
2. 台账是**本地旁证**：它证明「这台机器上这段时间里这条通道成过几次」，
   不能证明「同一个模型换个网络还成」。跨机器比对需要把 ledger 挪出来，目前没做。
3. `coupling` 的 `weak` 不会拒跑 —— 真正会让两路打架的情况仍要靠父审发现矛盾票。
4. 负载按**源文件字节**估，不按「子会话实际读多久」估：字节是能一次算准的量，
   读多久要看模型。实测 6 文件 3 片时字节比与墙钟方向一致，但没有逐次对照实验。

## 七、回滚

```bash
git checkout -- lib/fanout-run.mjs lib/fanout-cli.mjs lib/reviewer-probe.mjs
rm -f lib/split-load.mjs lib/reviewer-ledger.mjs test/split_load.test.mjs test/reviewer_ledger.test.mjs
rm -f memory/reviewer-ledger.jsonl
```
回滚 `lib/fanout-cli.mjs` 会连带退回「`--split` 只做个数均衡」；`opts.splitPlan` 是纯增参，
旧调用方不传时行为不变。
