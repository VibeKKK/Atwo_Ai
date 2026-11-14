# orchestra

> 项目记忆。AI 开工先读这一份，不用人复述背景。
> 改法：`node resume.mjs done|next|block|add|note <项目> "<内容>"`

## 目标
DSH 与其他 AI 之间的派活/互审/共享记忆通道

## 进度
- [ ] 按 Trae 评审修 askTrae 的 before/addedText/超时/开始判定
- [ ] CodeBuddy 接入（本机未安装）
- [ ] 每日检查 channel-pack/auto-checkin.json 的 lastDate 是否为当天（3 天没记录，buddy 渠道也无记录）
- [ ] DSH 插件已装（junction + cordis.patch.yml），重启 DSH 后出现 orchestra_ask/pick/status 三个工具，重启后要实测一次

## 下一步
- 把 runPool 的 catch 也加上磁盘产物抢救（昨晚 workbuddy 写盘成功却被记失败，swarm 路径漏治）

## 已确认的事实
- 建立于 2026-11-13 00:20

## 流水
- 2026-11-13 00:20  建立项目记忆
- 2026-11-13 00:22  项目记忆接续功能上线：lib/project-memory.mjs + resume.mjs
- 2026-11-13 00:35  与 dsh work replace 上膛协同，投第一封；用户令：等对方做完再动
- 2026-11-13 10:41  Orchestra 效率实测完成：trae 9.8s/丢换行、codebuddy 13.7s/代码可直接用；trae 起不来的真因是 ELECTRON_RUN_AS_NODE=1 继承。详见 SHARED.md §10
- 2026-11-13 13:34  trae 适配层优化完成并验证：自动拉起+清ELECTRON_RUN_AS_NODE+保留换行+清代码壳；实测 top_lnk 19行缩进完整、py_compile通过、结果与真值一致。见 SHARED.md §11
- 2026-11-13 15:16  dsh-orchestra 插件 v0.1.0 @ C:/Users/kkk/.dsh/plugins-src/dsh-orchestra：假 ctx 验证 8/8 通过（含真实派活 21s），YAML patch 解析 24 条命中；待重启生效
- 2026-11-13 15:20  trae 误判额度已修（营销横幅 + busy 判据双错），五条链路复测全过
- 2026-11-13 18:20  A/B/C①② 落地：preflight 0.4s 报错、语法闸、codebuddy -67% token、缓存 7.2s→0.08s
- 2026-11-13 20:09  WorkBuddy 通道打通：环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT 开 CDP（命令行 flag 无效）；Host 头、Slate 编辑器、aria-label=发送 三个坑已解；已接入 orchestra 为第三通道
- 2026-11-13 21:09  评测集已建成：24 任务/判据自检 9-9/codebuddy 3-3=100%。trae 今日因 Trae 自身更新（对话区类名换成 solo-lite-chat-panel + message-list-cache-item，发送后停在任务列表且点任务项不跳转）0-3；已修好输入（CDP Input.insertText 替代合成 paste）与回车（keyDown+keyUp + 重聚焦）。
- 2026-11-14 00:02  rank2 侧这轮落地（均 node --check + 实测）：collab.mjs 身份视角按 COLLAB_ME 过滤 peers 并标漂移；lib/preflight.mjs 加 PREFLIGHT_RECHECK_MS(默认900) 二次复核；agents/trae.mjs 加 recoverSend 两级自愈（清空重贴→开新对话）+ --no-autostart/ORCH_TRAE_NO_AUTOSTART；orchestra.mjs doctor 加 codebuddy 登录态启发式；pair.mjs 身份从硬编码 dsh-lead 改为 COLLAB_ME。buddy 签到根因：不在 REF_PREFIX_TO_PROVIDER 前缀表，被 isSupportedProvider 首步过滤，设计如此，签到只对 trae 有效。trae 失败结构：124 次失败 37(30%)，其中工程缺陷约 22（回车没发出 10 / 体检假警报 4 / 45s 无回合 8）、模型判据未过约 17。
- 2026-11-15 01:58  夜间(11-15)：修 ask KNOWN 缺 doubao；dispatch 加超时抢救(按磁盘产物改判)；新建 lib/apispec.mjs 产物接口契约并接入 verify/swarm；test 7/7 + 真实产物端到端 4/4；报告 runs/night-20261115/REPORT.md
