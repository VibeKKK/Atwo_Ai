# 团队工作记忆
> 所有 AI 共用这一份。DSH 写，其他人读。改动走 orchestra.mjs，不要手改。

## 项目
- 名称：Orchestra（AI 协作台）
- 位置：D:\ai project\ai team work
- 用途：DSH 拆任务写提示词 → 派给 Trae / CodeBuddy 执行 → DSH 验收 → 记账

## 当前阶段
- 时间：2026-11-13 00:55
- 状态：v2 可用。两条通道（trae CDP / codebuddy CLI）+ duo 并行派活 + stats 记账 + 共享记忆；与 dsh-lead（rank1）共管 rank3

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
- 时间：2026-11-13 20:09
- 指派给：workbuddy
- 任务：只回复两个字：戊戊
- 耗时：18.6s
- 结果：成功
- 产出长度：2 字符
