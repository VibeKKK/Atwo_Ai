# 事故记录：vm/judge.mjs 被 LLM 回答覆写（2026-11-16）

## 一、症状

`node atwo.mjs fanout` 直接崩在启动期：

```
file:///D:/ai%20project/ai%20team%20work/vm/judge.mjs:1
I've reviewed the machine semantics, compiler, CLI consumer, and existing tests. Here is the delivered code.
SyntaxError: Invalid or unexpected token
```

`vm/judge.mjs` 从 223 行变成 3 行：第 1 行是英文散文，第 2 行起是一个 JSON 对象
（`{"summary":..., "code":..., "notes":[...], "confidence":0.86}`）。
即某次「让 LLM 产出代码」的回答被**原样当成文件内容**写进去了。

## 二、根因

`agents/codebuddy.mjs` 的 `--tools` 默认值是 `Write,Edit,Read`。
`fanout` 里「父只审不干」只把**父审**的 tools 钉成 `Read`，
**子会话拿的是默认值，天生有写权限**。派出去的活只要没显式禁写，就可能改到热点文件。

同一批未跟踪文件（`vm/attest.mjs` 46 行、`vm/verdict.mjs` 70 行、`test/verdict_program.test.mjs` 92 行）
内容与那份 JSON 的 `code` 字段一致 —— 它们都是同一次派活的落地产物，而 `vm/judge.mjs` 的 diff 段没法自动落地，
于是文件被散文占位。

## 三、处置

1. 恢复：`git checkout -- vm/judge.mjs`（对比 `4d6f5b7:vm/judge.mjs` 与 `vm/judge.mjs.bak-verdict-prog`，
   两者 `diff` 为空 = 逐字节相同，备份可信）。恢复后 223 行，`node --check` 通过。
2. 隔离半成品：`test/verdict_program.test.mjs` → `.wip`（发现式入口不会捡它）。
   该测试前 9 条在跑（真跑字节码、300 组随机一致），第 10 条因 `judge()` 尚未接线而崩。
   `vm/attest.mjs` / `vm/verdict.mjs` 原地保留，无人 import，等归属确认后再决定是否接。
3. 上锁：新增 `READ_ONLY_TOOLS = 'Read,Grep,Glob'` 作为 `runFanout` 的默认 `childTools`；
   要写权限必须显式 `--allow-write` 或 `--child-tools Write,Edit,Read`。
   `test/fanout_readonly.test.mjs` 7 条断言，其中 3 条是源码级（默认值来源、调用点真传了 tools）。

## 四、验证

- `node test/all.mjs` → 54/54 · 40.2s
- `node atwo.mjs fanout "..." --dry-run` → 打印「子会话工具 Read,Grep,Glob（默认只读：派出去的子会话改不动仓库）」
- `git diff 4d6f5b7:vm/judge.mjs vm/judge.mjs` → 无输出

## 五、教训

1. **只读必须落在参数上，不能落在提示词里。** 「父只审不干」只写进了父审的 tools；子会话没有对应约束。
2. **子会话的产物是文本，它不需要写盘。** fanout 的落盘由父进程做，所以子会话的只读是零成本的。
3. **备份要能被验证**：`diff 提交版 备份` 为空才算可信，不要只看文件名像不像。
4. **未跟踪的新文件要查 import 闭包**，否则「幽灵模块」会一直躺在仓库里，谁也不知道该不该留。