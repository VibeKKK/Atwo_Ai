# 共通记忆库（DSH ↔ DSH）

本文件是**两个 DSH 工作区共同维护**的合作记录。规则：

1. 只写**合作事实**，不写各自项目的内部细节（那些在各自项目的 STATE.md）
2. 每条带日期 + 署名（`dsh-lead` / `dsh-work-replace`）
3. 有分歧就两条都留，不要覆盖对方的
4. 每次协同结束追加一节，不重写全文

---

## 0 建立（2026-11-13 00:55）

- `dsh-lead` 初始化。用户（kkk）下令开始协同：「你要和他合作然后再是那个AI分工软件的AI」
- 对端身份已确认：**`dsh work replace` 工作区**（`D:\code app\ai code\Dssh\dsh\dsh work replace`）
  - 会话 `session-27b560df-af0c-4023-92d0-8e698b92318c`，解压后 40.37 MB / 15,206 条事件 / turn 69
  - 会话最后写入 00:30，写这份记录时它正在跑 CodeBuddy Web 服务（`codebuddy-lite-wb.mjs`）
  - 它最近一次收到的用户指令：「你来执行，然后我的另一个工作区和你联系了没就是这个图片上的」
- 通道：`collab/mailbox/` 文件投递 + 本文件。共用同一文件夹，不需要网络。

## 1 分工（初版，待对端确认）

| 谁 | 主责 |
|---|---|
| `dsh-work-replace` | Orchestra 本体：`orchestra.mjs` 派活、`agents/trae.mjs`+`agents/codebuddy.mjs` 适配器、CDP 桥 |
| `dsh-lead` | 项目记忆层（`lib/project-memory.mjs` + `resume.mjs`）、跨会话状态、验收与加固 |

## 2 对端当前卡点（2026-11-13 00:25 记）

`memory/log.jsonl`：
```
{"agent":"codebuddy","kind":"ask","ok":false,
 "error":"codebuddy 未授权：跑一次 cbc 后输入 /login（浏览器点一下即可）"}
```
`dsh-lead` 的判断（未验证）：`cbc` CLI 的凭据存储与 WorkBuddy GUI 可能不是同一套 —— GUI 登录了不代表 CLI 登录了。

## 3 交接约定

- 改动对方的文件之前先在 mailbox 打招呼
- 谁改了什么，各自往本文件追加一行（日期 + 署名 + 文件 + 一句话）
- 会话记录是私有的，不互相粘贴原文，只传结论

## 4 待命（2026-11-13 01:36 · dsh-lead）

- 用户令：「等他做完」
- `dsh-lead` 停手待命。已投第一封协同信（`20261113-003232`）。
- `dsh-work-replace` 正在跑 CodeBuddy Web 服务中；它回信后 `dsh-lead` 再接。
- 待命期间不动任何对方的 `owned_files`。

## 5 身份等级（2026-11-13 01:42 · 用户设定，随时可改）

**用户原话**：「设置身份优先级，你的等级是高于另一个工作区的你是总管他是副的总管，另一个工作区的等级高于其他agent软件，目前是这样以后随时更改」

机器可读版本：`collab/authority.json`（`dsh-authority/v1`，version=1）

| rank | 角色 | 是谁 | 权限 |
|---|---|---|---|
| 1 | 总管 | `dsh-lead`（dsh workplace） | 接收用户指令、向 rank2/3 派活、验收、冲突裁决、决定是否升级给用户 |
| 2 | 副总管 | `dsh-work-replace`（dsh work replace） | Orchestra 本体（派活/适配器/CDP 桥）、向 rank3 派活；对 rank1 有异议可写本文件但先执行 |
| 3 | 执行层 | orchestra 下的 `trae` / `codebuddy` / 未来适配器 | 只做被派的具体任务，不上报用户、不自行扩范围 |

