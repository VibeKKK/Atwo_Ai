# 异源父审：从「标签写 A、实际用 B 审」到能自纠的一层

日期：2026-11-18 · 作者：dsh-work-replace（rank2）· 主线：atwo fanout 父审

## 起点：一个看不见的假象

`atwo fanout` 的父审（reviewer）本该用「另一双眼睛」看子会话的产物。改造前有三个洞，
其中第二个是**产物层面完全看不出来**的那种：

| 洞 | 形态 | 后果 |
|---|---|---|
| ① pickReviewLane(cwd) 不知道主力是谁 | 可能挑中主力同一条通道 | 自审只能抓矛盾与硬错，抓不了「三份一致地错」 |
| ② label 与 ask 不同源 | `reviewLane = pickReviewLane()` 但 `reviewAsk = ask`（主力那份） | FANOUT.md 印「父审: trae」，实际是 codebuddy 在审 |
| ③ 台账空时 return 'codebuddy' | 主力也是 codebuddy | 陌生人的干净 clone 里，异源等于没做 |

② 的根因是一行：`opts.ask ? 'injected' : pickReviewLane(...)` —— 只要给了 lanes 又注入 ask，
异源分支整个被绕过，但产物上仍然写着挑出来的那条通道。**判据只能落在参数上，不能落在意图上。**

## 通道事实（2026-11-18 本机实测，决定一切设计）

| 通道 | kind | 当父审实际表现 | 能不能核「文件:行」 |
|---|---|---|---|
| codebuddy | cli | 9–25s，逐行核对真引文 | 能（有 Read） |
| trae | gui | **340s** 后回「界面占位文案（）」 | 名义能，实际回占位 |
| workbuddy | gui | 同类，2026-11-17 实测挂 17 分钟无结论 | 同上 |
| deepseek | http | 整跑挂住 5 分钟以上没返回 | **不能**（无工具，读不到源码） |
| ollama | http | 探活全绿，审真产物时编造引文 | 不能 |
| codex | cli | app-server 初始化被拒（os error 5） | 本机起不来 |

结论：本机唯一「快且能给票」的父审就是 codebuddy。想让异源成立，不能靠换一条通道就完事，
要先把「谁适合当父审」和「等多久」两件事分开算。

## 落地的六笔

1. **7e38954** 父审默认异源 + 退回同源必须留痕
   - `pickReviewLane(cwd, { avoid: mainLanes })`，`preferHetero()` 先排除主力，排空才退回原池
   - 通道挑选与超时挪到编队之后（知道主力是谁才能避开它）
   - 语义分层：显式 `--review-lane` 起不来 → **抛**（不许悄悄换人）；自动挑选起不来 → 退回主力 + `reviewWanted` 留原名 + `reviewFallback` 留原因
   - 顺手修真 bug：`finishFanout` 用 `path.join` 却没 import → HANDOFF.md 一直没落成，被静默 catch 掩盖
2. **b75c600** 异源没给票 → 退回主力重审一次
   - 起因：真跑 340s 白等，两片全 unreviewed，整跑 RC=5 —— 既没结论也没法看出该修哪
   - `runReviewChunk(slice, askFn)` / `reviewOnce(kids, askFn)` 参数化
   - 退回一次仍没票也进 rounds 台账（`reviewFallbackFrom` + `reviewFallbackOk:false`）：退回后依然没结论是更严重的事实
3. **8c7153c** 台账空时静态推测异源 + `reviewSource` 贯通产物
4. **916bc5f** 静态只挑「明知可用」的通道（`laneReady`）+ 通道失败原因归一（`error` → `err`）
5. **c39b105** 静态选择给 90s 短墙（不再押 300s 地板）
6. **ed2c112** 短墙真生效：抽出纯函数 `reviewTimeoutFor()`

## 四条教训（比代码值钱）

