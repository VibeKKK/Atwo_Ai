# 一个多通道 AI 协作台的验收机制：冷却评估

- 评估对象：`D:/ai project/ai team work`（Orchestra / atwo / packages/accept）。77 个 commit，最后一提交 `2026-11-15 11:39:37 +0800`。
- 证据口径：路径 + 行号取自当前工作区；账本数字取自 `memory/log.jsonl` 的一次冻结快照（SHA-256 前 16 位 `1DC105CC58BB9C40`，449 行，2026-11-16 读取）。账本是活的：相隔数分钟两次读到 445 与 449 行，因此本文只引用快照，不引用"大概是"。
- 判断分级：凡是写"成立/不成立/已验证"的，都给了 `路径:行` 或账本数字；只有怀疑没有证据的，一律进 §6.2「未验证」，不混读。
- 本文不写：评分、功能清单、"有没有前景"。三个研究问题各占一节，末尾给最省力的推翻实验。

### 0.1 快照与复算（本文唯一可被逐位复现的部分）

快照做法：把 `memory/log.jsonl` 复制到临时目录后计算 sha256，之后所有统计只对副本做；行数用 `($raw -split "\n").Count` 数（`Measure-Object -Line` 不计空行，同一份文件实测会少算数十行）。快照为 `1DC105CC58BB9C40`、449 行。

| 通道 | n | ok | 成功率 | p50 耗时 | 平均产出字符 |
|---|---|---|---|---|---|
| codebuddy | 175 | 145 | 82.9% | 57.6s | 933 |
| trae | 196 | 147 | 75.0% | 13.4s | 804 |
| workbuddy | 44 | 31 | 70.5% | 49.3s | 302 |
| doubao | 34 | 23 | 67.6% | 62.4s | 1539 |
| 合计 | 449 | 346 | 77.1% | — | — |

三个容易读错的数先说明，避免被当成指控：`ok=true 且 outputChars<10` 有 34 条，绝大多数是"只回复两个字：收到"这类任务，属正常；`ok=true 且 outputChars=0` 只有 2 条（均 workbuddy，§2.4 F10），这才是空产出被计成功的实例；`ok=false` 共 103 条，其中 11 条 `error` 为空，失败无法归因。

## RQ1 它解决了什么问题，这些问题在文献里是否已被解决

### 1.1 真正解决的一件事：把"读渲染后的界面"换成"读写文件"

GUI 通道的回答区是渲染后的 DOM：`**` 变 `<strong>`、`##` 变 `<h2>`、反引号消失，`innerText` 回来只剩文字。`lib/swarm.mjs:27-37` 记着代价：workbuddy 花 343 秒交回的代码"反引号一个不剩"，`return [Function ${x}]` 直接是坏的。改法是让 agent 自己写文件、宿主读字节（`lib/swarm.mjs:39-55`，`askViaMailbox`，只对 trae/workbuddy/doubao 生效；codebuddy 是 CLI 子进程，本就直出字节）。

这不是新问题，是"采集介质静默有损"的经典故障（UI 自动化 flakiness 文献讨论的是同一类失效），解法是把带外通道从渲染层移走。这一条有可核对的失败记录（343 秒、反引号全丢），属于**已验证成立**的解决。

### 1.2 其余主张与文献的对应

`docs/PHILOSOPHY.md:89-96` 的四判据（异源检验、分歧保留、裁决出口、增异质不增数量）逐条都有对应文献：

| 本框架的说法 | 文献里的对应概念 | 相对文献缺的东西 |
|---|---|---|
| 异源评审 | N-version programming（Avizienis, 1985）；LLM-as-judge（Zheng et al., 2023）；多模型辩论（Du et al., 2023） | N-version 的前提是**失效独立**。这里只保证"通道名不同"（`lib/review.mjs:46-51` 按作者名排除），不保证模型、训练数据、提示偏置独立；没有 kappa、没有重复测量。 |
| 分歧是产物（不投票） | differential testing（McKeeman, 1998）；metamorphic testing | 归并用一条手写价值序（`lib/divergence.mjs:188-199`），不是从数据估出来的。 |
| 行为用例（真跑才算过） | property-based testing（Claessen & Hughes, 2000） | 没有生成器、没有收缩、没有覆盖率；用例手写（`docs/BEHAVIOR.md:87` 自认"只能验你已经想到的"）。 |
| 接口契约 | Design by Contract（Meyer, 1992） | 只有名字与参数个数，没有前置/后置条件、不变量、类型（`packages/accept/index.mjs:141-169`）。 |
| 吞吐 2.47× / 2.15× | benchmark 报告规范（重复运行 + 区间） | 6 个/10 个任务、单次、任务自选（`README.md:145-146`），无重复、无置信区间。 |

