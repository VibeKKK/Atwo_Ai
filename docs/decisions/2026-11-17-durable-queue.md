# 落盘任务队列 + 无人 Supervisor（假云端第二步）· 以及一个真 bug：长父审提示走命令行必炸

日期 2026-11-17 · rank2 dsh-work-replace · 授权 User said (m05642)「可以把这些全做了用 atwo」

## 一、队列是什么

作业 = **一条 atwo 命令**。`kind` 就是动词名，`args` 就是它的参数数组，队列只负责持久与重试。
不自己定义作业类型，是因为作业种类会一直长（judge / fanout / army / gate / …），每加一种都要改两处，必然漂移。

```
.atw/queue/pending/<id>.json   →  running/<id>.json   →  done/<id>.json | failed/<id>.json
.atw/queue/supervisor.log      每跑完一条追加一行 JSON
.atw/queue/supervisor.cron.log 计划任务侧的原始输出
```

- id 规则 `<yyyyMMddHHmmss>-<pid>-<4位hex>`（本地时间，不用 toISOString —— 时区会错位）
- 写入一律 `<id>.json.tmp` + `renameSync`（原子），读者不会看到半个文件
- `claim` 用 `renameSync(pending → running)` 抢，抢不到顺延下一条，最多试 20 条
- `requeueStale`：`claimedAt + ttlMs` 过期 → attempts+1；attempts ≥ 3 → failed（`attempts-exhausted`）
- 坏 JSON 只让那一条变 `corrupt`，其余照常（一个坏文件不许毒死整条队列）

## 二、怎么用

```bash
atwo queue add fanout --args '["给 lib 补边界用例","--parts","3"]'   # 入队
atwo queue list                                                     # 看
atwo queue run --max 2                                              # 手动领
atwo queue requeue                                                  # 回收跑超时的
```

计划任务 **AtwoQueueSupervisor** 每 5 分钟跑一次 `atwo-queue.cmd`（`wscript` 起隐藏窗口 → `cmd` → `node atwo.mjs queue run --max 2 --json`）。
实测：入队一条 `state` → `Start-ScheduledTask` → 8 秒后队列里 pending 归零、done +1、`supervisor.cron.log` 有本轮 JSON、`LastTaskResult=0`。
**这一条是「假云端」里最像云端的东西**：进程死了、会话爆窗、机器重启，作业还在队列里，下一次触发接着跑。

## 三、谁写的

`lib/queue.mjs`（300 行）· `lib/supervisor.mjs`（114 行）· `test/queue.test.mjs`（258 行，15 条）由 **atwo fanout 派 3 路子会话**产出
（`.atw/fanout/20261117-105852`，child-1 187.1s / child-2 169.0s / child-3 153.1s）。
接线 `lib/queue-cli.mjs`（`makeQueueVerb`，把 kind 当动词名 spawn `node atwo.mjs <kind> … --json`）、
`atwo.mjs` 的 table 加 `queue`、`lib/cli-spec.mjs` 登记 `queue` 条目、`.gitignore` 加 `.atw/queue/`、计划任务注册，由我做。

落盘后 `node --check` 通过、`node test/queue.test.mjs` **15/15 一次通过**（含并发 claim 只成功一条、坏 JSON 不毒整队、runner 抛错只败那一条）。

## 四、这一次派活抓到的真 bug：父审提示走命令行必炸

第一轮 3 路产物回来（各 4.5–4.9 万字），父审**三票全丢**，理由逐条相同：

```
父审这一片调用失败：spawn ENAMETOOLONG
```

根因：`agents/codebuddy.mjs:153` 把整段提示当一个 argv 元素 `'-p', prompt`——
Windows 单条命令行上限约 32767 字符，三份 2 万字产物拼成的父审提示必然超限，`spawn` 直接抛 `ENAMETOOLONG`。
后果不是「慢」，是**这一片的审查等于没做**，而汇总只写 unreviewed —— 分不清是「提示太长」「父审不肯给票」还是「解析丢了」。

两处修：

1. `agents/codebuddy.mjs`：`STDIN_PROMPT_THRESHOLD = 16000`，超过就不再放进 argv，改 `-p` 不带值 + `stdin` 写入（`runCli` 加 `stdinData`，`stdio[0]` 视情况 `ignore`/`pipe`，写 stdin 的 `EPIPE` 忽略）。
   实测 `printf '只回答一个词：ok' | node …/bin/codebuddy -p --output-format json --tools "" …` → exit 0 有结果。
2. `lib/fanout.mjs` 的 `buildReviewPrompt`：每份产物 `ANSWER ≤ 3000`、`EVIDENCE ≤ 2500`，截断处写明「此处截断，原文另有 N 字没显示；不要因为看不到就判 PASS」。
   修后 3 份 4.7 万字的父审提示 **12602 字**（原 >13 万）。

修完用**同一批旧产物**重审（`_probe/review-queue.mjs`，没有重新派子会话）：
父审 45s 给出 3 票 —— child-1 PASS、child-3 PASS、child-2 REVISE（引文行号偏移，按它的编号约定确实对不上）。**功能恢复，且票面有区分度**。

## 五、顺带记下的两个语义

- `--task-file` 早就有：长任务文本该走它，不要用 `TASK=$(cat …)`（shell 会吃掉引号与反引号）。
- `--dry-run` 对 `queue` 无意义（它不派活），CLI 会明说一句然后照常执行。

## 六、验证

`node test/queue.test.mjs` 15/0 · `node test/review_prompt_size.test.mjs` 3/0 · `node test/fanout.test.mjs` 21/0 ·
`node test/atwo_cli_spec.test.mjs` 39/0 · `node test/all.mjs` **93/93 · 220.9s**。

## 七、改动文件

`lib/queue.mjs`（新）· `lib/supervisor.mjs`（新）· `lib/queue-cli.mjs`（新）· `test/queue.test.mjs`（新）·
`test/review_prompt_size.test.mjs`（新）· `agents/codebuddy.mjs`（stdin 长提示）· `lib/fanout.mjs`（父审提示截断）·
`atwo.mjs`（table 加 queue）· `lib/cli-spec.mjs`（queue 条目）· `.gitignore`（`.atw/queue/`）。

仓库外的两件（要记住，不在版本库里）：`<用户目录>\.dsh\tools\atwo-queue.cmd`、`atwo-queue-hidden.vbs`、计划任务 `AtwoQueueSupervisor`。

## 八、回滚

`git revert` 本提交；再 `Unregister-ScheduledTask -TaskName AtwoQueueSupervisor`（否则每 5 分钟仍会去领一个空队列，无害但会留日志）。
