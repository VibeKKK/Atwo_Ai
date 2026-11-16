# 四条中的前三件：凭证绑契约哈希 / 假红三态 / 钩子与定时闸门

日期：2026-11-16 · 执行：dsh-work-replace（rank2）

用户原话（m03727）：「先把前四条做完」。前四条来自 m03726 的判据表：
② 凭证不绑契约 → ① 假红 1/2~1/3 → ③ 无 CI + 未提交 → ④ 异源父审。本文记 ②①③，④ 另起。

## 零 · 一件事：判据是「再发生时机器会响」

「彻底解决」不等于缺点消失。三条的验收标准都写成：同样的坏发生在下一次，**不需要谁记得**，
机器自己把它变成一条红。所以三件都不改业务真值，只补「谁在什么时候一定会看它」。

## 一 · 凭证绑契约内容哈希（②）

病根：`vm/attest.mjs` 原来只记 `contractVersion`，而版本号是**自报**的。
把 `cut.high` 从 0.45 改成 0.50 而不动 `contractVersion`，旧写法下所有旧凭证照样「重算通过」
—— 等于凭证替一把已经变了的尺子背书。今早 gate 那次实验就是这么骗过去的（改阈值、闸门全绿 6146ms）。

改法：
- `vm/judge.mjs`：新增 `export const CONTRACT_HASH`，对**契约文件字节**算 sha256（不对解析结果算 —— 解析会把注释/键序抹掉）。`makeAttestation` 调用处带上 `contractHash`。
- `vm/attest.mjs`：`v: 2`，`makeAttestation` 存 `contractVersion + contractHash`；`verifyAttestation(att, {contractHash})` 四步：hash 未被改 → 契约未变 → 重算 value → 自洽。新增两个 reason：`contract-changed`（尺子换了）、`contract-unbound`（v1 旧凭证没绑，不假装通过）。不给 `contractHash` 时保持向后兼容。
- `atwo.mjs` 的 `cmdAttest`：审计时传当前 `CONTRACT_HASH`，把 `contract-unbound` 单独计成「旧版」而不是「失效」——否则旧凭证会让 `atwo attest` 永远 exit 4，人开始无视红色（这正是 ① 的病因，不能自己再犯）。

实测（真跑）：
```
改前：判定凭证 3 份，可重算 1，失效 0（旧写法下 0.45→0.50 也照样「通过」）
改后：契约改坏 → ✗ contract-changed —— 契约内容已变（尺子换了，这份凭证的结论不再代表现在）
       契约还原 → 可重算 1，失效 0，旧版 2（当前契约 v3 · 哈希 64f6b36b6194…）
```
断言：`test/attest_contract.test.mjs` 19 条（含 v1 兼容、篡改仍被拦、judge 真链路自带哈希、CLI JSON 暴露契约指纹）。

## 二 · 假红三态（①）

病根：`test/all.mjs` 只有两态。每条测试都会 spawn 真 AI 子进程，负载一高就撞 `agents/*.mjs` 的内部超时，
红出来的东西跟代码无关。以前这种红直接算失败 —— 实测一天里出现两三次（今天亲眼见到 65/66 后重跑 66/66）。
后果不是慢，是**真失败被淹在噪音里，人开始习惯性无视红色**。

改法（`test/all.mjs`）：
- 三态：`✓ 通过` / `⟳ 假红（首跑红、单跑绿）` / `✗ 两次都红`。只有第三态让退出码 1。
- 复跑是**单独**跑的（不与其它测试并发），所以两次之间唯一变量就是负载。
- 红要能分**超时**与**断言**：`timeout`（ETIMEDOUT / 子进程打 `timed out`）、`timeout-suspect`（正文只是提到「超时」二字）、`assert`。
  第三档是被自己咬出来的：第一版用 /超时|timeout/ 判超时，结果 `all_runner.test.mjs` 因为断言里写着「超时」被误判成超时。
- 深度守卫：`TEST_ALL_DEPTH`，只在最外两层复跑（最外层跑测器 + 它直接 spawn 的子进程）。
  第一版用一刀切 `TEST_ALL_RETRY=1`，把 `all_runner.test.mjs` 里「验复跑本身」的嵌套调用也关掉了 → 自测当场 5 条红。
- `TEST_NO_RETRY=1` 严格模式；`--dir` 让自测能跑假目录。

实测：
```
合成 fixture（1 绿 / 1 假红 / 1 常红 / 1 超时 / 1 只是提到超时）：
  ✓ a_pass   ⟳ b_flaky（assert）   ✗ c_fail（assert，复跑仍红）   ✗ d_timeout（timeout）   ✗ e_mentions（timeout-suspect）
  汇总：✗ 通过 2 / 5 · 假红 1（复跑已绿）  RC=1
真全量（node test/all.mjs）：✓ 通过 69 / 69 · 假红 1（复跑已绿） · 用时 146.3s
  ⟳ done_gate.test.mjs —— assert：done_gate FAILED: 11 passed / 1 failed   ← 以前这一条会让整批显示红
```
断言：`test/all_runner.test.mjs` 16 条（三态、单跑绿、超时分类、严格模式、空目录不撒谎）。

