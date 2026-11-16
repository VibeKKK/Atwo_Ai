# 2026-11-17 异源父审：接线通了，但今天只有同源通道能用

第七刀（用户 m03727「先把前四条做完」的第四条）。前三条已提交 0270478。

## 一、要解决的问题

主力与父审一直是同一个通道（codebuddy 写、codebuddy 审）。同源自审能抓矛盾与硬错，
抓不到「这家模型共同的盲区」。异源评审是这套系统唯一能拿到别的厂商语料的地方。

现状更难看的不是「没有异源」，而是**产物里没有任何字段能回答「这份结论是谁审的」**——
读产物的人只能假设它是异源的。这是最难查的假象。

## 二、改动

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| lib/lanes.mjs | GUI 通道的 ask 从 null 接上懒加载实现（trae/workbuddy/doubao）；新增 `resolveAsk(laneId)`，取不到就抛错；新增 `looksPlaceholder` 与 `looksChannelError` | 通道表里 ask=null 等于把异源这条路堵死；静默退回 codebuddy 会制造「以为异源、其实同源」 |
| lib/fanout-run.mjs | `--review-lane` → `reviewAsk`；父审超时对 GUI 通道抬到 300s（`ATWO_GUI_REVIEW_TIMEOUT_MS`）；通道报 ok:false 时把它带进票的理由；结果与 meta 带 `reviewLane / writerLane / homogeneous` | 实测 trae 187.4s 仍未收工，180s 一刀切必超时；「父审没给票」与「通道没答」必须分得清 |
| lib/fanout.mjs | FANOUT.md 增一行 `- 父审: <lane>（异源/同源）` | 同源与异源的可信度差一档，不该靠解析 meta JSON 才知道 |
| lib/army-run.mjs | 原来「lane 不是 ollama 就静默用 codebuddy」→ 改走 `resolveAsk` | `--review-lane trae` 原本会真派 codebuddy 当评审，打印里却写「异源」 |
| lib/fanout-cli.mjs / lib/cli-spec.mjs | 接 `--review-lane` | 参数必须先过闸，不然它会被当成任务文本（这个坑踩过三次） |
| **lib/reviewer-probe.mjs（新）** | `probeReviewer(lane, cite)`：派一次「真假两条产物」的评审，判 ① 解得出两条票 ② 正确产物给 PASS ③ 编造产物给 REVISE ④ 理由不退化重复 | 「能连上」≠「能当父审」。今天三条通道连得上、全部不能当父审，没有这一层就无法把这件事说清 |
| atwo.mjs | `atwo doctor --reviewers <lanes>` + `probeCitation()` | 把探活做成一条命令，任何人随时能复测 |
| test/lanes.test.mjs | 旧断言「GUI 通道没有 ask 要报错」已过时 → 改成 resolveAsk 语义（取得到 / 未知通道抛错） | 风险从「没有 ask」变成「偷偷退回同源」，后者更危险 |
| test/fanout_review_lane.test.mjs（新，5 条） | 注入式断言 reviewLane/homogeneous/抛错/产物落行 | — |
| test/reviewer_probe.test.mjs（新，9 条） | 探活四条判据 + 退化识别 + 错误文案识别 | — |

## 三、实测（全部真跑，通道 codebuddy 当主力）

| 父审通道 | 墙钟 | 票 | 判定 |
|---|---|---|---|
| codebuddy | 25.2s | 2 PASS，理由引原文 | 可用（但是**同源**） |
| trae | 187.4s | 0（先回 9 字节「思考中」，之后一直不答） | 不可用：太慢 + 占位 |
| workbuddy | 19.6s | 0（输出「抱歉，发生未知错误暂无响应…/ Kimi-K3.1-Pro」） | 不可用：服务端错 |
| ollama | 29.0s | 1 REVISE 1 缺票 | 不可用：理由同一句循环重复，且自己写「内容完全一致」却判 REVISE = **误杀** |

真跑产物：`.atw/fanout/20261117-000411`（trae 占位 9 字节）、`20261117-000524`（trae 超时）、
`20261117-001017`（workbuddy 错误文案）、`20261117-001246`（ollama 退化 + 误杀）。

### 探活实测（`atwo doctor --reviewers …`）

| 通道 | 探活墙钟 | 结论 |
|---|---|---|
| codebuddy | 11.6s / 13.4s | ✓ 可当父审（同源） |
| trae | 365.6s | ✗ 占位「思考中」→ 三条票全 unreviewed |
| workbuddy | 12.1s | ✗ 错误文案「抱歉，发生未知错误暂无响应 / Kimi-K3.1-Pro」 |
| ollama | 2.4s / 9.9s | ✓ 探活绿 —— **但它真实产物上退化 + 误杀** |

**探活的边界必须写清**：它测的是「能不能给出结构化判定、真假可比、不退化」，
**测不出「有没有真去读那一行」** —— 探活三条产物的证据里本来就带着被引原文，
不读文件也能对上。ollama 探活 2.4s 全绿，而同一天真实 2 份产物（要读文件核对）它 28.9s 退化重复 + 误杀。
所以探活是**必要条件**，不是可用性证明；要证明「真读」，得给一条证据里不含原文、只能靠 Read 核对的反例（未做）。

## 四、结论（诚实口径）

- 接线：完成。三条通道都真的派出去了，产物里能看出「谁审的」。
- 可用性：0/3。今天能出可信票的异源通道是**零个**。
- 因此任何「异源评审通过」的说法，在拿到探活绿之前都不成立。这一句已经写进 `formatProbes` 的输出。
- 下一步（不是本轮）：GUI 通道要先修「收工判定」（trae 把界面文案当答案）、修「服务可用性」（workbuddy 报未知错误），
  本地 8B 不适合当父审（退化 + 误杀，与 pregate 标定的「ollama 捏造 100%」一致）。

## 五、已知不对称

- 探活只跑一次；通道抖动（偶发超时）会被记成不可用 —— 宁可误报不可用，也不要误报可用。
- 探活的真假两条产物由本文件生成，题面固定；它测的是「能不能给出结构化判定」，不测「评审质量高低」。
- GUI 通道占位/错误文案识别用短文本 + 开头短语，120 字以上的「抱歉…」按正常回答处理（真评审常这么开头）。

## 六、回滚

单一文件回滚即可：`git checkout HEAD~1 -- lib/fanout-run.mjs lib/fanout.mjs lib/lanes.mjs lib/army-run.mjs lib/fanout-cli.mjs lib/cli-spec.mjs atwo.mjs`，
再删 `lib/reviewer-probe.mjs` 与两个新测试文件。回滚后 `--review-lane` 会退回「只有 ollama 与 codebuddy 可选」的旧语义。