### 1.3 「分歧归并」是价值判断穿了规则的衣服

`lib/divergence.mjs:188-212` 的 `KEEP_RANK` 把行为按"信息保留度"排序：报错 5 > 保留负号 4 > 正常值 3 > 占位符 2 > 夹成 0 1，取 rank 最高者作推荐。这条序是作者定的，文件里没有任何实验数据支撑。它把"哪种行为更好"从工程权衡降级为固定偏好：对 `formatBytes(-1024)` 也许"保留负号"更对，对要求永不抛错的展示函数则"夹成 0"更对，后者在这套排序里永远垫底。

代价文案同样是常量而非测量：`consequence()`（`:221-227`）是五句硬编码，`costOfBehavior`（`:230-235`）只是把另一项的模板拼进去。所以"推荐 + 代价"读起来像决策分析，实际是两份常量文本的条件拼接。

### 1.4 RQ1 小结

- 已验证成立：文件信箱修复渲染层损坏；`node --check` + 非空 + 行数/导出名把"没写完/写坏了/名字不对"变成可自动拒绝的判据。
- 被当成结论但未验证的：异源评审"能判意图"（`docs/PHILOSOPHY.md:60-61`）、分歧归并"能替人拍板"、吞吐结论"可推广"。
- 概念上被混淆的：**异源 ≠ 失效独立**。`lib/review.mjs:24-26` 用通道成功率给评审者排序，恰恰说明它们被当成"同一能力的四个档位"，而不是四个独立观察者。

## RQ2 五层验收能否被证伪

### 2.0 先说清"五层"指哪五层

任务定义的五环是：**落盘 → 程序验收 → 接口契约 → 异源评审 → 行为用例**。而 `packages/accept/index.mjs` 内部的五层是 shape/syntax/contract/custom/behavior（§2.2）。两套不是一回事：前者是流水线的五个环节，后者是一个验收器内部的五个检查项；仓库里同时存在两套程序验收实现（`lib/verify.mjs`、`packages/accept/index.mjs`）和两套契约实现（`packages/accept/index.mjs:141-169`、`lib/apispec.mjs:91`）。下面把这两套里的失效点逐条列出。

### 2.1 「五层」是条件拼装出来的，默认只有两层

`packages/accept/index.mjs:202-274` 的实际装配：

- shape（`:218-229`）：恒在；文档类**跳过占位符检查**（`:225`，注释自认是为了不把自家 README 判失败）。
- syntax（`:231-232` → `:172-189`）：恒在；`.md` 直接返回 ok（`:188`"跳过语法检查"）。
- contract（`:235`）：**只有传了 `opts.spec` 才存在**。
- custom（`:237-257`）：行数/导出名/章节数；`if (cust.length || Object.keys(r.layers).length > 2)`（`:257`）连"这层要不要记录"都取决于前面已记了几层。
- behavior（`:268-270`）：**只有传了 `opts.behave` 才跑**。

判定出口是 `finish()`（`:292-295`）：`verdict = reasons.length === 0 ? 'PASS' : 'FAIL'`。没跑的层不产生 reason，因此**缺层不构成失败**。

这不是推断。项目自己的测试把它写成断言：`test/accept_behavior.test.mjs:86` 要求"不传 behave → 没有行为层"，`:88` 要求"不传 behave → 只剩 shape/syntax"。也就是说，一个 `.md` 默认拿到 PASS，只验了非空与扩展名两件几乎不会失败的事。「五层验收」描述的是能力上限，不是默认保证——在默认入口上它**不可证伪**。

### 2.2 每层能拒绝什么、不能拒绝什么

