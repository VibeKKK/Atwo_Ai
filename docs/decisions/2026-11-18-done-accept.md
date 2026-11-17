# done 的验收：从「任务声明了才验」改成「改了就得验」

日期 2026-11-18 · 作者 dsh-work-replace

## 问题

`atwo done` 里原本有两段验收，**两段都可能一步不跑**：

1. 逐文件跑 accept：条件是 `t.relatedFiles` 非空。而 `task.json` 的 `relatedFiles` 常年为空。
2. 回归走 gate：`runGate({ cwd: HERE, files: [], skipTests: false })` —— `files` 写死成空数组，
   `lib/gate.mjs` 的 accept 步因此永远 `skip: true`（「给 --files 才跑五层验收」）。

结果：**收工时验收从来没跑过**。今天之前每一次 `atwo done` 都是「测试绿 + 契约绿 + 没人评审」就结了，
没有任何一步在检查「这次的交付物自己站得住吗」。这是闸门里最大的一个洞 —— 它不报错，只是不查。

## 改法

新增 `lib/gate.mjs` 的 `acceptTargets({ cwd, relatedFiles, max })`：谁该被五层验收由它判，不再由任务声明。

收集顺序：
1. `relatedFiles` 里存在、且在仓库内的（任务自己声明的排前面 —— 它比「这次碰过什么」更接近交付物）
2. `git diff --name-only HEAD`（已跟踪的改动）
3. `git ls-files --others --exclude-standard`（未跟踪的新文件）

筛掉：绝对路径与 `..` 越界、非 `.mjs/.js/.cjs`、以及 `test/ fixtures/ docs/ _probe/ memory/ collab/ reviews/ packages/ .atw/` 开头的路径。
理由：测试由 gate 的 tests 步跑、语法由 syntax 步跑，把它们塞进验收只会把真交付物挤出上限。上限 `ACCEPT_MAX = 8`。

`atwo done` 改成：`const targets = acceptTargets({ cwd: HERE, relatedFiles: t.relatedFiles })` → `runGate({ files: targets })`。
原来那段逐文件 accept 删掉（与 gate 的 accept 步重复，且它的失败信息比 gate 的更粗）。

同时加 `formatGateBrief(r)`：全绿只出两行（结论 + 时长），红只列没过的那几步。
done 用它，`atwo gate` 动词仍用完整的 `formatGate`（九步全列，那是给人看的体检）。

## 实测

```
$ node -e "import('./lib/gate.mjs').then(m=>console.log(m.acceptTargets({cwd:process.cwd()})))"
[ "atwo.mjs", "lib/gate.mjs" ]
```

当时工作区有两处未提交（atwo.mjs、lib/gate.mjs）、另有 rank1 的 docs 改动与 test 新文件 —— 后者正确地没占名额。

```
$ node atwo.mjs gate --files atwo.mjs,lib/gate.mjs --no-tests
闸门 ✓ 全绿 · 1137ms
  ✓ accept         497ms  2 个文件五层验收通过
```

五层验收真跑了，497ms。`test/accept_targets.test.mjs` 7 条（临时 git 仓库真造改动、越界路径、上限截断、brief 只印红行）。

## 已知不对称（写在这里，别当成 bug 反复查）

- **别人的未提交文件也会被验**。工作区里 rank1 改到一半的文件进了 `git diff`，就会进验收；它不过，我的 `done` 也红。
  这是有意的：**工作区不自洽的时候本来就不该收工**。逃生口是 `--force`（会在输出里明说「这条不会被当成验过了」）。
- **全提交之后再 done，等于不验**。改动为空、`relatedFiles` 为空 → `targets` 为空 → accept 步 skip。
  收工发生在「有改动要交」的那一刻，所以这个空集是正常态，不是漏洞；但要知道它存在。
- `packages/` 自己被排除（验收器本身不验自己），`fixtures/` 同理（那是测试数据）。

## 回滚

`atwo.mjs` 里把 `files: targets` 改回 `files: []`，`lib/gate.mjs` 的 `acceptTargets`/`formatGateBrief` 留着不影响任何调用方。
