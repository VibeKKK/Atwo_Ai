# 无人值守（一）：任务源外移 + 失败自愈

日期：2026-11-17 · 作者：dsh-work-replace（rank2）· 提交：见 `git log --grep 无人值守`

## 为什么做这个

`atwo` 所有的自动能力都有一个前置条件：**我得想起来敲那条命令**。会话一关、我注意力一转，闸门就不跑了。
今天量过账：`.atw/fanout` 121 批里约七成是「用 atwo 验证 atwo」的自指循环 —— 因为真活来了我下意识自己干。
这不是勤奋问题，是**使用率的结构问题**：能想起来调的工具才会被调，而想起不起来的工具等于不存在。

解法只有一条：把「谁发起」从对话搬到文件系统。

## 三件，顺序不能反

### ① 任务源外移：`atwo drain`

```
echo '{ "kind": "patch", "task": "…", "test": "node test/x.test.mjs" }' > .atw/inbox/my.task.json
node atwo.mjs drain --limit 2
```

- 认领 = `fs.renameSync(<id>.task.json, <id>.claimed.json)` —— 原子，两个 drain 抢不到同一条。
- 归档：成功进 `done/`、失败进 `failed/`，文件名统一回 `<id>.task.json`。
- 每次写 `<id>.result.json`：`{contract,id,at,kind,ok,reason,elapsedMs,degraded,attempts,detail}`。
- 坏 JSON / 未知 kind / 空 task **不进 handler**，直接归档进 failed —— 否则每轮重复失败，而且没人知道坏在哪。

### ② 失败自愈：连续失败就换招式

`MAX_ATTEMPTS = 2`（`lib/inbox.mjs`）。同一 id 的 `attempts` 到阈值，下一次派活自动带 `asReport: true`：

- `lib/writeback.mjs`：`readOnly` 时工具集换 `REPORT_TOOLS = 'Read,Grep,Glob'`，`permissionMode` 不给 `bypassPermissions`，ask 之后立刻返回（跳过 changed/diff/tests）。
- `lib/inbox-cli.mjs`：handler 见 `spec.asReport` 就调 `runPatch({ readOnly: true })`，把报告落 `<id>.report.md`。
- `formatDrain` 会标「（已降级：只出报告）」，不翻 result.json 也知道。
- 成功后 `attempts` 清零 —— 下一轮重新给写权限。

理由：模型改不出能过验收的东西时会一遍遍改同一处。人不在场，没人拦它；**无人值守下无限重试是最坏的失败形态**（烧时间、烧额度、还占着热点文件）。

### ③ 常驻触发：挂进已有的 `AtwoQueueSupervisor`

计划任务每 5 分钟跑 `C:\Users\<用户目录>\.dsh\tools\atwo-queue.cmd`，里面已有 `atwo queue run --max 2`，追加一行：

```
node atwo.mjs drain --limit 2 --json >> .atw\inbox\drain.cron.log 2>&1
```

**这一件必须排在 ② 之后**：让一个会写文件的进程在无人看管下自动重试，而它没有「换招式」的能力，等于加速烧钱。

## 真跑记录（2026-11-17 23:5x）

任务：`{kind:'patch', task:'在 README.md 加一行引用', test:'node test/绝对不存在的用例.test.mjs', lane:'codebuddy'}`

| 轮次 | 耗时 | 结果 |
| --- | --- | --- |
| 第 1 次 | 29.7s | ✗ tests 红，attempts=1 |
| 第 2 次 | 36.8s | ✗ tests 红，attempts=2 |
| 第 3 次 | 0.2s | 崩（当时 `lib/writeback.mjs` 被我改坏，无关降级逻辑）|
| 第 4 次 | 26.0s | ✓ 降级跑了，但 `report.md` **只有标题没有正文** |
| 第 5 次 | 56.1s | ✓ 降级 + `reason: codebuddy 未授权`（通道侧）|
| 第 6 次 | 22.4s | ✓ 降级 + 报告写「通道没有给出报告：…Max turns (4) exceeded」|

## 这一轮抓到的三个真 bug

1. **`readOnly` 传了但没传到底**：`runPatch({readOnly:true})` 收到了，`base` 对象没复制它，`runOnePart` 里 `readOnly` 是 `undefined` → 降级模式照样给写权限、`report` 永远是空。修法：`base` 里加 `readOnly: !!opts.readOnly`，并加一条真跑断言（`test/patch_readonly.test.mjs` 第二条）。
2. **空报告 = 静默失败**：通道没给内容时，`report.md` 是个只有标题的空文件。修法：`|| '通道没有给出报告：' + (part0.reason || r0.error || '未知原因')`。
3. **`patchPaths` 里混进 `null`**：降级模式 `ok` 但没有 patch，`okParts.map(p => p.patchPath)` 得到 `[null]`，`length === 1` 骗过了「没出 patch」的断言。修法：`.filter(Boolean)`。

另有一条假红：`test/patch.test.mjs` 的泄漏断言写的是「全仓库不许有新副本」，并发跑测试时另一个测试也在建 worktree → 必红。修法：只认本进程的 `atwo-wt-${process.pid}-`。

## 验收判据

**连续 8 小时无人操作，收件箱至少推进 1 条，且失败项全部带可读原因、没有一条静默消失。**

三条缺一不可：推进（说明常驻真的在跑）、可读原因（说明失败不是黑洞）、不静默（说明坏 JSON 之类也不会被吞）。

## 已知不对称

- 通道未授权（`codebuddy 未授权：跑一次 cbc 后输入 /login`）时，降级也只能把通道错误写进报告 —— 这不是 atwo 的问题，但它会把「环境坏」和「产物坏」混在同一个 `reason` 字段里，读的时候要看清前缀。
- `atwo board` 还没把 inbox 的 done/failed 算进去，现在看收件箱只能 `ls .atw/inbox`。
- 降级报告不参与评审票（它是给人看的，不是给闸门看的）。

## 回滚

```
# 只回滚降级，保留收件箱
git checkout <此前的 commit> -- lib/inbox.mjs lib/inbox-cli.mjs lib/writeback.mjs
```
降级是纯增量：`MAX_ATTEMPTS` 删掉、`asReport` 分支删掉，`drain` 就退化成「每条只跑一次」。