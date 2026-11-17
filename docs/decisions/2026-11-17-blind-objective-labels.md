# 2026-11-17 · 盲测标签客观化（atwo-label/2）与对照组

## 为什么
2026-11-17 凌晨那次盲测报「误杀 86%」，复核发现是**人工标签跟着仓库漂行号**造成的假数：
产物引用的是生成当时的行号，我当晚九个提交把 lib/*.mjs 整体推移，拿现在的文件核旧产物必然「引文不存在」。
所以标签不能再由人贴，必须由字节算。

## 做法（lib/labelizer.mjs）
对每份产物只做三件事：① 抽「文件:行」② 把该行原文读出来，与引文比 ③ 把结论落到五档之一。

| 档 | 判据 | 用途 |
|---|---|---|
| `exact` | 每条引用逐行对得上 | **唯一「本该放行」的类**，误杀率的分母 |
| `sloppy` | 引文在文件里但不在所写的行上（±3 行内 / 全文件 / 仓库别处） | 父审判 REVISE 是抓对了 |
| `bad` | 文件不存在，且引文在 git 历史里也找不到 | 编造 |
| `empty` | EVIDENCE 为空或产物自己写 `(空)` | 上游通道没交卷 |
| `unknown` | 一处「文件:行」都没有，或引文全是中文叙述提取不出指纹 | 判不了，不进指标 |

人工标签（good/bad）与客观标签比对前先归大类（`labelClassOfHand` / `labelClassOfObjective`），
否则「good vs exact」会被算成不一致。**这两个函数只有一份，两处共用** —— 原先 blind-objective.mjs 里还有一份裸比较，
导致对照组 4 份全报「不一致」。

## 五轮校准（每一轮都是上一版把「仓库漂移 / 作者叙述」算成产物的错）
1. 扩展名表太小（没有 .go/.rb）→ 引文抽不出 → 6 份判 unknown。
2. 不带目录的 `army-run.mjs:78` 判 file-missing → 加 basename 索引（跳过 .git/node_modules/.atw，上限 4000 文件）。
3. 「引文前 8 字比对」不成立（中文引号里常是作者描述、带全角括注）→ 改成取引文里最长的 ASCII 标识符当指纹。
4. 指纹只认「含代码标点」→ `opts.lanes` 这种带点的标识符拿不到指纹 → 跳过核对 → 内容对不上的产物被判 **exact**。
   **这是本轮最关键的 bug**：good-c 引 `lib/lanes.mjs:166` 写的是 `opts.lanes`，该行实际是 `out.push({ lane: id, ... })`。
   改成「整段引文是原文子串（最强）或指纹出现在行里」两条都算对上，且放宽指纹到带点标识符后，good-c 回到 sloppy。
5. 中文复述里夹一个字母（`（3 份/片并发，实测 8 份一整块 67.4s≈8s/份）`）被判 mismatch → 加 `codeLike` 门槛：只有像代码的引文才逐字核对。
   再补两条：引文是行号区间（`:61-67`）或文件名（`army-run.mjs:78`）时不可核；引文里没有可检索的 ASCII 标识符时记 weak，不许记 bad。

## 结果（12 份人工标签全部作废）
`atwo blind --manifest eval/blind-manifest.json`（不打 --lane，只算标签）：

```
exact 0 · sloppy 7 · bad 1 · empty 3 · unknown 1
人工标签与客观标签不一致 12/12 —— 7 份标 good 的产物，逐条复核没有一份是干净的：
good-a 4/10 处引文不在所写行 · good-b 4/20 · good-c 4/4 · good-d 10/62 · good-f 8/9 · good-g 9/10 · good-e 引了个仓库里不存在的公式 T_split ≈ S/4 + 11.3 + 1.55f
```

**结论：那批「good」是假的，历史上所有用它算出的误杀率（86%、18.2%）一律作废。**

## 对照组（评估误杀必须有自己的分母）
12 份里 exact = 0，等于无法量误杀。所以新建 `_probe/make-clean-cases.mjs` 造 4 份对照产物：
引文从当前仓库**逐字抄出**（不是编造，是控制组），挑 `export|const|function` 开头的实体行。
`eval/blind-clean.json` + `eval/blind-clean/*.md`。

第一次对照组挑到 import 语句，父审 clean-4 判 REVISE：「两条 import 证明不了实现与任务一致」——
这是**对照组太弱**，不是父审误杀。换成实体定义行后重跑：

```
4 份 exact · 父审 4 份有结论 · 漏判 0 · 误杀 0 · 误杀率 0
```

## 验收线（改了）
旧：`missed<=1 && falseAlarmRate<=0.2`，分母用全部 reviewed。
新三条：① 有缺陷样本 ≥5 ② 本该放行样本 ≥3 ③ 漏判 ≤1 且误杀率 ≤0.2（分母 = exact 份数）。
样本不够一律 `not-enough-cases`，**不许报 meets-bar** —— 上一版在 exact=0 时报过 meets-bar。

## 改动文件
`lib/labelizer.mjs`（新）· `lib/labelizer.mjs` 的 `labelClassOfHand/labelClassOfObjective` 导出 ·
`lib/blind-objective.mjs`（新，明细跟着 manifest 命名，不再固定写 blind-objective.json）·
`test/labelizer.test.mjs`（14 条）· `atwo.mjs`（blind 动词接线）· `lib/cli-spec.mjs`（VERBS 加 blind）·
`eval/blind-clean.json` + `eval/blind-clean/*.md`（对照组）· `_probe/make-clean-cases.mjs`（生成器，gitignored）

## 已知不对称
- 客观标签只核「引用是否真」，核不了「结论是否对」：一份引文全对但推理错的产物会拿 exact。
- `unknown` 不进指标，所以「一处引用都不写」的产物既不加分也不减分 —— 想罚它得另立判据。
- 对照组是我自己造的，只能量「父审会不会打回干净产物」，量不了「父审漏不漏真错」。