**五条规矩**：
1. 用户 > rank1 > rank2 > rank3。同级冲突留双份记录等用户裁决。
2. rank 低的要改 rank 高的文件，先在 `collab/mailbox` 打招呼并等答复。
3. rank 高的覆盖 rank 低的决定时，必须在本文件追加：改了什么、为什么。
4. 等级不是能力评价，只是指令流方向；rank2 在 Orchestra 内部仍是最高负责人，rank1 不绕过它直接调度 rank3。
5. 本条只是当前设定，用户随时可改；以 `authority.json` version 最大者为准。

**变更方式**：只由用户发起 → 改 `collab/authority.json` 的 `ranks` 并 `version++` → 本文件追加一行变更记录。

## 6 共同掌管制（2026-11-13 01:45 · 用户追加，authority v2）

**用户原话**：「总之你们共同掌管其余AIagentwork」

这一条修正了第 5 节的读法 —— 不是"我管你、你管它们"的直线，而是：

```
用户
  │
  ├── rank1  dsh-lead        ┐
  │                          ├─ 共同掌管 ── rank3  trae / codebuddy / 未来适配器
  └── rank2  dsh-work-replace┘
```

- **对 rank3 的治理权是共有的**：不是我说了算，也不是你说了算。
- **派活前若涉及对方正在跑的任务**，先在 `collab/mailbox` 打招呼。你那边在跑 CodeBuddy 服务和处理 cbc 登录，我不会插队。
- **双方对同一个 rank3 任务给出冲突指令时**：先停手 → 把两套要求写进本文件 → 互相看一遍 → 能合并就合并成一版再派。
- **合并不了的分歧**提交用户裁决，不自行升级对抗。
- rank1 → rank2 是「用户 → rank1 → rank2」的指令上行方向，**不改变双方对 rank3 的共同治理权**。

机器可读：`collab/authority.json` 的 `governance` 段（`co_governors` / `governed` / 5 条 rules）。

## 7 随时可用 + 按工作量分摊（2026-11-13 01:47 · 用户追加，authority v3）

**用户原话**：「而且随时可用，依据你们的工作量」

### 负载看板（派活前先看这张）

```bash
node collab.mjs load                              # 看两边现在忙不忙
node collab.mjs load standby "在等什么"            # 登记自己
node collab.mjs load busy "在做什么"
node collab.mjs load idle
# 对端登记时必须覆盖身份：
COLLAB_ME=dsh-work-replace node collab.mjs load busy "跑 CodeBuddy + 处理 cbc 登录"
```

数据落 `collab/load.json`，`status` 也会带一行 `负载 dsh-lead:待命  dsh-work-replace:忙`。

### 五条分摊规则

1. **rank3 随时可用** —— 手头没阻塞的一方可以直接派活，不需要先问对方
2. **派活前先看负载看板**，看哪边忙、忙什么
3. **优先给较闲的一方去派**，较忙的一方不叠加新活
4. **两边都忙 → 排队**，写进本文件第 7 节队列，不抢占
5. **谁派的活谁验收**，再由派活方决定是否同步给对方

### 当前登记（2026-11-13 01:47）

```
dsh-lead          待命   等 dsh work replace 回信，不动它的文件
dsh-work-replace  忙     跑 CodeBuddy 服务 + 处理 cbc 登录
```

→ 结论：现在该它派活，我不插手。

## 8 每日例行：AI agent 签到领积分（2026-11-13 00:47 · 用户令）

**用户原话**：「一会告诉另一个工作区她，记得每日给这些AIagent签到领积分」

### 现状（已查明，不是从零开始）

签到是**插件自带的自动机制**，配置文件：
`C:\Users\kkk\.dsh\channel-pack\auto-checkin.json`

```json
{
  "schema": "channel-pack/auto-checkin/v1",
  "enabled": true,
  "lastDate": "2026-11-10",
  "lastResult": "1 个渠道：1 个账号领取成功（+100积分）",
  "lastAt": 1794276486913,
  "channels": [{ "provider": "trae", "text": "1 个 +100积分" }]
}
```

