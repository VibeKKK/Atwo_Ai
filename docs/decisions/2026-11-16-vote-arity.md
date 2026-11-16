# 第二步：置信度分母与到票闸门（2026-11-16）

作者 rank2（dsh-work-replace）。对象：`vm/judge.mjs` / `vm/votes.mjs` / `vm/oracle_server.py` / `vm/export-contract.mjs`。
触发：lead 的改进方案三问（`collab/mailbox/20261116-094200-from-dsh-lead-改进方案三问-公式与闸门.md`），我回信里否掉了他的一条判据、补了两条。

## 0. 一句话

改的是**分母**：以前「传进来几条读数」就算几个证据、「来了几张票」就算应评几张；
现在证据按来源去重、应评名额只认显式声明。改完一批原本「可判」的结论会翻成「别判」——这是目的，不是副作用。

## 1. 三条判据（我改的版本）

| # | 判据 | 为什么不是别的写法 |
|---|---|---|
| ① | `nValid = 去重后来源数 / expected`。有 `source` 标签按标签去重（同来源取均值），无标签按**原始读数**去重 | 九项指标里同一项重复上报不算九个证据。**去重键必须用截断前原值**：3.1/3.2/3.4 截断后都是 3，用 z 当键会把三条独立指标压成一条（实测把 9 项高证据压成 4 源、置信度 0.442、结论从「可判」翻成「存疑」） |
| ② | `n = 1`（只有一个来源）时 `agreement = 0` | 一个来源不能自证一致。旧公式 `agreement = tanh(|meanZ|/spread)` 在 `sd = 0` 时恒等于 1，于是「同一个数抄九遍」拿满分 |
| ③ | `n >= 2` 且 `sd < eps` 时**保留** `agreement = 1` | 九个独立来源给出同一个值是真·多重印证。lead 原方案是 `sd < eps → agreement = 0`，会把这种情况一起判死，我否了 |

第四条（纪律）：`cut.high` / `cut.mid` / `zLimit` / `expectedDefault` / `votes.arity` **只从 `vm/oracle-contract.json` 读**，
`vm/judge.mjs` 里的 `FALLBACK` 常量表已删除——契约缺失或字段非数字直接 `throw`。
理由不是洁癖：今早 python 与 node 两份实现只差一个 `reason` 文案，对拍 7/7 全绿照样漂移；常量写两遍就是下一次漂移的入口。

## 2. 到票闸门（放行侧）

- `votes.arity = 0.8`（契约）→ `(ACCEPT + REVISE) / expected < 0.8` ⇒ `state = unreviewed`、`reason = insufficient`。
  原来判 `+1` 的**降级成 0**；本来就 ≤0 的保留原值（零票时 judge 给 -1「别判」，不该被抹成 0）。
- **`expected` 未声明 ⇒ `reason = no-roster`、一律 `unreviewed`**。这是本轮第二个放行侧漏洞：
  旧逻辑 `expected` 缺省等于 `votes.length`，于是「来三张都认」自动等于「到票率 100%」。
  `atwo.mjs` 的 `done` 闸门里 `|| feed.votes.length` 那一截已删——应评名额只认 `--expect-n N` 或 `--expect 名单`。
- 没票**不硬拒**：输出「还缺谁的票」并允许 `--yes` 放行且写审计。否则会被训练成无脑 `--yes`，比没闸门更坏。

## 3. 改动的文件

| 文件 | 改动 |
|---|---|
| `vm/judge.mjs` | `loadContract()` 删掉兜底数字表，坏契约直接抛；`computeConfidence(zValues, {expected, sources})` 支持 `[数]` 与 `[{z\|value, source\|src}]`，标签三级回落（对象自带 → `sources[i]` → 无标签）；返回值加 `nSources` / `rawCount` |
| `vm/votes.mjs` | `ARITY = VOTE_ARITY`（来自契约）；`votesToZ` 返回 `sources`（每张票一个来源：`{reviewer\|source\|by}` 或 `ballot:i`）；`judgeVotes` 加 `turnout` / `rosterMissing` / `arity` 三个出口字段 |
| `vm/oracle_server.py` | 同口径：`reading(item, idx, sources)`、`compute_confidence` 去重 + `n>=2` 才 `tanh`、`judge_votes` 的 `roster_missing` 与 `below_arity` 闸门；`/judge` 入参接受 `{z, source}` |
| `vm/export-contract.mjs` | `contractVersion = 2`；新增 `votes.arity` / `dedupRule` / `rosterRule` / `formula` / `votes.sources`；参考向量 9 组（新增三组退化向量） |
| `atwo.mjs` | `judge` 的「应评」如实打印（未声明时写「未声明 · 用 --expect 3 或 --expect 名单」）、`--json` 出 `rosterMissing`；`done` 的 `expectN` 去掉 `|| feed.votes.length` |
| `test/vm_judge_guards.test.mjs`（新） | 31 条：常量来自契约、代码里无阈值字面量（扫前剥注释）、三组退化向量、截断不当去重键、到票率闸门、零票与 no-roster |
| `test/vm_oracle_parity.test.mjs` | 加 3 条「无名单 → 两边都 unreviewed/no-roster」；总数 10 条 |

## 4. 实测

```
node test/all.mjs            → ✓ 40 / 40 · 9–11s
node test/vm_judge_guards    → 31 / 0
node test/vm_oracle_parity   → 10 / 0（9 组契约向量 + 200 组随机 z + 120 组随机票型 + 3 组无名单，reason/reasonText 都比）
py -m py_compile vm/oracle_server.py → OK
```

跨主机（Kali `192.168.88.128:8731`，`setsid nohup python3`，PPID 1）：

| 输入 | node 本地 | Kali python |
|---|---|---|
| `{votes:[A,A,A]}` 无名单 | unreviewed / no-roster / 0 | 同 |
| `{votes:[A,A,A], expected:5}` | unreviewed / insufficient / 0（到票 3/5 = 0.60） | 同 |
| `{zValues:[0.5×9]}` | -1 / 别判 / 0.000（nSources 1、agreement 0） | 同（stats.nSources 1） |
| `{zValues:[{z:1.2,source:m0..m8}]}` | +1 / 0.834（nSources 9、agreement 1） | 同 |

`atwo judge --remote --url http://192.168.88.128:8731 --votes A,A,A` → unreviewed / no-roster，RC 0。

## 5. 已知不对称 / 未做

- python 侧 `checked: null`（不跑编译执行对拍），node 侧会跑 AST→编译→machine 三值链。这条不对称是设计：python 是**异源复核**，不复刻全部机制。
- `atwo done` 的真实闸门依赖 `reviews/` 里的评审票与 `--expect` 声明；本轮只用单测覆盖了 `judgeVotes` 层，没有端到端跑一次 `done`（那会触发全量回归，留给我下一次收工）。
- 第三步 `atwo triage`（真失败 / 证据不足 / 假失败）按约定延后，等这一步落地一周后看「证据不足」里有多少真变复核。

## 6. 回滚

```bash
git checkout -- vm/judge.mjs vm/votes.mjs vm/oracle_server.py vm/export-contract.mjs atwo.mjs
rm test/vm_judge_guards.test.mjs
node vm/export-contract.mjs   # 用旧代码重生成契约
```
注意：契约 JSON 已升到 version 2，旧代码读不到 `votes.arity` 时会落到它自己的兜底常量——所以回滚必须一起回滚代码与契约。
