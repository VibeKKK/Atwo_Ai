# SETUP · 从零到跑通

> 目标：任何人 clone 下来，五条命令内知道这台机器能干什么、不能干什么。**不需要 npm install** —— 本仓库零第三方依赖、没有 lockfile。

## 0 前置

| 项 | 要求 | 说明 |
|---|---|---|
| Node | **>= 20.11.0**（`engines` 硬约束） | CI 跑 20 与 22 两个版本 |
| 系统 | Windows 10+ 为完整形态；Linux / macOS 可跑判定层与大部分测试 | GUI 通道依赖本机客户端 + CDP，非 Windows 上缺席 |
| 网络 | 不需要出网也能跑 `gate` 与判定层 | 只有真正派活才需要通道可用 |

## 1 三条自举命令（按顺序，一条比一条深）

```bash
node atwo.mjs doctor      # 环境诊断：node 版本、通道探测、端口、模型档位
node atwo.mjs try         # 两秒自检：闭包齐、判定机可跑、并发上限正确
node atwo.mjs gate --no-tests   # 结构闸门：闭包/语法/具名导出/契约/VM 参考向量/污染
```

三者的分工：`doctor` 回答「这台机器有什么」，`try` 回答「装对了吗」，`gate` 回答「现在是好的吗」。

## 2 通道（决定你能不能真的派活）

| 通道 | 类型 | 并发 | 需要什么 |
|---|---|---|---|
| `codebuddy` | CLI 子进程 | 6–8 路 | 本机 codebuddy CLI（`cbc` 需先登录一次） |
| `trae` / `workbuddy` / `doubao` | GUI（CDP） | 各 1 路 | 本机客户端开着，CDP 端口可连（9223 / 9224 等） |
| `ollama` | 本地模型 | 2 路 | `http://127.0.0.1:11434` 在跑 |

看不到通道不代表坏了：`node atwo.mjs doctor` 会逐条说缺什么。**没有通道时**，`node test/all.mjs` 里依赖真派活的那部分会红（详见 [KNOWN-LIMITS.md](KNOWN-LIMITS.md)），但纯逻辑与判定层测试不依赖任何通道。

## 3 第一次真派活

```bash
node atwo.mjs should "把 lib 下 12 个互不相同的模块各自补一组边界用例"   # 先问该不该派
node atwo.mjs fanout --task-file task.txt --parts 3 --follow            # 派 3 路 + 父审 + 自愈
node atwo.mjs triage                                                     # 机械分诊：哪些不用花钱送审
node atwo.mjs gate --files lib/新文件.mjs                                # 收工闸门（带验收五层）
```

## 4 判定层（不需要任何 AI 通道也能用）

```bash
node atwo.mjs judge --z 1.2,1.1,1.3 --attest   # 三值判定 + 可复算凭证
node atwo.mjs attest                            # 审历史凭证：哪些因文件改动失效
node vm/smoke.mjs                               # 用契约里的参考向量重算一遍
```

阈值只活在 `vm/oracle-contract.json` 一处，代码里出现 `0.45` / `0.22` / `0.8` 会被 gate 的 contract 步判红。

## 5 常见第一天的三个坑

1. `gate` 报 `uncommitted N 项` —— 不阻塞，只是提醒别人看不见你的改动。
2. `fanout` 被判 `self` 拒绝派活 —— 那是 `should` 认为这件事该自己做（命中热点文件 / 需要上下文），真要对加 `--force-should`。
3. GUI 通道当父审时说「文件不存在」—— 它读的是它自己的工作区，看不到本仓库；核引文只能靠 CLI 通道或机械闸门。
