# 两个结构化动词：atwo edit / atwo stage

日期：2026-11-18 · 作者：dsh-work-replace（rank2）

## 一、治什么病

今晚（11-17）踩过四次同类事故，每次 5–10 分钟：

1. 补丁脚本里写成 `'\n'`，落盘变真换行，文件损坏两处；
2. 正则反斜杠被吃（`/^-\d/` 变 `/^-d/`）；
3. `tools.read` 带 limit 读前 N 行，整体 write 回去 = **把文件截断**（writeback.mjs 240/244、patch.test.mjs 141/154 各一次）；
4. `git add <file>` 整文件暂存，把同事未提交的改动一起签走（11-16 三笔提交事故）。

病根不是手滑，是**接口**：我调工具的方式是「shell 字符串 + 整文件读写」。字符串要转义、整文件要重写，小步骤一交出去，交接成本吃掉全部收益。
`atwo patch`（影子副本里写代码）已经替掉了「改代码」这一半，这两个动词替掉「改文件」与「提交归属」那一半。

## 二、atwo edit（lib/edit-ops.mjs + lib/edit-cli.mjs）

指令走 **JSON 文件**（`--spec`），不走命令行 —— 命令行要过 shell 引号与转义，那正是它要消灭的错误来源。

三条硬规矩：

1. **字面量匹配，不收正则**。正则要转义，转义就是今晚全部 bug 的来源。
2. **默认要求唯一命中**。命不中（`not-found`）或命多（`ambiguous`）都是错，不猜。要全替换得显式写 `all: true`。
3. **原子**。全部 op 先在内存算完；任一条失败一个字节都不写；改完自动 `node --check`（只对 .mjs/.js/.cjs），语法红则整批回滚到改前字节。

两种 op：

```json
{ "ops": [
  { "file": "lib/x.mjs", "find": "const a = 1;", "replace": "const a = 2;" },
  { "file": "lib/x.mjs", "anchor": "export function run() {", "insert": "  // 入口", "where": "after" }
] }
```

失败机器码：`empty-find` / `not-found` / `ambiguous` / `ambiguous-anchor` / `anchor-not-found` / `empty-insert` / `unknown-kind:<k>`；整体失败原因是 `atomic-abort` 或 `syntax-after-edit`（带 `rolledBack: true`）。
EOL：读入统一成 LF 匹配，写回原 EOL（CRLF 文件不会混进单个 LF）。
记账：每次成功改动落 `.atw/edits.jsonl`（`{ts, by, file, line, delta, to}`），`to` 是被写进去的片段，供 `stage` 认领 hunk 用。

## 三、atwo stage（lib/stage-own.mjs + lib/stage-cli.mjs）

只把**我改的那些 hunk** 放进暂存区。

判据不靠行号（行号会因别人的改动漂移），靠**文本证据**：`edits.jsonl` 里每条记录的 `to` 片段，只有 hunk 的新增行里含这个片段，才算我的。片段短于 8 字符不用于认领（避免把别人的行认成我的）。

- 命不中的 hunk 一律跳过，绝不猜；
- 幂等：已暂存的改动不再出现在 `git diff` 里，重复跑不会重复暂存；
- `--assume a.mjs,b.mjs`：显式声明这些文件的所有 hunk 都算我的 —— 人的判断作为输入，机器不自己拍；
- 只暂存，不 commit：**消息里写什么机器不知道**，那一步仍手写。

## 四、实测（全部真跑）

| 项 | 结果 |
| --- | --- |
| `node test/edit_ops.test.mjs` | 12 passed / 0 failed（唯一命中 / 歧义拒绝 / all / insert after·before / CRLF 保持 / 多 op 原子 / 语法红回滚逐字节相同 / dry-run 不写盘 / 越界拦截 / 未知 kind / 记账字段 / 文案） |
| `node test/stage_own.test.mjs` | 7 passed / 0 failed（别人的 hunk 一个不进暂存区 / 幂等 / dry-run 不动 / 无记账不猜 / 坏行跳过 / hunk 解析与 patch 拼装 / 短片段不认领） |
| `atwo edit --spec _probe/e2e-edit.json` | 「改完了：1 个文件 / ✓ 第 2 行 delta 0 / ✓ 第 1 行 delta +2」，文件内容正确；重放同一 spec → `not-found` → `atomic-abort` exit 4（幂等失败可见） |
| `atwo stage --dry-run`（真仓库） | 我的 0 处 / 别人的 6 处 —— 那时改动还没走 atwo edit，所以一处都不认领（fail-closed） |
| `atwo stage --assume atwo.mjs,lib/cli-spec.mjs`（真仓库） | 我的 5 处已暂存；`git diff --cached --name-only` 只有这两个文件；同事未提交的 `docs/decisions/atwo-io8xnw-2026-11-17.md` 一个字节没进暂存区 |

## 五、已知不对称（写下来免得以后误以为是 bug）

1. **没走 `atwo edit` 的改动，stage 一律不算我的**。这是有意的 fail-closed：宁可不动，也不猜。要么改文件时就用 `atwo edit`，要么人显式 `--assume`。
2. `atwo edit` 只做字面量替换与定点插入，不做重构、不做跨文件重命名。
3. `stage` 不生成 commit message，也不 push。
4. 一个 hunk 里如果同时含我的片段和别人的行（改动相邻），整块仍按“含我的片段”认领 —— 这种情况要人看一眼 `git diff --cached` 再提交。

## 六、回滚

两个动词都是新增代码 + 一行 import + 一个 table 条目 + cli-spec 一条目：

```bash
git revert <commit>
```

回滚后 `.atw/edits.jsonl` 残留无影响（没有读者）。

## 七、下一步（同批的另外三个动词）

- `atwo triage --why`：失败先判「真失败 / 假失败（负载超时）」再决定要不要重跑；
- `atwo plan --from-inbox`：把收件箱里失败项排成下一步清单；
- `atwo report`：按 `.atw/` 现有事实生成交付摘要（现在靠我手写）。