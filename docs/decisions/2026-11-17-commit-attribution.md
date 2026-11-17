# 提交归属事故：我把 rank1 的 atwo.mjs 改动一起提交了

日期 2026-11-17 · rank2 dsh-work-replace · 自查于用户问「另一个工作区也做了修改，你看看」时

## 一、事实

`atwo.mjs` 是**共享文件**：rank1（`dsh-lead`）与我都在这一个文件里加东西。今天我用「整文件 `git add atwo.mjs`」提交了三次，
把当时还在他工作区里、**未提交**的改动一起带进了我的提交：

| 我的提交 | 里面属于他的 hunk（证据：`git show <sha> -- atwo.mjs | grep -E '^\+'`） |
|---|---|
| `528a437` | `--force-lanes` 强留通道、`pruneLanes(ledgerRows, lanes)` 按台账剔通道、`verifyModels(tier,{agents,max})` 探活 |
| `fc98543` | `--all-lanes` 与 `ALL_LANES`/`FAST_LANES` 分流、「想强行四路：--all-lanes」 |
| `5e34d33` | `SIZE_PLAN.M = { lanes: ['codebuddy'], review: 1 }`（去掉常空产出的 trae）、`passThrough` 过滤 `--all-lanes`、`ATWO_ALL_LANES` 开关 |

`git show --numstat` 记的是 `atwo.mjs` 三次 +81/−3、+16/−1、+11/−4；其中**属于我的只有 import 与 table 里的动词接线**
（`queue` / `pool` / `cost` / `review` 四行 + 三个 import），其余是承接他的改动。

## 二、为什么危险（不是面子问题）

- **归因错**：日后 `git log -- atwo.mjs` 会显示这些行为是我引入的。他改坏了没人找他，我改坏了没人找我。
- **半成品进库**：他的改动在他眼里可能还没验收完（他的 `lib/models.mjs` / `lib/swarm.mjs` 等 19 个文件仍是 M 状态），
  `atwo.mjs` 先落库 = 库里出现「引用未提交模块」的组合。这次没炸是因为 `pruneLanes`/`verifyModels` 在他已改的 `lib/models.mjs` 里确实存在（未提交但工作区有），
  **换个场景（他回滚了那个文件）这边就是 `ReferenceError`**。
- **测试红在我头上**：他的 `SIZE_PLAN.M` 改动让 `test/atwo_mode.test.mjs` 的 A4「打印 2 路」当场红。
  我最初把它判成「他侧的问题」，实际是**我提交下来的行为**导致的，必须由我修。

## 三、处置

1. **不改写历史**（`git reset` / `rebase` 会让他已拉到的工作区错位，且这里没有远端，改写的收益只是好看）。改留痕：本文。
2. **修测试**：`test/atwo_mode.test.mjs` A4 改成断言「单路 codebuddy」，并新增 `A4b` 断言 `--all-lanes` 仍能四路（否则他那个特性没人守）。28/0。
3. **立规矩**（已写进 `AGENTS.md` 的 ATWO 段）：共享文件提交前必须逐段看 `git diff <file>`，只提交自己的 hunk；
   别人的 hunk 不许整文件 add。`git add -A` 早就禁了，这次是「`git add <共享文件>`」的同型变体。

## 四、可复用的判据

- **「我改过这个文件」≠「这个文件里的改动都是我的」**。共享文件要用 `git add -p` 或先 `cp` 备份 + `git checkout --` + 只打自己的补丁。
- 提交前问一句：**如果另一个人今天回滚了他所有未提交改动，我这个提交还跑得起来吗？** 跑不起来就说明我把他的东西带进来了。