| 层 | 能拒绝 | 拒绝不了 | 证据 |
|---|---|---|---|
| shape | 空文件；非文档类的 TODO/省略占位 | 文档里的 TODO（`:225` 豁免）；"写完了但写错" | `accept/index.mjs:218-229` |
| syntax | 语法错误、JSON 解析失败 | 语义；`.md` 全豁免 | `:172-189` |
| contract | 导出名缺失；参数个数/名不符（仅 `export function` 形态） | 箭头函数导出（`:153` 只记 note，`ok` 仍 true）；无 params 的契约（`:151` 同）；类型、返回值、语义、调用点 | `:141-169`；`parseSignatures:89-99` 只匹配 `export function` |
| custom | 行数越界、导出名缺失、章节不足 | 行数够但内容是废话；章节够但每节两行 | `:237-257` |
| behavior | 用例覆盖到的具体错误 | 没想到的错（`docs/BEHAVIOR.md:87`）；用例本身写错（`:89` 记着一次假报警 1/5） | `accept:268-270`；`verify.mjs:132-136` |

### 2.3 一次已经发生的漏检

`docs/BEHAVIOR.md:8-16`：`humanVerdict({consensus:'all-revise', issues:17})` 输出"共列出 0 个问题"。这份产物 179 行、语法正确、五个导出名齐全、行数在区间内——形状/语法/契约/要求四层全过。`lib/verify.mjs:15-18` 自己写明了这件事。

这条反例证明：**四层静态检查的联合拒绝域不包含"把一个数数错"**。第五层是为补这个洞加的，但只在显式给用例时生效，而用例与 bug 同源（同一作者在知道 bug 之后写），是回归测试而非独立验收。

### 2.4 失效场景清单（触发条件 → 可观测后果）

