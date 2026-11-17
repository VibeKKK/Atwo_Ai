# 干净检出才暴露的 10 个失败（2026-11-17）

## 为什么要做这件事

本机 `node test/all.mjs` 一直是 107/107 全绿，但只要换一个 `git worktree add --detach HEAD`
的干净目录去跑，就是 70/101。**"我这里全绿"从来不是发布判据**——发布判据是"别人 clone
下来能不能跑"。所以把 CI 写进去之前，先用干净检出把每一个红都追到底。

## 五类根因（10 个红，全部实测定位）

| 类 | 症状 | 真因 | 修法 |
| --- | --- | --- | --- |
| A 依赖 gitignored 的 fixture | `accept_compare` 报 `ENOENT: _probe/cmp_a.mjs`；`parse_tasks` 报 `_probe/par3.md` 缺失 | 测试读的是 `_probe/`（被 .gitignore），本机有、干净 clone 没有 | fixture 移进 `fixtures/accept/`、`fixtures/tasks/` 并改路径；运行时生成的文件（`cmp_a_same.mjs`）落 `os.tmpdir()` |
| A2 依赖运行时任务目录 | `atwo_mode` 五条红、`pitfall` 的 `plan exit 0` 变 `code=3` | PRD 指向 `.atw/tasks/11-16-atwo-i234fz/prd.md`，那是运行时目录；干净环境里 strict 档 + 没有进行中的任务 → `go` 一律退 3 | 测试自建 `fixtures/tasks/mode_prd.md` → `.atw/tasks/_mode_fixture/prd.md`；`pitfall` 那一段先 `mode off` 再测，测完恢复 strict |
| B 写死本机数字 | `fanout_observability` 的 `84 > 84`、`atwo_json` 的 `check` 退出码 3≠2 | 断言把"本机有草稿文件/本机有任务"当成前提 | 草稿文件由测试自己造（`lib/_obs_draft.codebuddy.mjs`）；退出码断言改成"非零（3=前置 / 2=用法）" |
| C 断言比错了东西 | `pregate_run` 的「副本必须与工作区同字节」11940≠12195 | 影子副本走 `git worktree` 且显式 `-c core.autocrlf=false -c core.eol=lf`（`lib/worktree.mjs:97`），所以副本是 LF、工作区是 CRLF；差 255 = 行数 | 改成按行比较（`split(/\r?\n/)`），比的是"内容一致（含未提交改动）"，不是行尾字节 |
| D 机器可读出口随环境变形 | `attest_contract` 的 7b/7c：`data.attest.judge.contract` / `.legacy` 整个消失 | `cmdAttest` 里这两个字段只在"有凭证文件"时才赋值 → 没有 `memory/attest-judge.jsonl` 时形状就变了 | 产品侧修：`contract` 与 `legacy` 无条件初始化（`--json` 调用方不该每次判字段在不在） |

## 一个真 bug（不是测试的问题）

`lib/fanout-cli.mjs` 用 `fs.mkdirSync(dir, { recursive: false })` 当"目录占位锁"，抢不到才
退让。这在 `.atw/fanout` 父目录不存在时抛的是 **ENOENT** 而不是 EEXIST，而 `catch` 只认
EEXIST，于是直接抛出去 —— **裸 clone 的第一次 `atwo fanout` 必崩**。本机从来没暴露，因为
`.atw/fanout` 早就被几十次真跑建出来了。

修法：占位之前先 `fs.mkdirSync(path.join(HERE, '.atw', 'fanout'), { recursive: true })`。

## 顺带修的两个公开面问题

- `agents/demo.mjs`（接入指南）import 的 `checkBudget` / `charge` / `validateSyntax` 三个名字
  从来不存在，照抄必崩；已对齐 `check` / `record` / `checkSyntax`。
- `lib/gate.mjs` 新增第 9 步 `exports`（`lib/exports-check.mjs`）：原有 closure 步只查"文件在不在"，
  查不出"名字在不在"。本步拿坏 HEAD 验过，抓出 9 处 `import` 了但对方没导出。

## 判据（以后每次发布都跑这一条）

```
git worktree add --detach /tmp/x HEAD
cd /tmp/x && node atwo.mjs gate --no-tests && node test/all.mjs
```

两个都必须绿，才算"可以发"。本机绿不算。
