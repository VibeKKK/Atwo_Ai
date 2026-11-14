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
- 时间：2026-11-14 21:57
- 指派给：codebuddy
- 任务：你在改一个 Node.js 项目（零依赖，ESM）。目录：D:\ai project\ai team work 任务：新增 test/store_history.mjs（纯 node:assert，不要第三方包）。用 lib/store.m
- 耗时：240.0s
- 结果：失败 — codebuddy 超时 240s
- 产出长度：0 字符