- **F0 落盘层用字节数当"残答"判据**：`planLanding` 默认 `minBytes=200`（`lib/land.mjs:138`），低于 200B 直接 skip 并给理由"内容太短…可能是残答"（`:162`）；`selfLanded` 判"AI 自己写出来了"也只要求"是文件且 ≥200B"（`:126-132`）。后果：一个合法的小模块（6 行 clamp.js 约 100B）永远无法自动落盘；反过来，一份被截断但超过 200B 的文件会被认作"AI 自己落盘成功"，swarm 随即把超时改判为 done（`lib/swarm.mjs:338-347`）。测试只覆盖了 1 字节的残留（`test/swarm_salvage.test.mjs:25-26`），没有覆盖"200B 左右的半截文件"。
- **F1 缺层即放行**：不传 `spec`/`behave` 时只走 shape+syntax，`finish` 给 PASS。后果：PASS 被稀释成"文件非空、没语法错"。证据 `accept:235,257,268-270,292-295`。
- **F2 契约层存在两份实现，其中一份在 `export const` 上静默空转**：`packages/accept/index.mjs` 的 `parseSignatures` 只认 `export function`（`:89-99`），找不到签名只 push note、不置 `ok=false`（`:153`）；而同一仓库的 `lib/apispec.mjs:46` 明确有 `export const f = (...) =>` 的解析分支，`checkApiSpecSource` 会真比参数名（`docs/CONTRACT.md:134-141` 实测 `filePath`→`path` 判 FAIL）。后果：走 `accept` CLI 的契约层放过参数名全错的箭头函数，走 `verify.mjs` 的契约层抓住——同一命题两个结论。这正是 `docs/CONTRACT.md:3` 声称要防的事故（A 写 `loadTasks(filePath)`、B 按 `loadTasks(path)` 调）。
- **F3 两套验收器已经漂移**：仓库同时有 `lib/verify.mjs` 与 `packages/accept/index.mjs`。占位符正则不同（`verify.mjs:28` 的 `\.\.\.\s*$` 无行首锚 vs `accept:41` 的 `^\s*\.\.\.\s*$`）；文档豁免不同（`accept:225` 跳过，`verify.mjs:87-88` 对所有扩展名都查）。后果：同一份 `.md` 可一个 PASS 一个 FAIL，而调用方各拿一个数当结论。
- **F4 降级的多评审与单评审等价，且这是被测试固化的设计选择**：`degraded = votes.length < want`（`lib/review.mjs:256`），但 `consensus` 只在"给出裁决的票"里算（`:257-261`），`ok` 只看 `verdict==='ACCEPT'`（`:270`）；`reviewAndFix` 拿到结果后只看 verdict（`:416`），`degraded` 只进 progress 与存档头。两票里一票 ACCEPT、一票超时时 `degraded=true` 而 `ok=true`——`test/review_multi.test.mjs:69-72` 把这条写成了期望（"degraded 仍按真实票出结论"）。触发只需任一评审者超时——快照里 review 通道 10 条有 4 条失败（2 条 240s、1 条 260s 超时），不是边角。后果：所谓"多评审都过才过"，在真实失败率下退化成"一票通过"。
- **F5 返工之后不重新验收**：`reviewAndFix` 返工后跑 `verifyContent(e.file, code, opts.taskText || '', {})`（`:406`），opts 为空（无 spec、无 behave）；结果只 warn（`:409`）；最终 `ok = verdict==='ACCEPT'`（`:416`），不看 `fixed.verifyOk`。后果：评审先 REVISE、返工产出语法错、复评又 ACCEPT 时，坏文件拿到 ok。
- **F6 评审只读前 12000 字符**：`content.slice(0, 12000)` 出现于 `:325` 与 `:332`。后果：一个 200 行模块加 JSDoc 就可能超限，后半段错误永不进入裁决，结论仍是全体 ACCEPT，且报告不记录"评审看到了多少"。
- **F7 行为层默认不跑，用例还会写错**：`verify.mjs:132-136`、`accept:268-270`；用例写错会假报警（`docs/BEHAVIOR.md:89` 的 1/5）。后果：两个方向都会错——漏检，或冤枉正确产物。
- **F8 `done` 只要求"非空"**：`lib/swarm.mjs:315-317` 用 `r.ok && rec.output` 判 done；超时但磁盘上有半截产物时直接改判 `done`（`:338-347`）。后果：回显任务描述、返回上一轮答案、超时前写了半截文件，都能进 done——除非调用方额外加 `--land/--verify`，而那是可选项（`:426-427`）。
- **F9 裁决可被子串冒充**：`VERDICT_RE = /VERDICT\s*[:：]\s*(ACCEPT|REVISE)/i`（`lib/review.mjs:28`）无行首锚，`parseVerdict` 对全文任意位置匹配（`:66-69`）。后果：评审正文写"不能轻率地 `VERDICT: ACCEPT`"或在引用块里出现该字样，即判通过。提示词要求"最后必须单独一行给出裁决"（`:115-118`）只是提示词，解析器不 enforcing。
- **F10 `ok` 可以对应零字节**：快照里 `ok=true 且 outputChars=0` 有 2 条，均为 workbuddy（2026-11-13 20:02"只回复两个字：丁丁"、20:03"1+1 等于几"）。`README.md:196` 自认空产出"已加判据，未复测"。另注：`askViaMailbox` 对 doubao 无条件 `ok: true`（`lib/swarm.mjs:50-53`），但 swarm 的成功门还有非空判定（`:316`），所以空产出的 ok 记录出现在 workbuddy 而非 doubao。

### 2.5 RQ2 结论

四层能证伪的很窄：非空、语法、名字出现过、行数在区间、以及**作者已经想到并写下来的行为**。它没有判据覆盖：落盘只看字节数（F0）、语义错误落在用例之外（F7）、契约形态退化（F2）、评审没读到全文（F6）、评审结论降级（F4）、裁决被字符串骗取（F9）。因此 PASS 是**局部否定性结论**（"我没找到这几类问题"），系统叙述把它当成肯定性结论（"这份产物过了"）。

## RQ3 可复现性缺陷