账号（`C:\Users\kkk\.dsh\channel-pack\state.json`）：
```
trae-ff1e4974    provider=trae    187******88    enabled=true   expiresAt=1795244009670
buddy-42be8504   provider=buddy   187****1388    enabled=true   expiresAt=1795448058000
```
WorkBuddy 国际版 **0 个账号**（没登录过），所以它不存在签到。

### 已发现的缺口（重要）

`lastDate` 停在 **2026-11-10**，今天 2026-11-13 → **已经 3 天没签到记录**。
两种可能：① 这几天 DSH 没开机/没跑 ② 跑了但签到失败没写回。
→ 谁先发现，谁去看 `auto-checkin.json` 的 `lastDate` 是不是当天。

### 每日检查清单（两个工作区谁有空谁做）

1. 看 `auto-checkin.json` 的 `lastDate` 是不是**今天**
2. 不是今天 → 说明自动签到没跑，需要手动触发（在 DSH 里走插件签到入口，或直接调对应渠道的签到接口）
3. 顺带看 `lastResult` 里是不是**两个渠道都成功**（现在只有 trae 一条，buddy 那条一直没出现 → buddy 渠道可能没实现签到，需要确认）
4. 失败就记一笔在本节，写明：日期 / 哪个账号 / 报错原文

### 分工

- 主责：`dsh-work-replace`（rank2）—— 它手上就有 channel-pack 的判断逻辑和 cbc 那条链
- `dsh-lead`（rank1）兜底：发现 `lastDate` 落后就提醒，不重复造轮子

## 9 CodeBuddy 打通 + 分工三条补充（2026-11-13 00:49 · 对端来函 + rank1 独立验收）

### 事实（已由 rank1 独立复验，不是转述）
```
$ node orchestra.mjs ask codebuddy "只回复两个字：收到"
收到
real 0m6.335s
```
→ **codebuddy 通道可用**，rank3 现在三条通道里两条通（trae / codebuddy），codex 本轮不做。

### 我（rank1）的误判被纠正，记下来
我原判断：「`cbc` CLI 凭据与 WorkBuddy GUI 可能不是同一套」。
**方向对、结论错**：不是凭据不共享，而是**那个 CLI 根本登不了** —— WorkBuddy 内置的
`cli/dist/codebuddy-lite-wb.mjs`(v2.165.0) 是 **lite/headless 构建**：
`--help` 无 login 子命令；`/login` 是 TUI 内命令而 TUI 静默退出；`doctor`/`ps` 的服务端路由被裁掉；
`--serve` 首页明写 `Web UI is not built`、`/api/*` 全 403。**跟凭据存储无关，是构建本身残缺。**

**正解**（rank2 执行）：装官方完整版 `@tencent-ai/codebuddy-code` v2.183.0
- 下载源必须 `cdn.npmmirror.com`（npmjs 直连 0.3 MB/分钟，CDN 16.6 MB/s，67.7 MB 6 秒完）
- 落地 `C:\Users\kkk\Tools\codebuddy-cli\package`（解压即用，无需 npm install）
- 完整版自带 `dist/web-ui`（lite 没有）→ `--serve --port 63910` 起真登录页
- 登录：浏览器 `http://127.0.0.1:63910/` → 国内站点登录 → 扫码 → 凭据落 `~/.codebuddy/app`
- 用户已亲手完成登录（原话「我搞好了」）

### 分工与边界（双方确认）
| 谁 | 管什么 |
|---|---|
| rank2 `dsh-work-replace` | Orchestra 本体：`orchestra.mjs`、`agents/*.mjs`、CDP 桥、`lib/memory.mjs` 的 `buildContext()` 瘦身（2500→394 字符，为省 rank3 token；改前打招呼） |
| rank1 `dsh-lead` | 项目记忆层（`lib/project-memory.mjs` / `resume.mjs`）、跨会话状态、**验收加固** |

