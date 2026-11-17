# 第一刀：给它一双手（影子副本写入）+ 无人值守入口（文件收件箱）

日期：2026-11-17 · 作者：dsh-work-replace（rank2）

## 为什么要做这两件

用户的判断（m07811 / m07823）：atwo 存在，但我干的活没减少 —— 它只接管「检查」，不接管「写」。
实测结构：我的 token 里读代码约 40%、写代码约 25%，而 `lib/fanout-run.mjs:67` 的默认值
`READ_ONLY_TOOLS = Read,Grep,Glob` 让子会话能读能想、不能动手 —— 那 25% 一直是我自己干。

第二件是无人值守：`.atw/fanout` 121 批全部由我在对话里敲命令发起。人一走开就停摆，
2026-11-17 夜跑失败就是它在等一条没人会敲的命令。

## 一、atwo patch（影子副本写入）

```
atwo patch 「要改什么」 [--test 「node test/x.test.mjs」] [--parts 1-3] [--dry-run]
```

流程（六步，全部机械化）：
1. `createWorktreeSync` 建一份 git worktree 副本（detached HEAD，`core.autocrlf=false`）；
2. `overlayWorkingTree` 把主仓库未提交改动叠进副本（否则子会话看不到我刚改的东西）；
3. `baselineStage`（`git add -A`）**固化基线** —— 这一步决定 patch 里只含它写的东西；
4. 子会话在副本里写（`Write,Edit,Read,Grep,Glob,Bash` + `bypassPermissions`）；
5. 机械验：`changedFiles` → `node --check` 改动文件 → 验收命令（`--test`）；
6. 过了才 `savePatch` 到 `.atw/patches/<时间>.patch`；不过整份丢（但留 `.rejected` 供复盘）。

### 三个必须记住的坑（都是当晚实测踩出来的）

| 坑 | 现象 | 修法 |
|---|---|---|
| 不固化基线 | 主仓库有 6 项未提交时，假会话什么都没干，patch 却非空 —— 混进的是别人的改动 | overlay 后 `git add -A`，只用 `git diff`（index↔工作区）判改动 |
| 用 `git status` 判改动 | 基线固化后 status 的前两位是「相对 HEAD」，永远非空 | 改看 `git diff --name-only` + `ls-files --others` |
| 行尾配置不一致 | worktree 用 `autocrlf=false` 建，后续 git 用默认 → status 说变了、diff 是空（报 `empty-diff`） | 所有 git 调用统一带 `-c core.autocrlf=false -c core.eol=lf` |

第四个坑不是 bug 是设计：**失败也要留 diff**。第一版只存通过的 patch，红的时候只能重跑一遍去猜原因。
现在 `rejectedPath` 会指到 `.atw/patches/<时间>-rejected-N.patch`。

### 真跑记录（codebuddy，三轮）

| 轮次 | 任务 | 结果 | 结论 |
|---|---|---|---|
| 第一次（手工） | 给 test/split.test.mjs 加 MAX_LOAD_RATIO 测试 | 28 passed / 0 failed，2 文件 +32/−2 | 它自己发现 `lib/split.mjs` 没转出 `MAX_LOAD_RATIO`，加了一行 re-export 并写注释 |
| 第二轮（atwo patch） | 补一条 listInbox 断言 | 改动正确（+16 行），但验收红 → 整份丢 | 判定正确、但当时看不到它写了什么（已修） |
| 第三轮 | 同上 | 红因定位：验收命令 `node test/patch.test.mjs` 在**副本里**跑必然红 —— 那条「不许有 atwo-wt- 残留」把自己（副本目录）当成了残留 | 改成快照差集后，副本内 10/10 绿 |

第三轮这条值得单独记：**验收命令自己也会在副本里跑**，它必须对环境自洽。

## 二、atwo drain（文件收件箱）

```
mkdir -p .atw/inbox
# .atw/inbox/<id>.task.json → 例：kind=patch, task=..., test=node test/x.test.mjs
atwo drain [--limit N] [--dry-run]
```

- `kind` 目前两种：`patch`（走上面的写入链）、`gate`（跑闸门）；未知 kind 与坏 JSON 一律进 `failed/` 并写 `result.json`，不会每轮重复失败。
- 认领靠 `renameSync`（原子）：两个 drain 同时跑只有一个拿到，另一个跳过。
- 归档：成功进 `.atw/inbox/done/`，失败进 `failed/`，文件名统一回 `<id>.task.json`（留 `.claimed.json` 会让人以为还没干）。
- 端到端实测：扔一个 `kind=gate, skipTests=true` → `atwo drain --limit 1` → 12.1s，`done/e2e-gate.task.json` + `e2e-gate.result.json`（含 elapsedMs / detail）。

## 三、还没做的（无人值守的另外两件）

1. **常驻调度**：现在 `atwo drain` 仍需有人（或计划任务）触发。已有 `AtwoQueueSupervisor` 每 5 分钟跑队列，
   把 drain 接进同一个计划任务即可，但**必须先满足第 2 条**（会自己写代码的任务不能无人看管地跑）。
2. **失败自愈**：drain 现在只会记 failed。需要的是「同一任务连续失败 N 次 → 降级为 as-report（只出报告不改代码）+ 通知」。
3. **汇报出口**：`atwo board` 已能看队列，但没把 inbox 的 done/failed 算进去。

判据（下一轮验收用）：连续 8 小时无人操作，收件箱至少推进 1 条，且失败项全部带可读原因、没有一条静默消失。

## 四、回滚

- 删 `.atw/inbox` 与 `.atw/patches`（运行时目录，已 gitignore）；
- 回退 `atwo.mjs` 三处（两行 import、两行 const、table 一项）与 `lib/cli-spec.mjs` 的 VERBS 两条；
- `lib/writeback.mjs` / `lib/patch-cli.mjs` / `lib/inbox.mjs` / `lib/inbox-cli.mjs` 是新增文件，删掉即回到只有只读 fanout 的状态。