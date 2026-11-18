# atwo 接口契约（冻结版 · 2026-11-19）

这张纸只做一件事：**钉住别人接 atwo 时会碰到的三个口**。往后只许「修」，不许「增」——
新增动词必须同时退役一个，且必须由**外部真值需求**驱动（见 `docs/decisions/atwo-three-pending-2026-11-18.md`）。
改本文件 = 改契约，需一条决策文档；`test/contract_freeze.test.mjs` 会替你记住。

---

## 一、派活入参（`runFanout(opts)` / `atwo fanout` / `atwo go`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `task` | string | 必填 | 任务文本（PRD 原文） |
| `parts` | number | 1 | 子会话数，硬上限 6 |
| `ask` | (prompt, opts) => Promise | `askCodeBuddy` | 通道实现，返回 `{ addedText, lane, elapsedMs }` |
| `lanes` | string[] | 按编队表 | 显式通道，`atwo fanout --lanes a,b` |
| `splitPlan` | object | 无 | 预切分结果（`chunks[]` / `units[]` / `strategy`），CLI 算好传入以保持可测 |
| `twoPhase` | boolean | `ATWO_TWO_PHASE==='1'` | 两段式：先各交 ≤120 字计划再动手 |
| `review` | boolean | true | 关掉即不派父审（测试常用） |
| `timeoutMs` | number | 180000 | 单片墙钟上限 |
| `fixRounds` | number | 0 | 语法/验收失败后的自愈轮数 |
| `onProgress` | (ev) => void | 无 | 进度事件，`ev.phase` 见下 |

**`onProgress` 的 phase 白名单**（接了别猜）：
`split` `split-skip` `plans` `resplit` `resplit-done` `resume-skip` `stop-skipped` `child-done` `review-start` `review-done` `fix`。

**相关环境变量**：`ATWO_RUN_ID`（长任务 id，STOP/断点续跑都靠它）、`ATWO_RUNS`（runs 根）、`ATWO_CHK=0`（关断点续跑）、`ATWO_HEALTH=0`（关健康度选路）、`ATWO_GRAPH=0`（关依赖图）、`ATWO_VERIFY_TESTS=1`（验收时跑受影响测试，默认关）、`ATWO_NO_PITFALL=1`（不写坑账本）。

---

## 二、产物回执（`runFanout` 返回体）

顶层键：`cwd` `shadowDir` `cleanupShadow` `parts` `plan` `planDesc` `probes` `children` `reviews` `summary` `notes` `split` `merged` `reviewRaw` `elapsed` `rounds` `error` `reviewLane` `writerLane` `homogeneous` `handoff`。

`children[i]`：`id` `index` `lane` `ok` `elapsedMs` `raw` `chunkLabel` `answer` `evidence` `malformed`（续跑命中时多一个 `resumed: true`；被 STOP 跳过时 `stopped: true`）。

`reviews[i]`：`id` `verdict` `reason` `mechanical` `downgraded`。

**判读铁律**：`ok` 只表示「这一片没报错」，**不表示产物对**。产物对不对一律看 `lib/outcome.mjs` 的 `judgeOutcome()`（`verdict: ok | partial | failed`），以及 `docs` 之外不要拿 `summary` 文本做分支。

---

## 三、账本字段（`memory/log.jsonl`，一行一条 JSON）

必需：`kind`（`passthrough`/`quota`/…）、`agent`（通道名）、`ok`（bool）、`elapsedMs`（number）。
可选但**下游会读**：`model`（模型名）、`multiplier`（倍率数值，未知省略而不是写 0）、`points`（折算积分）、`ts` 或 `at`（ISO 时间）、`task`（任务名）。

**口径**：
- 读成功率一律走 `lib/lane-health.mjs`：它排除了 `kind==='quota'`，并用 **Wilson 95% 下界**排序（1 单 1 成不会压过 254 单 206 成），窗口默认 7 天、`minCalls=5` 以下归「无样本」。
- 只有 `ok===true` 算成功；`ok===false` 与缺字段都不算。
- **不许往账本里写「已验证」「已通过」这类结论**——账本记事实，判断归 `docs/decisions/`。

---

## 四、四处外置真值的接线点（读不到时静默退化的地方）

| 接线点 | 依赖 | 缺了会怎样 |
|---|---|---|
| 切分吃依赖图 | `lib/graph-clusters.mjs` → `.graft/graft.db` | 退回纯正则聚类，强耦合文件会被切开 |
| 父审带波及面 | `lib/graph-facts.mjs` | 父审不知道「你改了被 29 个文件依赖的东西」 |
| 引文落地校验 | `lib/cite-check.mjs` | 只查 `文件:行` 形状，行号可以是编的 |
| 验收吃测试 | `lib/test-facts.mjs`（需 `ATWO_VERIFY_TESTS=1`） | 只跑语法闸，不跑受影响测试 |

**锁**：`atwo selfcheck` 打一行图龄；`atwo go` 在派活前打印 `⚠ 图龄：…`；两者的判据都来自 `lib/graph-age.mjs`（`.graft/graft.db` 的 mtime 对比 `lib/agents/test/bin/vm/eval` 下最新源码 mtime）。
