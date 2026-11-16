# 判定服务为什么有两份实现（node + python），以及靠什么防止漂移

- 日期：2026-11-16
- 作者：dsh-work-replace（rank2）
- 上下文：goal「ternary-oracle」L3 —— 把三值判定暴露成 HTTP 服务，跑在 Kali VM 里，给 atwo 用

## 事实

Kali VM 里没有 node（`node -v` → `command not found`，node/nodejs 都没有），只有 `/usr/bin/python3`（3.13.12）。
L3 的验收目标是「服务在 VM 里跑，atwo 跨主机判定」，所以只有两条路：

1. 在 Kali 装 node —— 等于在第二台机器上养第二份运行时；版本、PATH、升级全要跟；而且它将来会被别的任务复用成"这台机器上有 node"，埋下依赖漂移。
2. 服务用 VM 自带的 python 写一遍 —— 代价是判定公式出现**两份实现**。

选 2。理由：运行时是 VM 自带的事实，公式漂移是可以被对拍测试按死的问题；而"机器上多了个运行时"不是测试能兜住的。

## 两份实现的关系（不是并列，是主从）

- **node（vm/judge.mjs + vm/votes.mjs）是源头**：atwo 本地判定、所有单测、决策记录都指向它。
- **python（vm/oracle_server.py）是照契约复刻的服务端**：它不引入任何新口径，阈值从 `vm/oracle-contract.json` 读，不写死。
- **契约 JSON 是唯一真值来源**：`vm/export-contract.mjs` 从 node 侧导出 cut（0.45/0.22）、zLimit 3、spreadEps 1e-9、expectedDefault 9，外加 6 组参考向量。python 侧启动时读它并按它算。

## 漂移怎么兜

`test/vm_oracle_parity.test.mjs`（7 项，已进 test/all.mjs 发现式全量）：

1. python 服务自述引擎是 python；
2. 两边阈值同源（health.cut == node 的 CUT）；
3. 契约里 6 组参考向量逐点相等；
4. **随机 z 值 200 组**：结论必须一致，置信度差 < 1e-9；
5. **随机票型 120 组**：三态结论一致，置信度差 < 1e-9；
6. 畸形输入两边都 4xx（不许一边宽容一边严）；
7. 未知路径两边都 404。

关键设计：不写"python 也能跑"这种弱断言。弱断言在公式改动时照样全绿——那正是「两份解释器」那次事故的形状（compiler 与 machine 各有一份，改了 A 忘了 B，测出来 70/200 不等价）。所以这里用随机向量逼两边给出同一个数。

## 已知的不对称（有意保留，不是漏洞）

- python 侧 `checked: null`：node 的 judge 会顺带做 VM 复算校验（`checked` 是编译器与解释器是否一致的旁证），python 侧没有 VM，不假装有。字段明确写 null，而不是抄一个 true。
- python 侧没有 `judgeWithFallback` 这种降级逻辑：降级是**调用方**的决定（atwo），服务端只负责判定。
- 客户端 fail-closed：拿不到远端就 `ok:false`，绝不静默用本地结果冒名；atwo 里走 `EXIT.channel = 5` 而不是 0。

## 跨主机实测（2026-11-16）

```
Kali: /opt/ternary-oracle/{oracle_server.py, oracle-contract.json}
       setsid nohup python3 -u oracle_server.py --host 0.0.0.0 --port 8731
Windows → curl http://192.168.88.128:8731/health
  {"ok":true,"service":"ternary-oracle","version":"1.0.0-py","engine":"python",
   "cut":{"high":0.45,"mid":0.22},"zLimit":3.0}
Windows → node atwo.mjs judge --remote --url http://192.168.88.128:8731 --votes A,A,A
  结论 ACCEPT（都认了，可以过） · 置信度 0.762 · 判定 1（consensus-accept）  rc=0
Windows → node atwo.mjs judge --remote --url http://192.168.88.128:8731 --votes A,A,R
  结论 unreviewed（下不了结论） · 置信度 0.109 · 判定 -1（别判）            rc=0
```

## 换 python 版本 / 改公式时要做的事

1. 改 node 侧 → 跑 `node vm/export-contract.mjs` 重新导出契约 → 跑 `node test/vm_oracle_parity.test.mjs`。
2. 对拍红了不要改测试，先看是哪一侧偏离契约；契约 JSON 与 node 不一致就是 node 侧改了没导出。
3. python 解释器不在 PATH 的机器上用 `TERNARY_PYTHON` 指定；子进程必须带 `PYTHONIOENCODING=utf-8`，否则中文按 GBK 出去、端口那行变乱码，端口抠不出来。
\n## 追加：真实抓到了一次漂移（2026-11-16，就在本文件写完之后）\n\n写完上面那份说明，我去比对 Kali 上真跑起来的 python 服务与 node 侧的  回包，发现：\n\n\n\n结论、confidence、state 全都一样，**只有 reason 不一样**。而当时对拍测试只比 value/state + confidence，\n所以 7/7 全绿——这就是「弱断言」的教科书形状：错在契约上，绿在测试里。\n\n处理：\n1.  的  改成**一律机器码**（consensus-accept / consensus-revise / no-direction / undecided / insufficient），\n   人话搬到新字段 。原来 value<0 时把 judge 的中文 reason 直接塞进 ，\n   于是同一字段有时是代码有时是中文，下游写  永远不成立。\n2.  同口径改（reason 机器码 + reasonText 人话）。\n3.  增加三条比较：z 路径比 reason、votes 路径比 reason、votes 路径比 reasonText 是否同时为空/相等。\n4.  加三条断言把 reason 是机器码这件事钉死。\n5.  的人话输出改成 ， 里两个字段都出。\n\n改完：对拍 7/7（含新比较）、全量 35/35、三份 accept 五层 PASS。\n