**1. 产物里写假话，比没有机制更糟。**
c39b105 之后 FANOUT.md 印「只等 90s」，实际 `Math.max(timeoutMs=180000, guiFloor=90000)` 仍取 180s，
整跑 205s 才退回。读产物的人会以为机制在保护他。凡是产物里写出来的数字，必须来自真算出来的那个变量。

**2. 「源码 grep」测试永远能过。**
第一版短墙测试断言 `reviewSource === 'static' ? Math.min(guiReviewFloor` 这个字符串存在 —— 它存在，
但语义是错的（min 之后还要 max 一次）。改成纯函数 + 四个数字断言（180000 / 300000 / 90000 / 45000），
bug 才现形。**能被单测的纯函数 > 能被 grep 的字符串。**

**3. 通道的失败原因必须归一。**
codex 明明回了「app-server 初始化被拒（os error 5）」，产物只写「通道返回 ok:false 且没给 err」——
排障时等于什么都没说。原因是各适配层字段名不统一（codex 用 `error`，别人用 `err`）。
归一点放在 `lazyAsk` 出口，所有通道同时受益。

**4. 异源 ≠ 换一条通道就完事。**
GUI 通道「能投票 ≠ 能核引文」（它的 Read 在它自己的工作区）；HTTP 通道连 Read 都没有。
所以真正需要的是两级：`laneReady()` 先排掉物理上干不了这活的（无工具 / 已知坏），
再让台账用实测结果逐步收敛（谁真的给过票、谁只是名义上可用）。

## 现在的行为（干净 clone 的第一次 fanout）

1. 台账空 → 静态推测，避开主力 codebuddy → 挑 trae（`reviewSource: static`）
2. 只等 90s（不是 300s）→ trae 超时或回占位
3. 退回 codebuddy 重审一次 → 拿到逐行核对结论
4. FANOUT.md 留下三行，谁读都知道这次是怎么回事：
   ```
   - 父审: codebuddy（同源 —— 主力与评审是同一家）
   - 父审退回: 本想要 trae，起不来（…没给票（trae 在 90000ms 内没有返回（硬超时）））→ 实际用 codebuddy 主力通道，同源
   - 父审依据: 静态推测（台账里没有这条通道的实测记录；只等 90s，拿不到就退回主力自审并在下面留痕）
   ```
5. 台账记下 trae 这次失败 → 下次 `pickReviewLane` 不再推它，越用越准

### 实测（干净检出 ed2c112，`.atw/fanout/20261118-034522`）

```
父审退回: 本想要 trae，起不来（…trae 在 90000ms 内没有返回（硬超时））→ 实际用 codebuddy 主力通道，同源
子会话 8.6s + 审查 99.7s · 共 2 轮（含自愈重做）· 墙钟 108.7s
```

90s 墙真生效（不是 205s）；退回后 codebuddy 给了逐行核对结论
（`lib/split.mjs` 的 :13 :15 :76 :84-139 :109-114 :118-124 :127-135 :142 :147 :149 :151 全部引到）。

**trae 这次的真实失败原因**（日志原文，比我原先猜的「慢」精确得多）：
```
[恢复0] 换模型失败：点了但按钮没变：GLM-5.3-Flash
[恢复1] 45 秒无新回合，自动开新对话重发一次
```
它被切到 GLM-5.3-Flash 且换模型没生效 —— 通道状态坏了，不是「GUI 天生慢」。
这也解释了 2026-11-17 那次 17 分钟无结论：同一类故障，表现成「不返回」。

## 还没解决

- **GUI 通道不能核引文**：它的 Read 在自己工作区，看不到我们的仓库。要它真核，得把证据片段随提示词递过去
  并且明确「不许声称读过文件」。这是下一步。
- **HTTP 通道（deepseek）挂死不返回**：`capMs`（reviewTimeoutMs + 60000 或 240000）没兜住，
  原因未查（怀疑适配层不认 timeoutMs 且 lazyAsk 未包装它）。
- **异源第二意见**：deepseek 无工具但能判「结论是否超出证据」—— 把它当「第二意见层」而非「父审」，
  需要新增一层，而不是塞进现有 reviewLane。
