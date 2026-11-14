<!-- 自检：node --check 对 .md 不适用；用 wc -l docs/COOKBOOK.md 核对 100–160 行 -->

# COOKBOOK · 场景配方

把命令按「场景」记，不按字母表记。6 个配方来自真实派活记录，耗时取自 trae / codebuddy / workbuddy 实测单次调用；在仓库根目录执行，先 `doctor` 看环境、`budget` 看额度。

## 0. 十条命令速查

- `ask <agent> "问题"`：单问一个 agent 一个问题，最轻的探测。
- `swarm <任务源> [--agent] [--slots] [--out] [--resume] [--no-switch]`：把任务源拆开并行派给多个 slot。
- `top [n]`：看前 n 个 slot / agent 的实时占用与剩余回合，默认 n=5。
- `batch <agent> <任务源>`：一串任务塞给同一个 agent 串行跑，不换 agent。
- `duo <a> <b> "问题"`：同一问题让两个 agent 各答一遍，拿两份独立答案。
- `ctx "任务"`：预览这条任务会被注入的上下文，派活前核对别带错文件。
- `doctor`：检查运行时、agent 连通性、输出目录权限。
- `stats`：历史成功 / 失败 / 耗时分布，排期前看一眼。
- `budget`：剩余回合、剩余时长、剩余额度。
- `auto "问题"`：按问题类型自动选 agent 和模式，拿不准时用。

## 1. 任务源的三种写法

三种写法对吃「任务源」的命令（swarm / batch）通用，一个任务源只能选一种，别混。
1. 文件路径：文件里每行一条任务。如 `swarm tasks/refactor.txt --agent trae --slots 4 --out out/refactor`
2. 单行分隔符：写成 '任务1|||任务2'（整串用单引号包住、||| 分隔），临时起意、懒得建文件。如 `batch workbuddy "改名 foo→bar|||改名 baz→qux|||补一行注释"`
3. 以 - 开头的列表行：只收以 - 开头的行，标题 / 空行 / 说明自动忽略，最适合从需求文档抠任务：
   ```
   - 把 utils/a.mjs 的 console.log 换成 logger
   - 把 utils/b.mjs 的 console.log 换成 logger
   ```
   存成 tasks/logger.md 后 `swarm tasks/logger.md --slots 6`。列表项内别硬折行，要换行就改用文件路径或 |||。

## 2. 耗时基线（单次调用，秒）

| agent | 单次区间 | 体感 |
| --- | --- | --- |
| trae | 19–36s | 最快，但有 8 回合上限 |
| codebuddy | 54–118s | 慢、波动大，曾 900s 超时 |
| workbuddy | 18–20s | 最稳，短任务首选 |

估算：总耗时 ≈ ceil(任务数 / slots) × 该 agent 单次区间，再加约 10% 调度开销；batch 串行无 slots 分摊，按 任务数 × 单次区间。下列配方耗时都按此给区间。

## 配方一 · 批量同款改造

适用：几十个文件做同一种机械改动（改名、换 API、加头注释），任务之间无依赖。
命令
```
swarm tasks/refactor.txt --agent workbuddy --slots 6 --out out/refactor
```
先 `ctx "批量同款改造"` 看注入的上下文只含目标目录，别把整个仓库塞进去。
任务源写法：文件路径 + 列表行，每条只写「文件 + 改动」，别写理由（占 token 又不会更准）：
```
- src/a.mjs: var → const
- src/b.mjs: var → const
- src/c.mjs: var → const
```
预计耗时：24 个文件 / 6 slots = ceil(24/6)=4 批 × workbuddy 18–20s ≈ 80–95s；换 trae 约 85–160s，换 codebuddy 约 4–8 分钟且方差大。
什么情况别用：改动之间有依赖、要跨文件统一决策、或单文件得读半个仓库——退回 `ask trae "先给个整体改法"` 人工定调，别并行，slot 之间会互相覆盖。

## 配方二 · 多视角评审

适用：一个设计要两到三份独立意见，且希望意见之间不互相污染。
命令
```
duo trae codebuddy "评估 docs/COOKBOOK.md 的信息架构，列 3 个最该改的点"
```
要三份再补一次 ask workbuddy 同题即可；duo 固定两个 agent。
任务源写法：这种场景不建任务源，问题直接当参数传；要比多个维度才用 ||| 串给 batch trae：
```
batch trae "只看可读性|||只看命令是否真实可执行|||只看耗时数字是否自洽"
```
预计耗时：duo 并行取较慢者，约 55–120s（codebuddy 决定上限）；三次串行 ask，trae 约 60–110s、workbuddy 约 55–65s。
什么情况别用：要的是「一个确定答案」而非「几种看法」时别用，两份答案还得人合；也别拿 duo 核对客观事实（版本号、行数），那用 `stats` 或直接读文件更准。

## 配方三 · 大批量短问答吃满 trae 8 回合

