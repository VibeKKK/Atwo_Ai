# 团队工作记忆
> 所有 AI 共用这一份。DSH 写，其他人读。改动走 orchestra.mjs，不要手改。

## 项目
- 名称：Orchestra（AI 协作台）
- 位置：D:\ai project\ai team work
- 用途：DSH 拆任务写提示词 → 派给 Trae / CodeBuddy 执行 → DSH 验收 → 记账

## 当前阶段
- 时间：2026-11-14 00:35
- 状态：**v3 吞吐版**。三通道（trae CDP / codebuddy CLI / workbuddy CDP）+ duo + batch + **swarm** + top 看板 + stats 记账 + 共享记忆；与 dsh-lead（rank1）共管 rank3
  - **v3 核心：`swarm` 群体派活引擎**（`lib/swarm.mjs`，新增）—— N 个独立任务跨 agent 并行，auto 分配（要代码→codebuddy，散文→trae），失败自动换路重试，批次落 `.swarm/<runId>/` 可 `--resume` 续跑，`--out` 出 markdown 报告
  - **实测提速 2.15–2.47×**（16 个任务 100% 成功）：6 混合任务墙钟 103.3s vs 串行 255.4s；10 散文任务 136.5s vs 293.1s。提速来源是两条流水线同时跑（总耗时≈最慢那一条），不是模型变快
  - **trae 8 回合天花板的正确解法是动态改派**：`ORCH_TRAE_SOFT_LIMIT`（默认 8）超出部分自动转 codebuddy 并打 `⇄` 日志。开新会话这条路已证伪（点新建后会话区读不到文本），不要再去试
  - codebuddy 默认并发 2 → **6**（`ORCH_SLOTS_codebuddy` 可覆盖）
  - 新增 `top [n]` 吞吐看板：每批墙钟 vs 串行、提速比、分配构成；累计节省时间
  - 顺手写了 `README.md`（143 行，原来只有 2 个空行）：三分钟上手 / 分配规则 / 三个 agent 的能力边界与实测耗时 / 成本模型 / 已知限制 / 文件结构
  - `.swarm/` 进 .gitignore
  - 本轮（rank2）修掉 trae 发送侧工程缺陷：`recoverSend` 两级自愈（清空重贴 → 开新对话）+ `--no-autostart`；preflight 假警报改为 `PREFLIGHT_RECHECK_MS` 二次复核（默认 900，可用 `ORCH_PREFLIGHT_RECHECK_MS` 覆盖）
  - `collab.mjs` / `pair.mjs` 身份改为读 `COLLAB_ME`（原来 pair.mjs 硬编码 dsh-lead，rank2 侧发信会签错名、me 会覆盖对方负载条目）
  - doctor 新增 codebuddy 登录态检查（启发式：CLI 无 auth status、凭据在 `~/.codebuddy/local_storage/entry_*.info` 且加密，只能看活跃时间）
  - buddy 签到定为「设计如此」：不在 `REF_PREFIX_TO_PROVIDER` 前缀表，被 `isSupportedProvider` 首步过滤；签到只对 trae 有效，不必再查

