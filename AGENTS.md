<!-- ATW:START -->
# ATW Instructions

These instructions are for AI assistants working in this project.

This project is managed by ATW. The working knowledge you need lives under `.atw/`:

- `.atw/workflow.md` — development phases, when to create tasks, skill routing
- `.atw/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.atw/workspace/` — per-developer journals and session traces
- `.atw/tasks/` — active and archived tasks (PRDs, research, jsonl context)

ATW commands are written by bare name throughout `.atw/` — `start`, `continue`, `finish-work`. The prefix that invokes them is your platform's, not ATW's: Claude Code uses `/atw:`, Cursor and Pi `/atw-`, Codex `$`, Copilot a plain `/`, and a few hosts expose them as skills instead. Prefer an available ATW command over manual steps; not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable ATW skills
- `.codex/agents/` — optional custom subagents

Managed by ATW. Edits outside this block are preserved; edits inside may be overwritten by a future `atw update`.

<!-- ATW:END -->

<!-- ATWO:AI-ENTRY -->
# 这台机器上有 atwo（给 AI 用，不是给人用）

`node atwo.mjs` 不带参数会自述：这台机器、这个仓库、四条通道哪个活着、现在能做什么。

三个入口，按需要挑：

1. **拿不准要不要派活** → `node atwo.mjs should "<你要做的事>"`。它给 `delegate` / `self` / `either`，加逐条判据（每条带命中的原词）与代价估算（几路、多久、注入多少 token、省下多少上下文）。判据带 veto：改契约、改 authority.json、`git commit`、`git push --force` 一律 `self`。
2. **要派活** → `node atwo.mjs fanout --active --follow`。`--active` 拿当前任务当任务文本（不用再复制一遍）；`--follow` 每路回来就报；开跑后往输出目录里的 `notes.md` 追加一句话就能改要求，父审会读到；父审只有 `Read` 权限，改不了文件。产物落 `.atw/fanout/<时间戳>/`，`FANOUT.md` 是结论。
3. **收工前** → `node atwo.mjs gate`（闭包 + 语法 + 契约 + 全量测试 + 未提交清单），红了就别交；`node atwo.mjs done` 已经把这份闸门和评审票算进收工条件。

其余：`doctor` 查通道可用性并给补齐办法；`try` 两秒自检内核是否活着；`caps --json` 拿全部动词与上限；`help <动词>` 看单个动词的全部参数。

机器可读约定：任何动词加 `--json` 只出 `{ok,verb,exitCode,data,log}`；退出码 `0` 通过 / `2` 用法 / `3` 前置条件 / `4` 验收不过 / `5` 通道不可用 / `6` 预算超限。

## 共享文件提交前逐段看（2026-11-17 事故后加）

`atwo.mjs` / `lib/cli-spec.mjs` / `agents/*` / `orchestra.mjs` 是两个工作区都在改的共享文件。
**禁止整文件 `git add <共享文件>`**（这是 `git add -A` 的同型变体）：提交前 `git diff <file>` 逐段确认只含自己的 hunk，
别人的要么 `git add -p` 挑，要么先备份 + `git checkout -- <file>` 再打自己的补丁 + 把备份拷回。
判据一句话：**如果对方今天回滚了他所有未提交改动，我这个提交还跑得起来吗？** 跑不起来就说明把他的东西带进来了。
