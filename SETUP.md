# SETUP · 从零到跑通

> 目标：任何人 clone 下来，五条命令内知道这台机器能干什么、不能干什么。**不需要 npm install** —— 本仓库零第三方依赖、没有 lockfile。

## 0 前置

| 项 | 要求 | 说明 |
|---|---|---|
| Node | **>= 20.11.0**（`engines` 硬约束） | CI 跑 20 与 22 两个版本 |
| 系统 | Windows 10+ 为完整形态；Linux / macOS 可跑判定层与大部分测试 | GUI 通道依赖本机客户端 + CDP，非 Windows 上缺席 |
| 网络 | 不需要出网也能跑 `gate` 与判定层 | 只有真正派活才需要通道可用 |

## 1 先认个人（只做一次，漏了就一条任务都建不出来）

```bash
py -3 .atw/scripts/init_developer.py <你的名字>     # Linux / macOS 用 python3
```

它创建 `.atw/.developer` 和 `.atw/workspace/<名字>/`。**这一步是 `new` / `go` / `done` 的前置条件** ——
`.atw/*.json` 在 `.gitignore` 里，所以 clone 下来一定没有它，而 `node atwo.mjs new "..."` 会直接报：

```
建任务失败：Error: No developer set. Run init_developer.py first or use --assignee
```

替代写法：`ATW_DEVELOPER=<名字> node atwo.mjs new "..."`（不建 workspace 目录）。
git worktree 会继承主 checkout 的 `.atw/.developer`，所以主库建一次就够了。

## 2 三条自举命令（按顺序，一条比一条深）

```bash
node atwo.mjs doctor      # 环境诊断：node 版本、通道探测、端口、模型档位
node atwo.mjs try         # 两秒自检：闭包齐、判定机可跑、并发上限正确
node atwo.mjs gate --no-tests   # 结构闸门：闭包/语法/具名导出/契约/VM 参考向量/污染
```

三者的分工：`doctor` 回答「这台机器有什么」，`try` 回答「装对了吗」，`gate` 回答「现在是好的吗」。

**这三条全绿不等于能用**：它们都是「读」——真正第一次写盘的是 `new`。
想确认这仓库在这儿真能干活，把第 1 节那条和下面这条一起跑：

```bash
node atwo.mjs new "冒烟：确认能建任务"    # 建得出 .atw/tasks/<时间戳> 才算通
```

## 3 通道（决定你能不能真的派活）

| 通道 | 类型 | 并发 | 需要什么 |
|---|---|---|---|
| `codebuddy` | CLI 子进程 | 6–8 路 | 本机 codebuddy CLI（`cbc` 需先登录一次） |
| `trae` / `workbuddy` / `doubao` | GUI（CDP） | 各 1 路 | 本机客户端开着，CDP 端口可连（9223 / 9224 等） |
| `ollama` | 本地模型 | 2 路 | `http://127.0.0.1:11434` 在跑 |
| `deepseek` | HTTP API | 4 路 | `DEEPSEEK_API_KEY` 或 `~/.dsh/deepseek.key` |

看不到通道不代表坏了：`node atwo.mjs doctor` 会逐条说缺什么。**没有通道时**，`node test/all.mjs` 里依赖真派活的那部分会红（详见 [KNOWN-LIMITS.md](KNOWN-LIMITS.md)），但纯逻辑与判定层测试不依赖任何通道。

### 3.1 GUI 通道的两个硬前提（Electron 类客户端）

**① 端口只认环境变量，命令行参数会被丢弃。** WorkBuddy 5.11.2+ 实测：`--remote-debugging-port=9224`
不生效、还会以 `ExitCode=9` 退出并打印 `bad option`；必须 `WORKBUDDY_REMOTE_DEBUGGING_PORT=9224`。
各客户端的环境变量名见 `agents/<name>.mjs` 顶部注释。

**② 启动前清掉 `ELECTRON_RUN_AS_NODE`，否则会秒退而且不报错。**

如果你的终端是从某个 Electron 应用（IDE 内置终端、Electron 版 shell 等）继承来的，
这个变量会一直传下去。该应用会把自己当作纯 Node 解释器启动 —— 没有 GUI，跑完就退，
**`ExitCode=0`、日志里一行都没有**，看起来像「什么都没发生」。

```bash
# 手动起客户端时先清
unset ELECTRON_RUN_AS_NODE          # bash
Remove-Item Env:\ELECTRON_RUN_AS_NODE   # PowerShell
```

`atwo` 自己 `spawn` 子进程时已经在 `agents/workbuddy.mjs` 里清了这个变量，
所以**通过 atwo 起是安全的**；只有你手动起客户端才会撞上。

**③ 自检顺序**：`doctor` 只判「exe 在不在」，**不判「端口开没开」**。
所以 `workbuddy✓` 可能只是文件存在，真派活仍会失败。用下面这条确认端口：

```bash
curl -s -H "Host: localhost:9224" http://127.0.0.1:9224/json/version
```

## 4 第一次真派活

```bash
node atwo.mjs should "把 lib 下 12 个互不相同的模块各自补一组边界用例"   # 先问该不该派
node atwo.mjs fanout --task-file task.txt --parts 3 --follow            # 派 3 路 + 父审 + 自愈
node atwo.mjs triage                                                     # 机械分诊：哪些不用花钱送审
node atwo.mjs gate --files lib/新文件.mjs                                # 收工闸门（带验收五层）
```

## 5 判定层（不需要任何 AI 通道也能用）

```bash
node atwo.mjs judge --z 1.2,1.1,1.3 --attest   # 三值判定 + 可复算凭证
node atwo.mjs attest                            # 审历史凭证：哪些因文件改动失效
node vm/smoke.mjs                               # 用契约里的参考向量重算一遍
```

阈值只活在 `vm/oracle-contract.json` 一处，代码里出现 `0.45` / `0.22` / `0.8` 会被 gate 的 contract 步判红。

## 6 常见第一天的四个坑

1. `new` 报 `No developer set` —— 漏了第 1 节的 `init_developer.py`，回去补一句就好。
2. `gate` 报 `uncommitted N 项` —— 不阻塞，只是提醒别人看不见你的改动。
3. `fanout` 被判 `self` 拒绝派活 —— 那是 `should` 认为这件事该自己做（命中热点文件 / 需要上下文），真要对加 `--force-should`。
4. GUI 通道当父审时说「文件不存在」—— 它读的是它自己的工作区，看不到本仓库；核引文只能靠 CLI 通道或机械闸门。
