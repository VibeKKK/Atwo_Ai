# 执行面（第一刀）：子会话能在影子副本里真的跑命令

日期 2026-11-17 · rank2 dsh-work-replace · 授权 User said (m05474)「先改吧」

## 为什么

改之前全系统**没有一处执行过被测代码**：`lib/fanout-run.mjs:14` `export const READ_ONLY_TOOLS = 'Read,Grep,Glob';`，
子会话只能交文本，父审也只能读文本。后果是「说的对」和「做的对」分不开 —— 一份产物写
`node --check lib/sandbox.mjs → exit 0`，谁都没跑过，父审只能看它像不像。

## 五件套里这次做了前四件

1. 隔离：`lib/sandbox.mjs` 的 `makeShadow()` 用 `fs.cpSync` 把仓库复制到临时目录（跳过 node_modules/.git/.atw/.agents/reviews/__pycache__，27MB 约 5.9s）。**空副本判失败** —— Windows 上 cpSync 对不存在的源会「成功」造出空目录，后面 RUN 校验会 ENOENT，看起来像产物写错了。
2. 白名单：`ALLOW` 七条正则，只认 `node --check` / `node test/*.test.mjs` / `node test/all.mjs` / `node vm/smoke.mjs` / `atwo gate --no-tests` / `atwo judge --z` / `atwo attest`。空命令 / shell 元字符 / >300 字符 / 不在白名单，四条 fail-closed。
3. 新证据类型：产物里写 `RUN <cmd> → exit N`（也认 `RUN:`、`->`、`=>`）。
4. 机械层重跑核对：`lib/pregate.mjs` 的 `runCheck()` 在影子副本里真跑一遍，退出码不符 → REVISE，理由带上实跑尾部输出。
5. 凭证链扩到行为 —— **没做**（`vm/attest.mjs` 现在只绑判定输入输出与契约哈希，不绑 RUN 结果）。

## 语义

- 没声明 RUN → `defer`，不白跑。
- 声明了但命令不许跑 → REVISE「RUN 想跑的命令不许跑」；超时 → REVISE「RUN 跑不完」。
- 退出码不符 → REVISE「RUN 声明与实跑不符 —— <cmd> 你写 exit N，实跑 exit M；尾部输出：…」。
- 影子副本懒建：只有真遇到带 RUN 的产物才复制（否则每次派活白付 5.9s）。建不起来 → 该产物判死，绝不静默放行。

## 两个真发现（接线时才暴露）

- **codebuddy 的 Bash 在非交互模式被拒**：`Error: Permission to use Bash has been denied because this tool requires approval but permission prompts are not available in non-interactive mode.` 根因是 `agents/codebuddy.mjs:113` 的 `permissionMode` 默认 `'acceptEdits'`（只放行文件编辑）。开执行面时必须传 `'bypassPermissions'`，否则子会话诚实报告「没跑成」而不是编一个退出码 —— 这一条是子会话比预期好的地方。
- **should 会拦自己的回归测试**：带 `--allow-run` 的派活被 `shouldDelegate` 判 self，理由是「要真跑环境」「命中热点文件」。要跑得加 `--force-should`。

## 实测（真实两跑 + 伪造对照）

| 跑 | 目录 | 结果 |
|---|---|---|
| 修 permissionMode 前 | `.atw/fanout/20261117-092845` | 两路都 REVISE，理由「把 `RUN … → exit 0` 改成『未执行成功』」—— 诚实报没跑成 |
| 修后 | `.atw/fanout/20261117-093023` | child-1 REVISE（引文数字不符）· child-2 PASS（父审逐条核对 :19/:20-26/:27/:36-38）· 子会话 22.5s + 审查 8.4s |

- 重跑核对（`_probe/verify-runs.mjs`）：两份产物各 2 条 `node --check lib/sandbox.mjs`，声称 exit 0 / 实跑 0（48–53ms）→ defer。
- 伪造对照（`_probe/verify-lie.mjs`，把 exit 0 改成 exit 1）→ REVISE「RUN 声明与实跑不符 —— 你写 exit 1，实跑 exit 0」。**这是第一刀的验收证据。**

## 改动文件

`lib/sandbox.mjs`（新，约 130 行）· `lib/pregate.mjs`（RUN 核对）· `lib/fanout-run.mjs`（影子副本 / RUN_TOOLS / permissionMode）· `lib/fanout-cli.mjs`（--allow-run 与开关抠除）· `lib/cli-spec.mjs`（switches）· `test/pregate_run.test.mjs`（10 条）· `test/fanout_readonly.test.mjs`（默认值三条断言）。

## 已知不对称

- 只对 fanout 生效，army 与父审路径没接。
- 白名单是正则，不是解析器：`node test/all.mjs --dir x` 里 `--dir` 的值不受约束。
- 影子副本里的 `.git` 是跳过的，所以 `git diff` 类命令在副本里会失败；白名单内没有 git 命令，暂不冲突。
- 执行面开销：每次派活多 5.9s（27MB 复制）+ 每条 RUN 约 50–60ms。
- `bypassPermissions` 只和 `Read,Grep,Glob,Bash` 一起给；Bash 本身能写文件，隔离靠影子副本而不是工具集。

## 回滚

`git revert <commit>` 即可；不留迁移、不留数据。关单个特性也可只加 `--no-pregate`（含 RUN 核对）或不开 `--allow-run`。
