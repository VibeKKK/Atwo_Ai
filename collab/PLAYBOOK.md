# AI 开发者视角的管理规程（rank1 / rank2 共用）

> 这份不是教程，是**管理手段**：把 AI 应用的固有问题变成可检查的规则和可执行的命令。
> 依据：[Anthropic《Effective context engineering for AI agents》](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)、
> [Building effective agents](https://www.anthropic.com/research/building-effective-agents)、
> [context rot 研究](https://research.trychroma.com/context-rot)、
> [12-factor agents](https://github.com/humanlayer/12-factor-agents)。
> 所有数字都是本机实测，不是推测。

---

## 0. 一条总原则

**找「最小的高信号 token 集合」，让目标行为最可能发生。**

上下文不是免费白板，是有限注意预算。token 越多，模型对其中任何一条的召回都越差
（context rot）。所以「多塞点信息更保险」这个直觉是错的——它同时稀释了任务本身。

**推论：任何往 prompt 里加东西的动作，都必须回答「它挤掉了什么」。**

---

## 1. 六个分区，各有硬上限

派活的 prompt 由 `lib/prompt.mjs` 组装，分区与预算如下（`node orchestra.mjs ctx "<任务>"` 可实时查看）：

| 分区 | 装什么 | 上限 token | 超了怎么办 |
|---|---|---|---|
| `task` | 任务本体 | 20000 | 拆任务，别塞 |
| `memory` | 团队记忆（`buildContext()` slim） | 1200 | 压 slim，细节留在 STATE.md |
| `project` | 项目接续简报 | 900 | 只留「下一步 / 卡住 / 进行中」 |
| `ephemeral` | 临时能力清单 | 1200 | 只写「有什么、在哪」，正文按需读 |
| `skill` | 技能正文 | 3000 | 截断 + 标记，长文改 `eph add` 按需读 |
| `contract` | 输出契约 | 1400 | 只留字段定义，不留解释 |

实测基线（同一台机）：普通代码任务合计 **317 token**，带项目记忆 **377 token**。
模型侧的真实开销不在这些分区上——codebuddy 每次固定 ~**7,633 token**（CLI 自带 system prompt），
**所以我们的预算管的是「注入质量」而不是「省钱」**。省钱靠 batch（见 §6）。

**规则 R1**：新增任何注入内容，必须先报预算（`ctx` 命令截图），再加进代码。

---

## 2. 提示词要站在「正确高度」

Anthropic 的说法是 *right altitude*——两端都错：

- **太低**：把 if-else 逻辑硬写进 prompt。脆、难维护、换个场景就废。
  - 我们的例子：`ensureFenceHint` 里写死「缩进必须是 4 个空格，不要行号」——这是对 trae 的补丁，
    但它替代不了契约（结构化的 `{code}` 字段）。
- **太高**：只写「帮我写好点」。模型没有共享上下文，只能猜。
  - 我们的例子：早期 `ask trae "评审一下"` 得到一堆泛泛而谈。

**规则 R2**：系统提示写**判断依据**，不写**分支逻辑**。
写「代码任务填 code，散文填 answer，两者都空算失败」——这是契约，可校验；
不要写「如果用户问的是 Python 就……如果是函数就……」——这是把解析器写进自然语言。

---

## 3. 示例 > 穷举

文章原话：示例是「一张图胜过千言」，但**不要罗列所有边缘情况**。

- 做错的：往 prompt 里堆 20 条例外规则。
- 做对的：给 2–3 个**典型完整案例**，让模型自己泛化。

我们已有的落地：`fixtures/` 五个真实样本（gutter 行号、UI 文案污染、单行压平、裸 JSON、围栏代码）
+ `test/selftest.mjs` 31 项断言。这些比在 prompt 里写十行「注意不要……」有用得多。

**规则 R3**：模型出错时，先问「能不能加一条 fixture 复现」，再问「要不要改 prompt」。

---

## 4. 即时检索 > 全文注入

文章的 *just-in-time* 策略：不预先塞全量数据，只维护**轻量引用**（路径、查询、链接），
用工具在需要时取回。这正是 `ephemeral` 的设计前提。

- 做错的：把整个 SKILL.md（5000 字）塞进每次派活。
- 做对的：`eph add skill X` 只登记；真要用时 `--skill X` 才读正文，且截到 3000 字。

**规则 R4**：任何超过 1500 字的内容，默认只注入「一句话 + 路径」，正文按需读。

---

## 5. 工具要少、要清楚、不要重叠

文章点名最常见的失败模式：**工具集膨胀导致模型选错工具**。
「如果人都说不清该用哪个工具，模型更不可能说清。」

我们现在的工具面（应当保持）：
```
ask / auto / pick / batch / eph / ctx / pr / budget / health / doctor / probe / stats
```
每个都有明确的「什么时候用它」。反面教材就在本项目里：名册曾宣称 5 方，
实际只有 3 方可派活（WorkBuddy 只能提供额度，接不上派活通道）——
**虚胖的名册会让模型把活派给空气**。已在 `authority.json` v5 纠正。

**规则 R5**：新增工具前先问「它和现有哪个重叠」；答不上来就不加。

---

## 6. 长任务的三种手段（我们已经在用，只是没起名字）

| 手段 | 原文说法 | 我们的实现 |
|---|---|---|
| 压缩 | compaction：接近上限时总结重开 | 本会话的上下文压缩块 + `memory/STATE.md` |
| 结构化笔记 | structured note-taking：写外部笔记，之后回读 | `project-memory.mjs` / `resume.mjs`（每项目一个 STATE.md） |
| 子代理 | sub-agent：干净上下文干专门活，只回摘要 | Orchestra 本身（trae/codebuddy/workbuddy 各自独立上下文） |

**推论**：不要把 Orchestra 当「多开几个模型」用，它的价值是**隔离上下文**——
每个 agent 在自己的窗口里折腾，只把结论（1000–2000 token）带回主脑。

---

## 7. 成本结构（决定我们怎么分工）

| 项 | 实测 | 含义 |
|---|---|---|
| codebuddy 单次 | in **7,633** tok | 大头是 CLI 自带 system prompt，与任务大小无关 |
| batch 3 项 | in **7,822** tok | 塞 3 个任务进去 ≈ 白赚两个 |
| trae | **0** tok | 走会员积分，不按 token 计费 |
| workbuddy | **0** tok | 走用户积分，约 18–20 秒/次 |
| 缓存命中 | 7.2s → **0.08s** | 同问题第二次不花钱 |

**规则 R6**：小任务先 `batch`（3–6 项一批）；评审类优先给 trae（免费）；
重复问题交给缓存，不要重复付钱。

---

## 8. 我们踩过的五类失败（每类都留了防线）

| 失败模式 | 具体事故 | 现在的防线 |
|---|---|---|
| **拿界面现象猜内部状态** | 会员营销横幅 → 误判「额度耗尽」；`busy` 掉 false → 误判「已完成」；回合数封顶 → 误判「没回答」 | 只看**内容指纹变化** + 稳定窗口；额度只认硬报错；`probe` 先验界面 |
| **契约不严 → 脏数据** | Trae 页面文案混进回答 | 强制 JSON 契约 + 5 级修复链 + 失败重试 + 降级标注 |
| **静默失败** | `if"__name__" == "__main__"` 恒假：编译过、运行过、输出空 | 语法闸 `py_compile`/`node --check` + 冒烟断言 |
| **上下文膨胀** | 缓存键用了拼装后 prompt（含团队记忆，每次都变）→ 永远未命中 | 缓存键改用原始问题；注入分区设上限 |
| **工具/名册虚胖** | 宣称 5 方，1 方没有派活通道 | `authority.json` v5 只列可派活的；doctor 检查 CLI 存在性 |

**规则 R7**：出现新故障时，先归类到这五类里的哪一类，再决定修 prompt 还是修代码。

---

## 9. 分工（管理手段的落点）

| 职责 | rank1（总管 dsh-lead） | rank2（副总管 dsh-work-replace） |
|---|---|---|
| 提示词与契约结构 | **主责** | 提意见 |
| 上下文预算（`lib/prompt.mjs`） | **主责** | — |
| 评估与回归（fixtures / selftest） | **主责** | — |
| 适配器与选择器（`agents/*.mjs`） | 审阅 | **主责** |
| 探针与 doctor / probe | 审阅 | **主责** |
| PR 审阅门 | 掌签 | docs 级可放行 |

**交接规矩**：改 `lib/prompt.mjs` / 契约字段 / `authority.json` 都属于 `protected` 级，
必须走 `pr.mjs` 审阅门，rank1 审、rank2 知情。

---

## 10. 每次派活前的四问（贴在手上）

1. **任务本身写清了吗**？——能不能被机器判定「做完没做完」。
2. **注入了什么**？——`node orchestra.mjs ctx "<任务>"` 看一眼分区表。
3. **要谁干**？——要代码→codebuddy；要评审→trae；要连续对话/中文散文→workbuddy。
4. **失败会长什么样**？——超时 / 契约失败 / 语法未过 / 空回答，四种各有明确报错。

---

_2026-11-13 立。rank1 维护，rank2 可提修订（走 PR）。_
