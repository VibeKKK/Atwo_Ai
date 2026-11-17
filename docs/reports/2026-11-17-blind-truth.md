# 盲测：真实语料 34 份，父审两跑对照（2026-11-17）

## 一句话结论

**这一轮没有取证到父审的真误杀。** 稳定判 REVISE 的 6 份 exact 产物里，5 份经我逐行实读确认是产物真错（父审 5/5 正确），1 份父审理由被截断无法判定。真正卡住的是**标签强度**：exact 只核 EVIDENCE 里的引用，不核 ANSWER 里声称的行号与计数，因此「本该放行」的分母本身不可靠 —— 所以本轮不报 meets-bar，也不引用那个 0.6 的误杀率。

## 语料

全量扫 `.atw/fanout` 与 `.atw/army` 下 **175 份真实产物**，按 `lib/labelizer.mjs` 的 `atwo-label/2` 五档打客观标签：

| 档 | 数 | 进不进分母 |
|---|---|---|
| exact | 10 | 进（本该放行） |
| bad | 15 | 进（缺陷） |
| empty | 8 | 进（缺陷） |
| sloppy | 0 | 本应是缺陷，但这批全被过滤 —— 87 份没有快照，无法区分「产物真引错行」与「我提交代码导致行号漂移」 |
| unknown | 1 | 只报不计分 |

进分母 **34 份**（bad 15 + empty 8 + exact 10），清单在 `eval/blind-truth.json`。

判定必须对着**产物生成时的字节**：`lib/snapshot.mjs` 落盘 `snap/`，`snapCwdFor` 有快照就用快照核，没有才用当前仓库 + git 历史兜底。175 份里有快照的 21 份。

## 两跑结果（同配置：codebuddy 父审，并发 6）

| 跑次 | 抓到 | 漏判 | 误杀 | 误杀率 | 判定 |
|---|---|---|---|---|---|
| 第一跑（补丁前） | 23 | 1（bad-20） | 7（exact-6,7,8,9,10,30,34） | 0.7 | below-bar |
| 第二跑（补丁后） | 22 | 2（bad-20,bad-21） | 6（exact-6,7,8,9,10,30） | 0.6 | below-bar |

**两跑不一致的两条**：`exact-34` 第一跑判 REVISE（理由：引 import 行证不了实现），第二跑判 PASS（理由：行号内容逐字对得上）→ 同一份产物、同一个通道，结论相反。`bad-21` 第一跑 caught、第二跑 missed。**父审本身有 ±2 条的抖动**，所以单跑数字不能当基线，必须重复取交集。

## 人工复核：稳定「误杀」的 6 条

父审给的理由都能用 `sed -n` 一条命令复核，实读结果：

| 产物 | 父审说 | 实读 | 结论 |
|---|---|---|---|
| exact-9 | `lib/fanout-run.mjs:17` 不是 clampParts，是 `/**`；clampParts 在 :73 | `:17` = `/**`，`:73` = `export function clampParts(n) {` | **产物真错** |
| exact-10 | `lib/fanout-cli.mjs:28` 是 `return Math.max(1, kept.length);`，makeFanoutVerb 在 :51 | `:28` = `return Math.max(1, kept.length);`，`:51` = `export function makeFanoutVerb(ctx) {` | **产物真错** |
| exact-6 | 产物称 5 个文件「不存在」，实际存在 | `lib/models.codebuddy.mjs` 存在，5992 字节 | **产物真错** |
| exact-7 | `lib/fanout-run.mjs:17/:24/:188/:204` 都不是 export function | 与 exact-9 同文件同一批错位 | **产物真错** |
| exact-8 | `lib/cli-spec.mjs` 12 处行号整块错位约 159 行 | 产物生成于 16:xx，之后仓库提交挪了行号 | **产物真错（行号漂移）** |
| exact-30 | 先说「逐行核对无误（cost.mjs:17/81/104/120/132/176/177 全对）」，随后判 REVISE，理由到此截断 | `lib/cost.mjs:17` = `export function summarize(metaList) {`，与产物声称一致 | **理由不完整，无法判定** |

所以：**父审在这批产物上的判定是可核的、且基本正确；错的是我的 exact 标签** —— 它只保证「EVIDENCE 里引用的行对得上」，产物把行号写进 ANSWER 段落时（`第 17 行是 clampParts`）标签管不到。

## 三个方法学发现

### 1. exact 标签的分母不可靠：它只核 EVIDENCE，不核 ANSWER

`lib/labelizer.mjs` 的 `objectiveFacts` 只吃 `child.evidence`。产物在 ANSWER 里写「`fanout-run.mjs:17` 是 clampParts」时，那处引用根本不进核对。结果就是：**本该放行的 10 份里有 5 份其实有错**，误杀率的分母是假的。