适用：一堆独立、一两句话答完的小问题，想在一个 trae 会话里把 8 回合用满，省掉反复冷启动。
命令
```
batch trae tasks/qa.txt
top 8
```
batch 不换 agent、不分 slot，正好一问一回合；跑完 `top 8` 看 8 回合是否吃满、有无空转，budget 跑前跑后各看一次。
任务源写法：||| 单行最顺手，8 条正好对齐 8 回合，多一条会被截或另开会话：
```
batch trae "ESM 怎么导入 node: 内置?|||中文 JSDoc 写什么?|||2 空格还是 tab?|||单引号规则?|||行尾分号?|||node --check 干嘛的?|||零依赖怎么保证?|||import/export 能混用吗?"
```
预计耗时：8 个短问答常见 2.5–4.5 分钟；触发整段重写会顶到 36s×8 ≈ 5 分钟上限。同量 workbuddy 约 2.5–3 分钟且更平。
什么情况别用：任一问题要读大文件、要长输出、或问题之间有承接关系时别用——8 回合是「短」回合，长任务会挤掉后面的；超过 8 条别硬塞，拆两个会话更稳。`--no-switch` 是给 swarm 的，batch 本就锁死单 agent，不用加。

## 配方四 · 长文档分章改写

适用：长文按章节重写，章节之间要风格一致但内容独立。
命令
```
swarm tasks/chapters.md --agent codebuddy --slots 3 --out out/chapters --no-switch
```
`--no-switch` 关键：不让调度器中途换 agent，否则前后文风会裂；--out 指目录、每章单独落文件。先 `ctx "分章改写"` 确认注入的是「全文+本章」，否则每条自带术语表。
任务源写法：列表行，每条标章节号 + 要求，章节号要连续可排序：
```
- 第1章 开场：压到 200 字，去掉客套
- 第2章 安装：命令改成可复制整行
- 第3章 配方：每个补「什么情况别用」
```
预计耗时：9 章 / 3 slots = 3 批 × codebuddy 54–118s ≈ 3–6 分钟，且最易撞 900s 超时；赶时间换 trae 约 1–2 分钟，但要接受文风略飘。
什么情况别用：章节强依赖（第 3 章要引用第 2 章新术语）、或全文只 2–3 章时别用，调度开销比省下的还多，直接 `ask codebuddy "整篇按 X 风格重写"` 更省；codebuddy 刚超时过的时段别排它，见配方六。

## 配方五 · 测试用例生成

适用：给一组函数批量补测试，用例独立、可并行、结果要能直接落盘。
命令
```
swarm tasks/cases.md --agent workbuddy --slots 8 --out tests/generated
stats
```
生成完立刻 `stats` 看失败率：这类失败多半是任务源写得太笼统，不是 agent 不行。
任务源写法：每条必须带「被测对象 + 期望行为」，别只写函数名；存文件用列表行，失败时凭行号定位：
```
batch workbuddy "parseDeps: 空数组返回空 by|||parseDeps: 环依赖抛错|||parseDeps: 重复 id 去重|||top: n 省略时默认 5"
```
预计耗时：32 条 / 8 slots = 4 批 × workbuddy 18–20s ≈ 80–95s；同量 trae 约 85–160s；codebuddy 不建议，慢且波动会把 stats 曲线拉花。
什么情况别用：用例要共享同一套 fixture / 数据库状态、或要测并发时序时别用，并行 slot 会互踩；也别生成「跑起来才知道对不对」的快照测试，先 `doctor` 确认环境干净，再单条 ask 定基准。

## 配方六 · 失败排查用 --resume

适用：swarm 跑到一半有 slot 失败 / 超时，不想重跑全部、只补失败那几条。
命令
```
swarm tasks/big.md --agent codebuddy --slots 4 --out out/big
swarm tasks/big.md --agent codebuddy --slots 4 --out out/big --resume
top 10
stats
```
`--resume` 只认「同一任务源 + 同一 --out」：读上次落盘进度，跳过已成功的，只重派失败 / 未开始的条。`top 10` 看卡住的 slot，stats 看失败集中在哪个 agent。曾有 codebuddy 单任务 900s 超时、产出 0 字符，就是靠 --resume 把那批补回来的，没从头再来。
任务源写法：必须和首次完全一致，三种形态都不能换（别把文件路径改成 |||），也别增删行或改顺序，否则进度对不上、会被当成全新任务全量重跑。要改任务就删掉 --out 目录重开。
预计耗时：只补失败条。40 条挂 5 条 / 4 slots = 2 批 × codebuddy 54–118s ≈ 2–4 分钟；对比全量 40 条约 9–20 分钟，省的是大头。补完 `budget` 看重试有没有吃掉额度。
什么情况别用：失败原因是任务源本身写错（命令拼错、路径不存在）别 resume，会把同一条错误重派一遍，先 `doctor` + `ctx "任务"` 改对再重开；失败是「产出质量不满意」而非「没产出 / 超时」也别用，--resume 只认失败状态、不会重写已成功的条，这种改 --out 或 `auto "重写第 N 条"`。

## 3. 收尾三连

派活前：`doctor` → `budget` → `ctx "任务"`；派活后：`top [n]` → `stats` → 有失败才 --resume。
拿不准用哪个 agent 或哪种模式，直接 `auto "问题"` 让系统选；但 auto 不接任务源，批量场景仍得回到 swarm / batch。
一句话选型：短稳量大 → `batch workbuddy`；吃满 8 回合 → `batch trae`；独立任务并行 → swarm；两份意见 → duo；长文不换风格 → --no-switch；跑挂了 → --resume。
