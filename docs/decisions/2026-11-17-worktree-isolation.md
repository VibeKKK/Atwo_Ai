# 隔离从 cpSync 换成 git worktree（假云端第一步）

日期 2026-11-17 · rank2 dsh-work-replace · 授权 User said (m05642)「可以把这些全做了用 atwo」= 用 atwo 派活实现模拟云端的五步

## 数字（同一台机、同一个仓库）

| 方式 | 建副本耗时 | 体积 | 副本里有 .git |
|---|---|---|---|
| `fs.cpSync`（旧） | 5.9s | 27MB | 没有 |
| `git worktree add --detach`（新） | **406ms**（全套含叠脏文件 244–570ms） | 3.7MB | 有 |

14 倍差距的来源：cpSync 要逐个文件复制，worktree 只往 `.git/worktrees` 写管理信息、objects 共享。

## 谁写的

实现 `lib/worktree.mjs` 与 `test/worktree.test.mjs` 由 **atwo fanout 派 2 路子会话**产出（`.atw/fanout/20261117-105117`），
父审 2 票 PASS 并逐条核对了引用行；我落盘后 `node --check` + 原测试 **6/6 一次通过**。
接线、叠脏文件、行尾钉死、沙箱测试由我做 —— 这三件是判断，不适合派。

## 三个只有接线后才暴露的坑

1. **worktree 检出的是 ref 的字节，不是工作区**：未提交改动与未跟踪新文件在副本里都是旧版。
   校验 RUN 时会跑在旧字节上 —— 退出码可能对，但结论是错的对象。
   修法：`overlayWorkingTree()` 用 `git status --porcelain -z --untracked-files=all` 取出脏项，把改动与新增叠上去、把删除项删掉（实测 55 个文件、几十毫秒）。
2. **Windows 上 core.autocrlf 默认 true**：检出写 CRLF，而工作区里我写的文件是 LF → 副本与工作区字节不同，
   `test/pregate_run.test.mjs` 的「副本必须同字节」当场红。修法：worktree add 带 `-c core.autocrlf=false -c core.eol=lf`。修后逐字节比对 5 个关键文件全等。
3. **.gitignore 的目录叠不进去**：`git status` 看不见被忽略的文件，所以 `_probe/` 里的标记文件不会出现在副本里。
   这不是 bug 而是设计（运行时目录不该进副本），但测试断言必须放在未忽略路径上。

## 语义变化（要记住的）

- 副本里现在**有 .git**：子会话能读历史、分支名、别的 worktree 路径。对只读产物是净收益（能跑 `git log`/`git diff`）；
  对 `--allow-run` 的子会话是新增面 —— 白名单里没有 git 命令，暂时无冲突，但将来加 git 命令前要先想清楚。
- `makeShadow` 仍是同步函数：`worktree.mjs` 里 `createWorktreeSync` 是实体，`createWorktree` 是 async 转发（测试与将来的异步路径用）。
- 非 git 仓库退回 cpSync，返回体带 `isolation:'copy'` 与 `fallbackFrom` 说明原因，不报错。

## 改动文件

`lib/worktree.mjs`（新，约 240 行，含 `overlayWorkingTree`）· `test/worktree.test.mjs`（新，6 条）·
`lib/sandbox.mjs`（`makeShadow` 先 worktree 再退回 cpSync，返回体加 `isolation/ms/overlaid/fallbackFrom`）·
`test/sandbox_worktree.test.mjs`（新，4 条：worktree 隔离、叠脏文件、cleanup 无残留、非 git 退回、空目录判死）。

## 验证

`node test/worktree.test.mjs` 6/0 · `node test/sandbox_worktree.test.mjs` 4/0 ·
`node test/pregate_run.test.mjs` 10/0 · `node test/snapshot.test.mjs` 8/0。

## 回滚

`git revert` 本提交；或把 `makeShadow(dir, { isolation: 'copy' })` 写死即可退回旧路径（不需要删新文件）。