- **R1 账本没有验收结论字段**。字段全集 `agent, at, cached, chars, contract, cost, elapsedMs, err, error, id, items, kind, mode, ms, ok, outputChars, pr, prFiles, promptSummary, prStatus, resultChars, retried, secs, syntax, taskChars, time, usage`（快照实测）：无 `verdict`、无 `reviewer`、无 `verify`、无 `runId`；449 行里只有 26 行带 `id`。后果：无法从流水重建"哪份产物过了哪几层"，也无法把统计追回某个 `.swarm` run。
- **R2 代码与数据不在同一版本**。77 commits，最后提交 `2026-11-15 11:39`；账本记到 `2026-11-16 01:02`；`git status` 有 88 项未提交（含 `lib/swarm.mjs`、`lib/land.mjs`、`lib/apispec.mjs`、四个 `agents/*.mjs`）。后果：11-16 的数字不能由任何 commit 复现。
- **R3 环境未版本化**。依赖 GUI 客户端在线（workbuddy 靠探测 9224 端口决定是否派活，`lib/swarm.mjs:492-504`）、依赖 trae 剩余回合（`:550-557`）。账本不记模型（快照里 `model` 字段出现 0 次）；换模型只写进 run json（`:390` 的 `rec.failover`）。后果：同一命令不同日子给出不同分布，没有字段能解释差异。
- **R4 字段不统一，统计口径会被悄悄改变**。doubao 写 `ms`，其它通道写 `elapsedMs`；快照中 doubao 34 条里 27 条有 `ms`、29 条有 `elapsedMs`（部分并存）。不做字段归一的统计会把 doubao 的耗时算成 0。
- **R5 缓存污染台账**。`cached:true` 39 条记录与真实调用混在同一日志（这份缓存命中的耗时/token 都接近 0）；成功率与 p50 若不剔除，系统性偏高。
- **R6 仓库里两套数字并存**：
  - `README.md:189` codebuddy"每次固定 ~7,633 tok"；快照 `usage.in` n=129，p50=7,869，**max=252,685**。"固定"不成立。
  - `README.md:198`"把整批成功率拉到接近 100%"；快照失败 103/449 = 22.9%，按通道 codebuddy 82.9%、trae 75.0%、workbuddy 70.5%、doubao 67.6%。
  - `lib/review.mjs:24-26`"codebuddy 85%/112s · trae 76%/37s · workbuddy 75%/98s · doubao 55%/71s"；快照同口径为 82.9%/57.6s、75.0%/13.4s、70.5%/49.3s、67.6%/62.4s（p50）。前三条成功率偏高、doubao 反而偏低（55% vs 67.6%），四个耗时一律偏高——这组数出自更早的账本且从未复算；而 workbuddy/doubao 作为评审者的样本量为零（review 类仅 10 条），把它们排进降级链（`:26`）没有数据依据。
  - `docs/PHILOSOPHY.md:71`"四个通道里有一个成功率 55%、平均只吐 61 字节"；快照里 doubao 仅 34 条，其中 ask 类 5 条、ok=0、均值 64.8 字符。用 5 个样本支持"55%"不可接受；"61 字节"与 ask 子集的 64.8 对得上，说明该句把一个小样本子集当成了通道整体。
- **R7 统计功效不足**。2.47× 来自 6 个任务单次（`README.md:145`），2.15× 来自 10 个任务单次（`:146`）；`reviews/` 只有 9 份存档（0 ACCEPT、6 REVISE、3 无裁决）；review 通道 10 条、workbuddy 44 条。任何"某通道更稳"的排序在这个 n 上都与随机波动无法区分。
- **R8 账本本身在动**。两次读取 445→449 行，无锁、无快照命令。任何人第二天重算都得到不同数字，且无法判断差异来自代码变化还是流量增加。
- **R9 批次产物不入版本控制**。`README.md:199` 明说 `.swarm/` 不进 git；磁盘上 66 个 run、246 个文件。run json 里的 `rec.verify`、`rec.land`、`partialOutput` 是唯一的验收现场记录，却随时会被下一次 run 覆盖或清理。
- **R10 评测集循环**。`eval/tasks.json` 24 题与 `eval/judge.mjs` 出自同一支笔，无 held-out、无外部基线（没有"单模型 + 普通 CI"对照组）。判据与对象同源。
- **R11 「记忆」机制为空**。`lib/review.mjs:354-359` 注释称盲区记录是"让软件有记忆的唯一入口"；`memory/blindspots.json` 实际内容 `agents.trae.counts = {}`，零条学习记录，`updatedAt` 停在 `2026-11-15T17:48:59Z`。
- **R12 测试在测真问题，但只在作者选定的框架内**。`test/review_multi.test.mjs:37-48` 钉的是"分歧不投票"这种真语义，`:61-72` 钉的是降级不得冒充双票；`test/accept_behavior.test.mjs:3-5,17-29` 的坏产物是 17→0 事故的缩小版；`test/swarm_salvage.test.mjs:20-26` 钉了"旧文件不抢救、过小不抢救"两个真实边界。这些都是真问题。缺的是：没有一条测试覆盖"默认只有两层"，反而把两层写成期望（`accept_behavior.test.mjs:88`）；没有测试覆盖 accept 与 verify 的规则差异；没有测试覆盖 12k 截断。测试保护了已实现的行为，但没有保护"五层"这个对外命题。

