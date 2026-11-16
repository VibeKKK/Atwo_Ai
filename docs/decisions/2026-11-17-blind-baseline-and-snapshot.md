# 2026-11-17 盲测基线：为什么第一次跑出来的数字不能引用

## 一、要回答的问题
父审（PASS / REVISE）到底有多准？此前唯一的证据是 eval/fanout-cases.mjs 里我自己出的 6 道金标题 ——
我知道错埋在哪、也知道答案长什么样，那是自证不是证据。盲测要的是「标签在我之前就定下」。

## 二、做了什么
- `lib/blind.mjs`：逐份产物先过机械闸门 `preGateAll`，机械放过才送父审；只报三件事
  **漏判 missed（标 bad 判 PASS）/ 误杀 falseAlarm（标 good 判 REVISE）/ 没票 unreviewed（单列，不算通过）**，
  外加 `byPreGate`。验收线写死 `bad>=5 && missed<=1 && falseAlarmRate<=0.2`。
  故意不报「准确率」—— 它会把各种错平均掉。
- `eval/blind-manifest.json`：12 份真实产物（好 7 / 坏 5），坏样本里 2 份是客观可核（编造不存在的文件），3 份是通道失败的空产物。
- `eval/run-blind.mjs`：用 ollama 当父审，写 `eval/blind-report.json`。

## 三、两次跑（都是真跑）
| 跑 | 配置 | 结果 |
| 一 | 产物整篇当 ANSWER | 12 份全 REVISE「EVIDENCE 为空」—— 我的 bug：没拆 ANSWER/EVIDENCE 字段 |
| 二 | 正确拆字段 | 机械先抓 6 份；漏判 0、误杀 6（86%）、没票 0 → below-bar |

## 四、这一跑为什么不算数（方法层结论，最重要）
逐份复核那 6 份「误杀」，至少 2 份是真错，不是误杀：
- `good-d` 引 `lib/army-run.mjs:127`，实测该行是 `const passes = await Promise.all(Array.from({ length: reviewers }, async (_, ri) => {`，与产物所称内容不符。
- `good-b` 引 `lib/split.mjs:186`，实测该行是 `add('no-empty-chunk', chunks.length > 0 && sizes.every((n) => n >= 1), ...)`。
即：当时 codebuddy 判 PASS 属于**真漏判**被我的 good 标签掩盖了。

根因是**标签会随仓库漂移**：产物引用的是「当时」的行号，我当晚六个提交把 `lib/fanout-run.mjs`、
`lib/cli-spec.mjs`、`lib/lanes.mjs` 的行号整体推移，之后拿现在的文件去核引用，旧产物必然「引文不存在」。
用现在的仓库去核旧产物，测出来的不是父审质量，而是**仓库动过没有**。

## 五、修法：快照（lib/snapshot.mjs，本日新建）
- `refsFromTexts(texts)`：从 ANSWER/EVIDENCE 里抠被引用的相对路径（URL 与绝对路径丢掉）。
- `writeSnapshot(dir, { cwd, texts })`：把**被引用的那些文件原样**写进 `<产物目录>/snap/`，
  并落 `SNAPSHOT.json`：`{ contract:'atwo-snapshot/1', takenAt, cwd, repo:{ head, dirty, dirtyHash }, files:[{path, sha256, bytes, snap} | {path, missing}] }`。
  只存被引用的文件（体积 + 「没被引用的文件改了本来就不影响这份产物」）；拿不到的记 `missing`（not-found / outside-cwd / over-budget），绝不静默当通过；
  只允许仓库内路径（产物可以被模型写坏，防止 `../../etc/passwd`）。
- 接线：`lib/fanout-run.mjs` 的 `finishFanout` 在写 FANOUT.md 之前落快照；`runFanout` 的返回对象补 `cwd`。
- 盲测侧：`lib/blind.mjs` 的 `snapCwdFor(file, baseCwd)` —— 有 `SNAPSHOT.json` 就 `materializeSnapshot` 铺到临时目录、
  用当时的字节核引用；没有才退回当前工作区，并在结果里记 `snapshot: null`。

## 六、实测与已验证的边界
- `test/snapshot.test.mjs` 9 条全绿：抠引用去重、URL 丢弃、落 SNAPSHOT.json + snap 副本、缺文件记 missing、cwd 外拒收、铺回原路径、无快照给 no-snapshot、`snapCwdFor` 两态、改源文件不影响快照核对的字节。
- 第一个真 bug：`fanout-run.mjs` 里 `writeSnapshot` 的 import 没插进去（我的替换串与真实 import 行不一致），
  而 `finishFanout` 用 `try {} catch {}` 把 ReferenceError 吞了 → 真跑落不出 SNAPSHOT.json 却毫无提示。
  修法：补 import，并把空 catch 改成往 stderr 写一行 `[snapshot] 没落成：<message>`。
  **教训：静默 catch 会把「功能没接上」伪装成「功能正常但没数据」。**
- 已验证：in-process `finishFanout` 落出 SNAPSHOT.json（repo.head b45984e、dirty 55、files[0].path = lib/snapshot.mjs、sha256 存在）。

## 七、已知不对称 / 未做
- 本日之前的所有产物**没有快照**，不可盲测；这一批的误杀数字已在 manifest 里标 `labelStatus: 'unverified'`，不得引用。
- good 标签仍来自被测量的同一类父审（循环风险）。下一步标签应改成客观可核判据：「所引用的每个 文件:行 在快照里是否真含它声称的标识符」。
- 样本量 12（坏 5）刚够最低门槛，离「统计上站得住」还差得远。

## 八、回滚
`git revert` 本提交即可：`lib/snapshot.mjs` 是新增文件，`lib/fanout-run.mjs` 只多 import + 一段 try，
`lib/blind.mjs` 只多 `snapCwdFor` 与 `cwd: ccwd`；回滚后旧产物行为不变（本来就没有快照）。