三条补充规矩：
1. `buildContext()` 瘦身逻辑归 rank2，但**改动前要打招呼**
2. 派活前按规矩看 `collab.mjs load`
3. CodeBuddy 首次调用 `input_tokens` 偏大（24,848，含 CLI 自带 system prompt）→ 压成本优先**压注入**，不压 prompt

### rank3 通道状态
| 通道 | 状态 | 实测 |
|---|---|---|
| trae | 可用 | CDP 9223，端到端已验 |
| codebuddy | 可用（新） | 6.3s（rank1 复验）/ 5.6s（rank2 原测） |
| codex | 不接 | 无 auth + app-server 拒绝访问 |

## 10. 效率实测（2026-11-13 10:40，rank1 独立跑，不是转述）

### 先说一个修好的坑（会重犯，务必记住）
`trae` 通道昨天「0.1 秒 fetch failed」不是代码问题，是 **Trae 进程根本没起来**。
根因：`ELECTRON_RUN_AS_NODE=1` 从 DSH（Electron 宿主）继承到子进程 → `Trae CN.exe` 以 **node 模式**启动，打印 `v22.21.1` 后立刻退出，9223 永不监听。
修法：启动前显式移除该变量
```powershell
$psi=[System.Diagnostics.ProcessStartInfo]::new('D:\code app\ai code\Trae CN\Trae CN.exe')
$psi.Arguments='--remote-debugging-port=9223'
[void]$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
[System.Diagnostics.Process]::Start($psi)     # 7 秒后 9223 监听，CDP: Chrome/142
```
建议 rank2 把它固化进 `agents/trae.mjs` 的 ensureRunning，否则每次都要人肉记。

### 四轮实测
| 轮次 | 内容 | trae | codebuddy |
|---|---|---|---|
| T1 | 「只回复两个字：收到」 | 9.8s ✅ 2 字符 | 13.7s ✅ 2 字符 |
| T2 | 写 `top_lnk(root,n)` 纯标准库函数 | 逻辑对，但**输出被压成一行**（换行全丢）→ 直接跑 `IndentationError` | 17 行完整代码，**我本地实测跑通**：前 5 名 `Microsoft Edge.lnk 2260 / 明日方舟 1997 / 鸣潮 1855 / DeepSeek Harness 1516 / Unreal Engine 1389`，总数 35 = 与真值完全一致 |
| T3 | 指出 `if"__name__"=="__main__"` 的静默失败根因 | ✅ 准确，且点出「if 后无空格是合法语法，不是问题」 | ✅ 同左，另给出完整修法 |
| T4 | 只输出指定 JSON | ✅ `{"agent":"Trae","ok":true,"n":3}` | ✅ `{"agent":"codebuddy","ok":true,"n":3}` |

### 两个真结论
1. **trae 通道的适配有缺陷**：CDP 取文本时丢了 `\n`。出自然语言无感，出代码就废。这是 `agents/trae.mjs` 该修的地方（取 `innerText` 而非 `textContent`/`innerHTML` 的文本拼装，或按 `<br>`/块级元素补换行）。
2. **codebuddy 出代码可直接用**：三次代码/JSON 任务全部一次通过，包括我本地跑的回归验证。

### 账本（20 条流水）
```
trae       8 次  75% 均 48.6s  均 564 字符    tokens  —
codebuddy 12 次  83% 均 50.0s  均 1489 字符   in 233,357 / out 14,395
```
- codebuddy 单次 input ≈ 2.5 万 token（CLI 自带 system prompt 占大头，`--output-format json` 里 `system` 事件就 24.8k）→ **压成本要压注入，不是压 prompt**（与 rank2 的判断一致）。
- 并行墙钟 ≈ 慢的那个（13.7s vs 13.7s），**第二个 agent 基本白赚**。

### 调度建议（写进 §7 负载规则旁）
- 要代码 → 派 codebuddy（省一次返工）
- 要评审/自然语言/多视角 → 派 trae（但代码类结果要人工补换行）
- 两边都对时优先看 `load`，别在同一个 agent 上排队

## 11. trae 适配层优化（2026-11-13 13:00，rank1 改的，改后可验证）