## 三 · 钩子 + 定时闸门（③ 的机器半边）

病根：全仓没有 CI（没有 `.github/`），闸门靠人记得敲 ——「记得敲」在实测里不成立
（今早 `vm/judge.mjs` 被整段回答覆写，就是从没人跑闸门那段窗口里过去的）。

改法：
- `lib/hooks.mjs`：`installHooks` / `hookStatus` / `removeHooks` / `formatHookStatus` / `formatInstall`。钩子用 `sh` 写（git 在 Windows 上也用自带 sh，不依赖 node 在 PATH）。
  - 已存在且不是 atwo 装的钩子**默认不覆盖**（要 `--force`）。
  - 钩子失败时打印「下一步」，不是甩一句 gate failed；`--no-verify` 可绕过（脚本第一行就写明绕过意味着什么）。
- 装的是 **pre-commit + pre-push**：本仓库**没有远端**，pre-push 永不触发 —— 只装 pre-push 等于自我安慰。
  pre-commit 代价 gate --no-tests 约 8.9 秒（完整 146 秒测试留给 `atwo done` 的闸门，不塞进每次提交）。
- 新动词 `atwo hooks [status|install|remove|run]`（21 个动词；`lib/cli-spec.mjs` 同步登记）。
- 计划任务 **AtwoGate**：每 30 分钟跑 `gate --no-tests`，追加到 `.atw/gate.log`（`*.log` 已 gitignore）。

实测：
```
hooks install → 已装：pre-commit / pre-push
故意把契约 cut.high 0.45→0.50：
  git commit --allow-empty  → GIT_RC_BROKEN=1（被钩子拦下，栈里直接打第 4 步 vm-smoke 的红）
  还原契约后               → GIT_RC_HEALTHY=0（真提交成功）
schtasks /run /tn AtwoGate → .atw/gate.log 落下「闸门 ✓ 全绿 · 8850ms / vm-smoke 16 组参考向量重算一致（契约 v3）」
```

## 四 · 未提交清账（③ 的人半边）

判据沿用：**别人 clone 下来能不能跑**。
- 我的（本轮）：`lib/hooks.mjs`、`vm/attest.mjs`、`vm/judge.mjs`、`atwo.mjs`、`lib/cli-spec.mjs`、`test/all.mjs`、`test/all_runner.test.mjs`、`test/attest_contract.test.mjs`、本文件 → 提交。
- rank1 的（一个不碰）：`agents/{codebuddy,doubao,trae,workbuddy}.mjs`、`lib/{apispec,batch,cdp,land,lock,models,swarm,verify}.mjs`、`orchestra.mjs`、`collab/SHARED.md`、`lib/{accept-attest,outcome,pitfalls,score}.mjs`、`test/{accept_attest,army_outcome,attest_audit,go_outcome,outcome,pitfall,score,score_cmd,verdict_program}.test.mjs`、`docs/{research,decisions/tmp-*}`。

## 五 · 改动文件

| 文件 | 动作 |
| --- | --- |
| `vm/judge.mjs` | 加 `CONTRACT_HASH`（对字节算），attestation 带 `contractHash` |
| `vm/attest.mjs` | `v:2` + `contractHash` + 两个新 reason |
| `atwo.mjs` | `cmdAttest` 传哈希、旧版单列；新增 `cmdHooks` |
| `lib/hooks.mjs` | 新建（钩子生成/装/查/卸） |
| `lib/cli-spec.mjs` | 登记 `hooks` |
| `test/all.mjs` | 三态 + 隔离复跑 + 超时分档 + 深度守卫 + `--dir` |
| `test/all_runner.test.mjs` | 新建，16 条 |
| `test/attest_contract.test.mjs` | 新建，19 条 |
| `.git/hooks/{pre-commit,pre-push}` | 已装（不在库里，`atwo hooks install` 可重装） |
| 计划任务 `AtwoGate` | 已建（每 30 分钟） |

## 六 · 已知不对称 / 还没做

- 钩子只挡 `git commit` 与 `git push`。`--no-verify` 绕过时**没有旁路记录**（没写审计），这是有意留的口子：真拦住人会去拆钩子。
- 假红的判定依赖「单跑绿」＝同一份代码更小负载。若某条测试是**概率性真错**（比如它自己 50% 概率失败），复跑会把它洗成假红。缓解：假红每次都被打印出来，翻 `.atw/gate.log` 能看到同一条反复出现 → 那它就升级成真问题，需要人看，但机器暂时不会自己升级。
- `timeout-suspect` 只是提示，不当失败。
- ④ 异源父审（Trae / WorkBuddy 接成父审）本轮未做。

## 七 · 回滚

```
git revert <commit>          # 代码全回退
node atwo.mjs hooks remove   # 卸钩子（只卸 atwo 装的）
schtasks /delete /tn AtwoGate /f   # 删定时闸门
```
注意：回退后旧凭证（v1）会重新「通过」—— 那是回退的代价，不是新行为。