## §4 可实验的具体指控（主张 → 最小实验 → 预期 → 被推翻的条件）

**C0 落盘层的 200B 阈值同时误杀与误信。** 造两个产物：一份 6 行、约 100B 的合法模块，一份被截断但 260B 的前半段；分别调 `planLanding([rec])`（`lib/land.mjs:137-163`）→ 预期前者 `action==='skip'`（理由"内容太短…可能是残答"），后者 `action==='create'`。若前者能落盘、或后者被拒，F0 不成立。

**C1 默认只验两层却给 PASS。** 写 `x.md` 含 `TODO: 未完成`，`accept(p)` → 预期 `Object.keys(layers)===['shape','syntax']`、`verdict='PASS'`。若出现 contract/custom/behavior 或 FAIL，我误读了 `:225` 或 `:292-295`。

**C2 accept 的契约层在箭头函数上不生效（另一份实现却能生效）。** `f.mjs = export const f = (b,a) => a;`，`spec={exports:[{name:'f',params:['a','b']}]}`：`accept(f,{spec})` → 预期 `contract.ok===true`（notes 含"箭头函数…签名未校验"）；`checkApiSpecSource(src,spec)`（`lib/apispec.mjs:91`）→ 预期 `ok===false`。若 accept 也 false，我读错 `:89-99`；若两者都是 true，则两份实现都不抓箭头函数，F2 反而更重。

**C3 两条验收路径给出相反结论。** 同一 `x.md` 再跑 `verifyContent('x.md', content, '')` → 预期 accept PASS、verifyContent FAIL（`:87-88` 不豁免文档）。若两者一致，F3 不成立。

**C4 一票 ACCEPT + 一票失败 = ok。** `reviewMultiWithFallback({dispatch,candidates:['codebuddy','trae'],count:2})`，codebuddy 返回 `{ok:true,addedText:'VERDICT: ACCEPT'}`，trae reject → 预期 `votes=1`、`degraded=true`、`consensus='all-accept'`、`ok=true`（与 `test/review_multi.test.mjs:69-72` 的既有期望一致）。若 `ok` 被 degraded 压掉，则代码已改过、F4 只对历史版本成立。