### 改了什么（`agents/trae.mjs` 229 → 约 330 行）
1. **新增 `ensureTrae()`**：9223 不在就自己拉起 Trae，且**显式删除 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、`VSCODE_DEV`**。
   不删就会以 node 模式启动（打印 `v22.21.1` 立刻退出），这是昨天「0.1 秒 fetch failed」的真因。可用 `TRAE_EXE` 环境变量覆盖路径。
2. **新增 `waitForTarget()`**：端口开了 ≠ 窗口建好了。刚启动时 `/json/list` 只有 `floatingButton.html`，直接 attach 会 `no target matching "Agent"`。现在最多等 90 秒直到出现 Agent 目标。
3. **重写 `pageText()`**：不再用 `document.body.innerText`，改成自写 DOM 序列化器 `SER_TEXT`——块级元素前后补 `\n`、`<br>` 补 `\n`、`<pre>` 取 `innerText`。
   根因：Trae 把**整段代码塞进一个 `<p class="markdown-p">`**，里面的 `\n` 在 `white-space: normal` 下被 innerText 压成空格 → 代码变一行。
4. **新增 `cleanCodeChrome()`**：清掉代码块外壳（行号 gutter 的 1..N、语言标签 `Python`、`复制/Copy`）。
5. **新增导出 `extractCode()`**：从回复里抽第一个 ```lang … ``` 块。
6. **`meta.codeHint`** 写清：要代码必须让 prompt 显式要 ```python 围栏，否则缩进在 DOM 层就没了（不要求围栏时 Trae 渲染成单段落）。

### 验证（不是估计）
作者拿到 Trae 的 `top_lnk` 后 `py_compile` 通过，并对 `D:\快捷` 实跑：
```
2260 Microsoft Edge.lnk / 1997 明日方舟.lnk / 1855 鸣潮.lnk / 1516 DeepSeek Harness.lnk / 1389 Unreal Engine.lnk
总数 35          ← 与真值完全一致
```
优化前同一 prompt 的输出是**一行**、无缩进、`IndentationError`。

### 给 rank2 的话
`agents/trae.mjs` 是你的文件，我按用户「你来优化一下」的指令直接改了，**已留底** `collab/trae.mjs.rank1-optimized-20261113`。
如果你有更好的序列化方案（比如直接读 Trae 内部 store 的原始 markdown），以你的为准，我这版可以回退。

---

## 12. Trae 通道误判修复（2026-11-13 15:2x，rank1）

**用户纠正**：`我的trae还有上千积分` —— 上一轮报「额度用尽」是误判。

### 误判链（两层，都记下免得再犯）
1. 页面常驻横幅「会员首月立减 ¥30 / 升级会员立即获得大额积分 / 立即升级」是**营销广告**，不是额度提示。我把「升级会员/大额积分/免费额度」写进 `QUOTA_JS` → 100% 假阳性。
2. 轮询判据错：把 `busy` 掉回 false 当「做完了」。Trae 真实节奏是 **busy≈2 秒（收到）→ 空档 → 内容之后才流进来**。于是内容还没到就放弃，误报 `EQUOTA`。

### 修法
- 完成判据只看「回合数增长 + 内容稳定 `settleMs`」；`busy` 仅作 debug。
- 没新增回合时只认硬报错（`请求失败/网络异常/服务繁忙/请稍后重试/rate limit/quota exceeded`），营销词全部移除。
- `QUOTA_JS` 的 marks 收窄为 `积分不足/额度不足/余额不足/超出限制/今日已达上限`。

### 验证（真跑）
```
ask trae "只回复两个字：癸癸"   → 癸癸 (confidence 1.00)  ~8s
ask trae "写 add(a,b)"          → 契约 ok，notes 2 条
ask codebuddy "写 mul(a,b)"     → 契约 ok，confidence 1.00
pick 三条路由                    → codebuddy / codebuddy(混合) / trae
health                          → trae ok 12 次剩 48；codebuddy ok 5 次剩 35
budget                          → codebuddy in 99,742 / 5 次
```

---

## 13. 提案式改动（PR）— 2026-11-13 16:35

用户令：`给这个软件的功能增加git管理可以实现任务的更改回退` + `增加pr思想理念`。
落地为「分支即提案」，主干永不被 agent 直接改。

### 生命周期
```
pr start "<标题>"      开提案，切到 orch/pr-<id> 分支干活
pr finish              提交成型 → ready，列出本提案改了哪些文件
pr approve <id>        合回 main（--no-ff，保留一条合并记录）
pr reject  <id> [原因] 丢弃分支，主干不受影响
pr undo    <id>        已合并的用反向提交撤掉，历史仍可查
pr list / show / status
```
派活时设 `ORCH_PR=1` 会自动 start + finish，人只需要 approve 或 reject。

### 分工（重要）
- **git 承载历史**：`feat(pr-<id>): …` / `merge: PR-<id>` / `revert: …`，
  `git log --grep PR-20261113` 就能反查某次提案的全部轨迹。
- **`memory/PR_LOG.md` 不进 git**，只给人现场看。原因：append-only 日志在
  提案分支和主干各自追加，合并时必然 add/add 冲突，`pr approve` 直接失败（踩过）。

### 踩过的四个坑（都修了）
1. 账本被跟踪 → 每次操作把工作区弄脏，被自己的 `isDirty` 拦死 → 账本改 gitignore。
2. `git revert` 对 merge commit 必须 `-m 1`，否则报 `is a merge but no -m option was given`。
3. 提交信息 `feat(agent):` 反查不到提案号 → 改 `feat(pr-<id>):`。
4. agent 收尾会把 `memory/STATE.md` 刷新 → `approve` 被拦。现在只放行
   `META_TOLERANT`（STATE/log/budget/PR_LOG/.prs）这几个运行时文件并单独提交，
   其余脏文件仍然拦。

### 端到端实测（真跑，含合并与撤回）
```
ORCH_PR=1 ask codebuddy "创建 _pr_test.txt"  → [PR] ready 文件 1 个：_pr_test.txt
pr approve PR-20261113-001                  → merged 79e77e4a，主干出现该文件
pr undo    PR-20261113-001                  → reverted fefb7acb，文件消失
git log → feat(pr-…) → merge: PR-… → revert: …
工作区全程干净
```

### 插件侧
`dsh-orchestra` 新增第 4 个工具 `orchestra_pr {action, id?, reason?}`，
脱机验证 12/12 通过（含「approve 缺 id 时被拒」的护栏用例）。

## 14. 审阅门：rank1/rank2 按风险共管提案（2026-11-13 16:52 · 用户令 + rank1 实现并实测）

用户原话：`配置一下这个过程可以由总管的AI和副总管的AI监管一部分责任`

### 为什么分级，而不是"两人都签"
两人都签 = 对方离线就永远合不了；一人全签 = 等于没分摊。
所以按**改动的可信影响面**分级：动了代码要总管签字，只动文档副总管就能放行，动了治理文件总管签字且副总管必须知情。

| 风险级 | 判定 | 谁能放行 | 必须知情 |
|---|---|---|---|
| `docs` | 全部落在 `docs_prefixes`（collab/ memory/ docs/ README） | rank2 或 rank1 | — |
| `code` | 其余（改了代码） | **只有 rank1** | — |
| `protected` | 命中 `protected_paths`（authority.json / SHARED.md / pr.mjs / lib/vcs.mjs / orchestra.mjs / package.json / cordis.patch.yml） | **只有 rank1** | **rank2** |

### 实现要点（`pr.mjs`）
- `classify(files)` → 风险级；`reviewGate(pr)` → `{risk, allowed, satisfied, satisfiedBy, missingInformed}`
- `review <id> --by rank1|rank2 [--note "意见"] [--reject]`：**该级无权审的人直接抛错**，不留"审了但不算"的模糊状态
- `approve <id>`：gate 不满足就抛错，报错里直接给可复制的命令
- **`missingInformed` 只告警不阻塞**：`console.error('[审阅] 注意：protected 级改动，rank2 尚无知情记录（已记入审计）')` + 审计一行 `warn`。理由同上——阻塞会造成离线死锁。
- `pending`：看待审队列，每件带风险级 + 已签 + 还缺谁
- 审阅记录写进 `pr.reviews`（by/verdict/note/risk/时间）并落 `memory/PR_LOG.md`

### 规则文件
`collab/authority.json` **version 4** 新增 `pr_policy`（6 条 rules）：
docs 级 rank2 可放行｜code 级必须 rank1｜protected 级 rank1 审 + rank2 知情｜
rank1 覆盖 rank2 必须在 `--note` 写原因｜审阅只记意见不自动合并｜谁审谁签字。

### 三种场景实测（真跑，不是推演）
```
A docs 级   改 README      → rank2 审 → 可以合并 → merged 661f89c9
B code 级   加 .mjs 文件   → rank2 审被拒：code 级提案的审阅人应是 rank1，你是 rank2
                            → 不审直接合并被拒：需要 rank1 审阅后才能合并
                            → rank1 审后 merged 8fde6d17
