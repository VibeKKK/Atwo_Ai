# GUI 通道异步化 + 作业退出码语义（假云端第四步）

日期 2026-11-17 · rank2 dsh-work-replace · 授权 User said (m05642)

## 一、问题：GUI 通道是「独占 + 慢 + 会占住前台」

`trae / workbuddy / doubao` 三个 GUI 通道单窗口独占（cap=1）、一次 28–190s，而父审必须等所有产物齐了才能做。
把它放在 `fanout` 前台里，等于整条流水线陪着它一起等 —— 这是 `army` 两批 214s 里评审占 120s 的直接原因。

## 二、做法：把父审拆成一条可排队的作业

新动词 `atwo review --dir .atw/fanout/<时间戳> --lane workbuddy [--task "原任务"]`（`lib/review-cli.mjs`）：

- `readChildren(dir)` 读回 `child-\d+\.md` 按编号排序，用 `parseChildOutput` 拆 ANSWER/EVIDENCE；
- 先过机械闸门 `preGateAll`（3ms、不花钱），**只有没被判死的才送给 LLM**；
- 送审时用 `buildReviewPrompt`（已带 EVIDENCE 截断上限，避免父审长提示走 argv 炸 `ENAMETOOLONG`）；
- 落 `REVIEW-ASYNC.md`（人看）+ `REVIEW-ASYNC.json`（机读，含 lane / digest / 逐条 votes）；
- 有 REVISE → exit 4。

排队用法（这就是「异步」的全部）：先收产物继续干活，父审交给队列：

```
node atwo.mjs queue add review --args '["--dir",".atw/fanout/20261117-111010","--lane","workbuddy"]'
node atwo.mjs queue run --max 1        # 或者等 AtwoQueueSupervisor 每 5 分钟自己跑
```

## 三、真跑（两条通道，都是排队跑的）

| 作业 | 通道 | 墙钟 | 结果 |
|---|---|---|---|
| `20261117113040-52528-fa61` | ollama | 13s | 机械 1 票 REVISE · 父审 1 票（child-2 unreviewed）→ exit 4 |
| `20261117113126-49260-30e9` | workbuddy（GUI） | **61s** | 同上，落 `REVIEW-ASYNC.json` lane=workbuddy、digest 4e4a62e37d193189 |

机械那票判得对，原文核对：产物称「GUI 通道 `return GUI_CAP`，caps.trae=8 也调不高」，而 `lib/pool.mjs:45` 实际是
`if (GUI_LANES.includes(lane)) return GUI_CAP;` —— 证据不是逐字抄的。这正是 `child-2` 被父审判 REVISE 的那处偏差。

## 四、顺带修掉的真 bug：exit 4 被当成作业失败

第一次排队跑 ollama 那条，作业落进 `failed/`，理由 `runner-failed` —— 但父审其实跑完了、也真的判出了 REVISE。
把「结论红」当「执行失败」的后果有两层：① 重试机制会反复重跑已经判红的产物 ② `done/` 里永远看不到「抓到了错」的作业，
审计时只看失败数会以为系统从没抓到过东西。

修法：`lib/queue-cli.mjs` 导出 `jobVerdict(code)` —— `0 → {ok,red:false}`、`4 → {ok:true,red:true,why:'accept-red'}`、
其余 `2/3/5/6` 与无退出码 → `{ok:false}`；runner 与 `lib/pool-cli.mjs` 都改用它。
测试 `test/queue_verdict.test.mjs` 3 条钉死。修后同一条作业 `成 1 · 败 0`，meta 里 `red:true why:accept-red exitCode:4`。

## 五、改动文件

新：`lib/review-cli.mjs` · `test/review_async.test.mjs`（6 条）· `test/queue_verdict.test.mjs`（3 条）。
改：`atwo.mjs`（table 加 `review`）· `lib/cli-spec.mjs`（review spec）· `lib/queue-cli.mjs`（`jobVerdict`）· `lib/pool-cli.mjs`（同语义）。

## 六、限制（诚实）

- **workbuddy 给了票但给不出可解析的 PASS/REVISE**：`reviewDir` 只对被机械闸门放过的产物送审，它回了内容但 `parseReview` 解不出裁决，记 `unreviewed`。
  也就是说这一刀解决的是**调度**（不占前台、掉电不丢、可重试），不是**异源可用性**（workbuddy 仍 0 票）。两者别混着算。
- 与 `fanout` 前台父审相比多一次进程启动（~150ms）与一次读盘，可忽略；但不共享 `notes.md` 运行中批注。
- 机械闸门在 `reviewDir` 与 `fanout` 里各跑一次，两边判据同源（都是 `lib/pregate.mjs`），不会漂。

## 七、回滚

`git revert` 本提交：`review` 动词消失，`queue`/`pool` 回到「exit 4 视为失败」。若只想回滚退出码语义，单文件恢复 `lib/queue-cli.mjs` 即可，其余不受影响。