**C5 返工后验收失败仍然 ok。** `reviewAndFix` 跑临时 `.mjs`，mock：第 1 轮 REVISE、返工返回 `` export function f( { ``、第 2 轮 ACCEPT → 预期 `ok===true`、`fixed.verifyOk===false`、`reason===null`。若 `ok` 被 `verifyOk` 拦住，F5 不成立。

**C6 评审读不到全文。** 造 20,000 字符文件，错误埋在 15,000 处；`dispatch` 断言 prompt 正文 ≤12,000 字符 → 预期断言成立、评审文本无该错误。若截断不在实际调用路径上，F6 不成立。

**C7 默认 swarm 不做验收。** `node orchestra.mjs swarm <两任务文件>`（不加 `--land --verify`），读 `.swarm/<runId>/*.json` → 预期有 `output`、无 `verify` 字段（`:426-427`）。若出现 `rec.verify`，注释过时。

**C8 「done」可由超时抢救得到。** 预置信箱半截产物，令 `dispatch` 抛带 error 的超时异常 → 预期 `status='done'`、`error` 含"产物已从磁盘抢救"（`:338-347`）。若抢救被判 timeout/fail，F8 不成立。

**C9 账本无法回答"这份产物过没过验收"。** 任取一条 `kind==='swarm' && ok===true` 的记录，只凭它找对应 run 与 `rec.verify` → 预期找不到（无 runId，无稳定 id）。若存在我没注意的关联字段，R1 不成立。

**C10 裁决可被子串冒充。** `parseVerdict('不要随便写 VERDICT: ACCEPT')` → 预期 `ok:true`。若返回 null，F9 不成立。

## §5 如果我要推翻这篇评估，最省力的实验

按"省力 / 杀伤力"排序，前两条各是一条命令。

**第一（最省力，一条命令）：验证 F9。**
`node -e "import('./lib/review.mjs').then(m=>console.log(m.parseVerdict('不要随便写 VERDICT: ACCEPT')))"`
若输出 `ok:false`，即 `lib/review.mjs:28` 的正则与我读到的不符，本文"裁决可被字符串骗过"这一节与 C10 同时倒塌；而它是五层里唯一**不需要构造任何语料**就能验的漏洞，其失效应按同比例折损其余指控。

**第二（一条命令）：验证 F1。**
`node --input-type=module -e` 写一个含 `TODO:` 的 `.md`，`accept(p)` 后打印 `Object.keys(r.layers)` 与 `verdict`。
若 `layers` 不是两项、或 `verdict='FAIL'`，则"默认只有两层"不成立，RQ2 的立论基础（PASS 只覆盖形状）要重写。

**第三（约 5 分钟，杀伤力最大）：对一份产物做变异测试。**
从 `.swarm` 挑一份带 `contract` 与 `behave` 的产物；没有就挑任一 120 行 ESM，自补 spec 与 3 条用例。造 3 个变异体：`>` 改 `>=`、`return null` 改 `return undefined`、`Math.max` 改 `Math.min`，各跑一次全层验收。
- 3/3 全 FAIL：我对"五层不具备语义可证伪性"的判断被推翻——它对未预见的变异有真实杀伤力，我低估了它。
- 0–1/3 FAIL：本文成立，且这条实验顺带给出原文没给的"实际杀伤率"。

**第四（针对评审可复现性）：同一份产物连评审 5 次，算 ACCEPT 一致率。**
5/5 同结论 → 本文"评审不可复现、无一致率统计"要收回；≤3/5 → 成立，`review.mjs:24-26` 那组数应停止被当排序依据。

## §6 未验证 / 已验证不成立（请勿混读）

### 6.1 已验证不成立（含复现步骤）

1. "五层默认全跑"不成立：`accept(任一 .md)` 的 layers 只有 shape/syntax（`test/accept_behavior.test.mjs:86,88` 把这点写成期望值）。
2. "契约层能抓签名错"在 `accept` 这条路径的 `export const` 形态上不成立（C2：`accept:89-99,153` 放行，`apispec:46` 抓住，两份实现结论相反）。
3. "多评审必须全票才 ok"不成立（`lib/review.mjs:256-270` + `:416` 不看 degraded；`test/review_multi.test.mjs:69-72` 把降级即通过写成了期望）。
4. "返工后会重新验收"不成立（`:406-409` 只 warn，`:416` 只看 verdict）。
5. "评审能看到全文"不成立（`:325`、`:332` 硬截断 12,000 字符）。
6. "账本能追回验收结论"不成立（字段全集无 verdict/verify/runId；199/449 条 contract 与 syntax 皆空）。

### 6.2 未验证（不要当结论引用）

- 变异测试的实际杀伤率（§4/§5 的实验未跑，只给预测）。
- 12k 截断是否已在真实产物上造成漏检：没拿长文件实测。
- trae"答案与上一轮完全相同"是否真被记成 done：快照里该现象的两种措辞各 5 条（合计 10），但这些都判 fail；机制上 `:315-317` 无去重，我没找到被判 done 的实例。
- 通道底层模型是否同源：本机不可观察，账本不记模型（`model` 字段出现 0 次），无法审计"异源"是否真异源。
- 评审者间一致率（kappa）：`reviews/` 只有 1 份多评审汇总（2 名评审者、REVISE 8 与 9），样本不足以估计。
- 2.47× 与 2.15× 的可重复性：未重跑。
- 本轮明确没做的事：没跑 `eval/run.mjs` 全量（24 题，`eval/` 下 10 个结果文件）；没驱动任何 GUI 通道；没做多 seed；没改任何被评代码。

## §7 一句话

它把"界面把代码弄坏"修好了（有 343 秒的实测代价作证），也把"长度、语法、名字"变成可自动拒绝的判据；但"对不对"被交给两份可能读不到全文、可能降级成一票、可被一句话骗过、且从不被复算的文本裁决——而账本里没有一格记录这些裁决。所以它最稳的产出不是"通过"，是"不知道"。