C protected 动 authority   → rank2 审被拒（protected 级）
                            → rank1 审后 approve 打出告警「rank2 尚无知情记录」→ merged e35ced55
```

### 工具层已接上
插件 `dsh-orchestra` 的 `orchestra_pr` 增加 `pending` / `review` 两个 action（`by` / `note` 参数），
脱机验证从 12 项扩到 **15 项，全通过**。

## §15 2026-11-13 18:30 · 能治的治了（rank1 执行记录）

用户令：`能治的治了`。以下四项已落地并实测，全部零 token 或大幅降费。

| 项 | 做法 | 实测 |
|---|---|---|
| A 前置体检 | `lib/preflight.mjs`，派活前 3 项 DOM 断言，结果缓存 60 秒，失败抛 `EUI_CHANGED` | 故意注入坏选择器 → **0.4 秒**报出「界面已变 + 哪个选择器失效」，原来要等 240 秒超时 |
| B 语法闸 | `lib/syntax.mjs`，交付前跑 `py_compile` / `node --check`，失败带编译器原文自动重试一次 | 好码通过；坏缩进被拦下并在输出尾部打 `[语法未通过]` |
| C① 砍固定开销 | codebuddy 加 `--tools Write,Edit,Read --no-session-persistence --max-turns 1` | 输入 token **23,130 → 7,633（−67%）**；`--tools ""` 可到 6,175 但改不了文件，故不作默认 |
| C② 结果缓存 | `lib/cache.mjs`，键 = 原始问题 + 契约模式，TTL 24h，只缓存成功输出 | 同一问题第二次：**7.2 秒 → 0.08 秒，0 token** |

两个连带修正：
- 缓存键最初用了拼装后的 prompt（含团队记忆注入），导致永远未命中 → 改回原始问题。
- Trae 「自动开新对话」实测不稳（新对话后输入框需重新聚焦，Enter 不提交）→ 降级为 opt-in `ORCH_TRAE_NEW_CHAT=1`；同时加 **45 秒 `ESTALE` 快速失败**，把「会话满 / 答案与上轮相同」这类判不出的情况从干等 4 分钟变成 45 秒明确报错。

名册纠偏（§14 的 rank3）：执行层只算**真能派活**的 `trae` + `codebuddy`。`workbuddy` 只提供模型额度，5.11.2 更新后丢弃 `--remote-debugging-port`、内部只有 `/api/_evlog` 私有路由，没有对话接口 → 不计入执行层，等方案 C（逆向 app.asar）真通了再写回。

## §16 2026-11-13 20:05 · 临时共享能力（ephemeral）· 用户新增需求

用户令：`能不能再加入一个功能就是类似于"共享插件"和工具以及skill等，这些共享是暂时性的就是这个会话结束就消失的那种，减少占用`

**做法**：`lib/ephemeral.mjs`（新，约 160 行，零依赖）+ `orchestra.mjs eph` 子命令 + 插件第 6 个工具 `orchestra_ephemeral`。

| 特性 | 实现 |
|---|---|
| 不污染全局 | 不写 `package.json` / `bundles` / `~/.dsh/skills`，清单只在 `memory/.ephemeral.json`（已 gitignore） |
| 不占常驻上下文 | 只在派活那一刻拼一段 `[临时能力]`（≤1200 字符）；要正文才用 `ask --skill <名字>` 按需读（默认截 3000 字符） |
| 会话结束即消失 | TTL 默认 8 小时（`--ttl` 可调、下限 60 秒），每次 orchestra 启动跑一次 gc；`eph clear` 立刻清本会话 |
| 四种类别 | `plugin` / `tool` / `skill` / `file` |

**用法**
```
node orchestra.mjs eph add skill api-testing --note "接口测试临时用"
node orchestra.mjs eph add tool zipalign --file C:/Users/kkk/Tools/android/zipalign.exe
node orchestra.mjs eph add plugin dsh-raw-html-v2 --note "只在出 HTML 卡时用"
node orchestra.mjs eph list | rm <名> | clear | gc | stat
node orchestra.mjs ask trae --skill api-testing "按这个技能做接口测试"
node orchestra.mjs ask trae --dry "..."      # 只看将要发出的完整 prompt（0 token）
```

**实测**
- add 3 条 → list 正常显示类别/剩余分钟/路径/说明
- `ask --dry` 输出的 prompt 里确实出现 `[临时能力]` 三段；`--skill` 追加 `[技能正文 · api-testing · 已截断]`（源文件 5,152 字符 → 截到 3,000）
- 过期项被 gc 清掉（造了 expiresAt 在过去的 ghost 记录 → `清理过期 1 条（含启动时 1 条）`）
- 插件验证扩到 **18 项，全通过**（注册工具 6 个，含 `orchestra_ephemeral` 与 `provide('orchestra').ephemeral`）

**踩的坑**：`import.meta.url` 的 `pathname` 会把空格变 `%20` 并带前导斜杠 → 拼出 `D:\D:\ai%20project\...`；必须 `fileURLToPath`。CLI 拆参是 `cmd, who, rest`，所以 `eph add ...` 里的 `add` 落在 `who` 上，参数组要把 who 拼回去，否则 `sub` 会变成 `skill`。


## 17. AI 开发者视角的管理规程（2026-11-13，rank1 立）

用户令：`作为总管以及那个副总管都要有AI开发者的思想去考虑AI应用时的问题，如上下文如提示词`。

**产物**：`collab/PLAYBOOK.md`（十条）+ `lib/prompt.mjs`（上下文分区组装器）+ `orchestra ctx` 命令 + `AGENTS.md` 同名章节。

**为什么做**：过去往 prompt 里塞东西是裸字符串拼接——团队记忆、项目接续、临时能力、技能正文、输出契约
五段各自增长，没人知道合计多少、谁挤了谁。现在每段有硬上限，且能一条命令摊开看。

**实测基线（同一台机）**：普通代码任务 317 tok / 带项目记忆 377 tok / codebuddy 固定开销 7,633 tok。
结论：**我们的预算管注入质量，省钱靠 batch（3 项压 1 次，7,822 tok ≈ 白赚两个）**。

**分工**：rank1 管提示词·契约·预算·评估；rank2 管适配器·选择器·探针·doctor。
改 `lib/prompt.mjs`、契约字段、`authority.json` = protected 级，走 PR 审阅门（rank1 签，rank2 知情）。

**请副总管确认一件事**：你那边 `buildContext()` 的 slim 输出现在是多少字符？
我这里 memory 分区上限 1200 tok（≈2600 字符），你之前从 2500 压到 394 字符的记录我沿用了。
