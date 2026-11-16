# atwo 改成「彻底给 AI 用」· 2026-11-16

## 一句话

把 atwo 的三处「靠自觉」换成「靠闸门」：求助不再变成任务、错参数不再被吞、派活前能先看价。
连带修掉一条真实事故：`atwo fanout --help` 把 `--help` 当任务文本，真派出三个子会话跑了 61 秒。

## 事故记录（先记事实，再谈设计）

| 项 | 值 |
|---|---|
| 触发命令 | `node atwo.mjs fanout --help` |
| 发生时间 | 2026-11-16 13:58:51 |
| 实际行为 | `takeOpt` 不认 `--help`，它留在位置参数里变成任务文本 |
| 代价 | 3 个子会话 34.4s + 父审 26.9s = 61.3s；产出 `REVISE`（一票答错了对象，把 orch.mjs 当成 atwo.mjs） |
| 留痕 | `.atw/fanout/20261116-135851/FANOUT.md` |
| 根因 | usage 第 358 行写着「加 --help 看每个动词的全部参数」，而代码里从来没有分动词 help |

这条事故同时暴露三件事：文档与实现会漂；护栏写在动词内部会漏；「求助」和「任务文本」在参数层没有边界。

## 四个决策

### 1. 规格单一真源：`lib/cli-spec.mjs`

动词、参数、退出码、上限全在一个文件里，**同时驱动三件事**：打印用法、校验参数、给 AI 自学的 caps JSON。

为什么不写在 usage() 里：usage 是人读长文，caps 是机器读结构，两份东西放在一起必然漂 —— 已经漂过一次。
现在 usage() 由 `VERBS` 生成，测试里有一条断言专门查「usage 文本里出现的开关必须都登记过」。

### 2. 护栏放在 dispatch，不放在动词

`atwo.mjs` 尾部 dispatch 现在有三道，全部在进入动词实现之前：

1. **求助**：任何位置的 `-h` / `--help` / `help` → 只打规格，退出 0。
2. **未知参数**：strict 动词出现不认识的 `--xx` → 退出 2，列出可用参数，并明说「这一条没有派活、没有改任何东西」。
3. **`--dry-run` 三态**：派活动词要么真支持（`go` → `--plan`，`fanout` 自带），要么退出 2 并说明「去掉它直接跑，或改用 atwo fanout --dry-run」；本地动词则明说无意义后照常执行。半吊子的 dry-run 比没有更危险。

为什么必须在 dispatch：`--help` 那次事故里，`fanout` 自己的参数解析根本不知道有 `--help` 这回事。让每个动词自觉处理求助，等于让每个新动词重新踩一次。

### 3. `atwo caps --json`：AI 的自学入口

一条命令拿到全部动词、参数形态、退出码、上限、代价（会不会真派活）。三个用途：

- AI 不确定参数时先读它，不必读 1118 行源码；
- 出问题时能自证「我以为的参数」和「实际的参数」差在哪；
- `capabilities` / `spec` 是别名，记不住 `caps` 也能摸到。

纪律：caps 不带 `--json` 也输出 JSON —— 它存在的唯一理由是被机器读一次。

### 4. `--task-file`：长任务文本走文件

命令行里塞多段中文加换行，每过一层 shell 就变形一次，而任务文本变形等于整批子会话答错题。
`atwo fanout --task-file _probe/audit-task.md` 让任务文本不经过转义层。

同时立规：`--task-file` 与位置参数只能给一个（两个都给，子会话不知道该干哪件）。

## 改动清单

| 文件 | 改了什么 |
|---|---|
| `lib/cli-spec.mjs` | 新建。VERBS / GLOBAL_FLAGS / EXIT_CODES / LIMITS / isHelp / checkFlags / positional / specOf / capsJson / formatSpec |
| `atwo.mjs` | usage() 改为从 VERBS 生成；dispatch 加三道护栏 + `caps` 动词 + `printSpec` |
| `lib/fanout-cli.mjs` | 加 `--dry-run`（只算不派）、`--task-file`（从文件读任务） |
| `package.json` | `"test": "node test/all.mjs"` —— 原来手列 6 个文件，实际 33 个 `.test.mjs` |
| `test/atwo_cli_spec.test.mjs` | 新建 39 条断言 |

## 断言（为什么是这 39 条）

| 类别 | 钉住什么 |
|---|---|
| 规格表 | 11 个动词齐、每个都有 summary/cost/strict、会花钱的必须标 `spawn` |
| 求助识别 | `-h/--help/help/HELP/--Help` 都认；`--helpp/-hh/helpme` 故意不认（交给未知参数处理） |
| 未知参数 | `new --szi` 拦；`judge --z -0.5` 负数值不误拦；`go/raw` 透传不拦 |
| 位置参数 | 带值开关连同它的值一起跳过 |
| 规格自洽 | usage 里出现的开关必须登记过 |
| 跨文件真源 | `LIMITS.maxParts` 必须等于 `fanout-run.mjs` 的 `MAX_PARTS` |
| 真 CLI | `fanout --help` 退出 0 且 **`.atw/fanout` 目录数不变**；`--dry-run` 同样不建目录；`batch --dry-run` 退出 2 |

最后两条是本轮最值钱的：它们直接钉住了「求助不会变成任务」和「试跑不会真花钱」。

## 已知未做

- `batch` 还没有 `--dry-run`：它现在会直接拦住并告诉你改用什么，不给半吊子实现。
- 长任务在前台跑会被外层工具的调用超时截断（本轮实测两次），atwo 还没有「后台跑 + 轮询」的能力。要被截断时不丢中间产物，得先把子产物落盘再做审查 —— 现在 `writeFanout` 只在全部结束后写一次。
- `raw` 的透传边界没有规格：它把参数原样交给 orchestra，orchestra 认什么就是什么。
