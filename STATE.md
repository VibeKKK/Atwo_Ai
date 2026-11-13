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
- 等 dsh work replace 回信（协同第一封 00:32 已投，用户令：等他做完）

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