## 已确认的事实
- Trae CN 可用 CDP 全自动驱动：启动参数 --remote-debugging-port=9223，Agent 面板 title 为 Agent
- 输入框是 Lexical 编辑器（div.chat-input-v2-input-box-editable，contenteditable=true）
- 写入只能靠派发 ClipboardEvent('paste')，且必须轮询等待 DOM 更新（不能同步读 innerText）
- 清空必须用 CDP 真实键盘：Ctrl+A → Delete（JS 的 execCommand 无效）
- Lexical 把每个段落渲染成 p，innerText 的换行会翻倍，字符串比较要先归一化
- Electron 的 fetch 会走系统代理被 mihomo 拦截，本地 HTTP 一律用 node:http 直连
- CodeBuddy：官方完整版 2.183.0 在 C:\Users\kkk\Tools\codebuddy-cli\package，凭据 ~/.codebuddy/app；内置 lite 版永久弃用（无 TUI 无登录）
- codebuddy --output-format json 输出是数组，要倒序取 type===result 那条；extractJson 已适配
- duo 实测（2026-11-13 00:53，同一道题）：trae 35.9s / 2560 字符（快 4.7 倍，但输出混入页面行号噪声）；codebuddy 167.8s / 2261 字符 / $0（慢，但产出干净：完整函数 + 3 组断言 + module.exports）
- 派活选择规则：快活/试错给 trae，要能直接落盘的干净代码给 codebuddy
- PowerShell 5.1 按 ANSI 读 .ps1，脚本必须全 ASCII；pwsh 不在系统 PATH
- ops_bash 里 COLLAB_ME=dsh-work-replace 前缀可覆盖协同身份
- **DOM 抓取是 trae / workbuddy 的共同病根**：回答区是渲染后的 DOM，`x`→<code>、##→<h2>、**b**→<strong>，innerText 只剩文字、语法字符全丢。trae 掉星号、workbuddy 掉反引号和井号不是两个 bug，是同一个病。给每条通道写字符还原补丁等于永久打地鼠。
- **解法：文件信箱**。让 agent 把产物写进文件，我们读文件 —— 渲染器不在链路上，字节零损伤。实测：trae 14.4s / 豆包 19.8s，反引号 ## ** JSDoc 边界表格竖线全部原样；对比 trae 抓 DOM 23s 掉星号、workbuddy 抓 DOM 343s 全丢。
- 邮箱协议（两条通道一致）：写 `.mailbox/<id>.task.md` → CDP 只发一句含两个绝对路径的短指令（「读完写进 Y，只回复完成」）→ 每 1.5s 轮询 `.result.md` → 非空即返回。
- 工作区（2026-11-14 用户指定）：trae = `D:\code app\ai code\Trae CN\workplace\work one`；豆包 = `D:\ai work replace\doubao place\work test one`（旧的 `doubao\workplace\work one` 已删）。
- **三条 GUI 通道全部信箱化完成（实测）**：trae `askTraeFile` 14.4s / 豆包 `askDoubao` 19.8s / workbuddy `askFile` 23.5–43.6s，反引号 ## ** 表格竖线 JSDoc 边界全部逐字正确。DOM 抓取路线（trae 23s 掉星号、workbuddy 343s 全丢）正式退役，只在「问一句话、不要产物」时用。
- **信箱已接进 swarm 主流程（2026-11-14 实测通过）**：`lib/swarm.mjs` 里 `MAILBOX_AGENTS = {trae, workbuddy, doubao}` + `askViaMailbox()`，`runPool` 用包了一层 `dispatch()`，只要带 `--land` 或 `--verify` 就走文件信箱；只要文字时仍走 DOM（更快、无文件开销）。信箱挂了自动退回原路，不是单点。实测：`dispatchFn` 故意抛「不应该走到这里」没触发 → 信箱确实接管；38.5s，输出含反引号 /**加粗** /## 全保留，`verify.ok=true` 零失败。
- **提案系统缺陷（2026-11-14 发现，未修）**：7 个 open PR 全部 `(无 diff)`，且 `git branch` 里查不到任何 `orch/pr-*` 分支。根因是 `pr.mjs` 的 `finish()` 从未被调用 —— `ORCH_PR=1` 自动 start+finish 依赖派活成功，派活失败（如 codebuddy 退出码 143）就没有收尾，提案永久卡在 `open`。`finish()` 本身有 `status = pr.files.length ? 'ready' : 'empty'` 的保护，但没人调它。修法要动 `pr.mjs`（protected，需 rank1）。
- `reject()` 没有审阅门禁（只有 `approve()` 有），所以清理空提案可以直接 `pr.mjs reject <id> --reason`；`reject` 会切回 main、删分支、标记 rejected。
- 三个适配器现在都有信箱导出：`agents/trae.mjs` 的 `askTraeFile`、`agents/workbuddy.mjs` 的 `askFile`、`agents/doubao.mjs` 的 `askDoubao`（本身就是信箱）。工作区环境变量：`TRAE_WORKSPACE` / `WB_WORKSPACE` / `DB_WORKSPACE`。
- 工作区一览（用户 2026-11-14 指定）：trae `D:\ai work replace\trae place\work test one`；豆包 `D:\ai work replace\doubao place\work test one`；workbuddy `D:\ai work replace\workbuddy place\work test one`；codebuddy 走 CLI 直接落盘，不需要信箱。
- **共享工作区 `D:\ai work replace\TDW place`**（用户 2026-11-14 指定）：三条通道的公共落地目录，跨通道协作或特殊需求时用。三个适配器都支持 `opts.shared = true` 走它，也可用 `opts.workspace` 显式指定任意路径；环境变量 `ORCH_SHARED_WS` 可覆盖。不传 shared 时各自用自己的私有工作区。
- WorkBuddy 5.11.3 只认环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT`，命令行 `--remote-debugging-port` 会被丢弃。
- 豆包客户端 CDP 端口 9225，主聊天页 target 是 `doubao://doubao-chat/chat`，输入框是 `div.tiptap.ProseMirror`（tiptap，不是 Slate），发送用 Input.insertText + Enter(VK 13)。

## 本轮不做（已评估、明确放弃）
- Codex CLI：app-server 拒绝访问 (os error 5) + 无 auth + 三库损坏，性价比低于 Trae
- GitHub Copilot 独立 app / WorkBuddy 桌面版：无稳定外部投递通道
- Ollama：模型目录已空

## 待办（下次开工按顺序）
1. node orchestra.mjs review codebuddy orchestra.mjs —— 让 rank3 反审 26KB 主程序。今晚起过两次都被打断（审长文件 >5 分钟），下次必须后台跑 + 只审单文件
2. 收 dsh-lead 回信：我 00:51 投了「分工软件升级与接口对齐」，请它自己跑 stats 与 duo 验证跨工作区记账
3. auto-checkin.json 的 lastDate 还停在 2026-11-10（落后两天），需与 dsh-lead 确认谁补签，避免重复领
4. 若 CodeBuddy 登录态过期：起 node bin/codebuddy --serve --port 63910 --auth none 后浏览器点「国内站点登录」

## 最近一次派活
- 时间：2026-11-15 11:35
- 指派给：doubao
- 任务：只回复两个字：收到
- 耗时：260.0s
- 结果：失败 — doubao 超时 260s
- 产出长度：0 字符