下一步（本轮未做）：把「ANSWER 里声称的 文件:行 → 标识符」也纳入核对（「第 N 行是不是它声称的那个函数」机器能做弱版本：核该行是否含声称的标识符）。

### 2. 机械闸门的两类假阳性（真实语料才会暴露，自造样本发现不了）

第一跑里 `exact-9`、`exact-30` 是被**机械闸门**判死的（0 次 LLM），理由都是「引文与原文的数字对不上」。两类根因：

- **行范围当单行比**：`lib/sandbox.mjs:19-27（ALLOW 七条正则）` 只取了 `:19` 那一行，而引文描述的是 19–27 整段。修法：解析范围结束行，用整段文本核（`spanText`）。
- **行号被当成代码里的数字**：引文写成 `lib/contract.mjs:40 … :43 …` 时，`40`/`43` 被当成「抄写数字」去和第 40 行内容比，必然对不上。修法：数字紧跟在冒号后面就跳过。

两类都修了，`test/pregate.test.mjs` 加 2 条回归（21 条全过）；修后 `exact-30` 在第一跑的那种拦法消失（转由父审判），`exact-9` 也不再被机械层拦。

### 3. 引文带占位符时，标签会把人判成造假

`bad-20`（`.atw/fanout/20261117-092845/child-1.md`）被判 bad 的理由是「引用连历史里都找不到：lib/sandbox.mjs:1」。实查：它的引文是 `node --check <路径>.{mjs,js,cjs}` —— **带占位符 `<路径>`，整段永远不可能逐字出现在文件里**；抽指纹时 `node`/`check` 这类词被关键字表挡掉，指纹为空，于是退到「整段子串比对」失败 → `git grep node` 到别处 → 记 shifted → 整份 bad。

修法：引文含 `<中文占位>` 或 `…` 时只允许用指纹核，抽不出指纹就记 `weak`（看不出，不是假的）。修后 `bad-20` → `unknown`（机器核不了，只报不计分）。

这条最值得记住：**「核不了」被写成「造假」时，父审的 PASS 会被记成漏判** —— 两跑的「漏判 bad-20」就是这么来的。

## 本轮改动

| 文件 | 改了什么 |
|---|---|
| `lib/pregate.mjs` | 引用支持行范围（`spanText`）；规则 D 只比「代码位置的数字」（冒号后的行号跳过，中文量词跳过） |
| `lib/labelizer.mjs` | 引用支持行范围；引文带占位符时降级为 weak；`ATWO_LABEL_DEBUG=1` 打印每条引用的判定明细 |
| `lib/blind-objective.mjs` | 逐份并发（默认 4 路）+ 每份回一行进度（原先 34 份串行跑 12 分钟且全程 0 字节日志） |
| `lib/cli-spec.mjs` | `blind` 加 `--parts` |
| `test/pregate.test.mjs` | 加 2 条回归（行号当数字、行范围） |
| `eval/blind-truth.json` | 34 份真实语料清单（bad 24 / good 10 的人工标签 + objective 供对拍） |

水位：`test/pregate.test.mjs` 21/0 · `test/labelizer.test.mjs` 14/0。

## 已知限制（不许糊过去）

1. **标签分母不可靠**：exact 未核 ANSWER 声称，10 份里 5 份实为真错。想报真正的误杀率，必须先把 ANSWER 段纳入核对，或人工重标。
2. **父审有 ±2 条抖动**：同一份产物两跑结论可相反（exact-34、bad-21）。基线必须 3 跑取交集，单跑不引用。
3. **父审理由会被截断**：exact-30 的理由说到一半就没了（`scoreBlind` 只看 verdict，没检查理由完整性）。理由不完整的 REVISE 不该计误杀，应单列 `undecided`。
4. **sloppy 一档仍然空着**：87 份没有快照，行号漂移与真引错无法区分。要它进分母，得给旧产物补历史版本快照（`git show <sha>:<file>`）。
5. **只测了一个通道**：全部 codebuddy。异源（workbuddy/ollama/deepseek）在同一语料上的表现未测。

## 下一步（按价值排）

1. 把 ANSWER 声称纳入标签核对 → 才有可信的「本该放行」分母。
2. 盲测跑 3 次取交集 + 理由完整性检查（理由截断记 undecided）。
3. 给 sloppy 一档补历史快照，把 87 份无快照的产物从「不可用」变成「可用」。
4. 同一语料跑第二个通道，比较「同源 vs 异源」的漏判与误杀。