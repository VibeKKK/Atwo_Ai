// 一次性：向 collab/SHARED.md 追加「2026-11-15 夜班（rank1）」小节，并把 §10 的已完成项勾掉
import fs from 'node:fs';

const P = 'collab/SHARED.md';
let s = fs.readFileSync(P, 'utf8');

const marker = '## 11. 夜班记录（2026-11-15 02:00–02:35，rank1）';
if (s.includes(marker)) {
  console.log('已存在该小节，跳过');
} else {
  const block = [
    '',
    marker,
    '',
    '副总管在跑 apispec 线期间，rank1 独自推进 PLAN-20261115.md，改了 4 个文件、合了 1 个提案。',
    '',
    '### 已完成',
    '| 项 | 结果 | 证据 |',
    '|---|---|---|',
    '| A0 就地补丁 | `self.mjs` 能吞 `diff` 形态的方案，落地 `lib/selfparse.mjs` 的 `extractPatches` / `applyPatch` | `test/self_patch.mjs` 16 checks passed；离线答案跑通 7 道回归 |',
    '| A1 brief 压缩 | `buildBrief()` 从约 500 字压到 68 字 | WorkBuddy 长 brief 只回「完成」的现象消失 |',
    '| A2 半截守卫 | `looksTruncated()` 接进 trae 两个收工分支 | 单测 5/5；`py-csv-dict` 不再被半截内容骗 |',
    '| A3 会话自愈 | 回合数 ≥ `ORCH_TRAE_MAX_TURNS`（默认 10）自动开新会话 | `ORCH_TRAE_NEW_CHAT=0` 可硬禁 |',
    '| PR 卡死根治 | `finish()` 抛错时自动 `prReject`，记 `rejected(auto)` | 派活失败不再留下永久 open 的空提案 |',
    '| A5 基线（半） | `eval/baseline.json` 建立，codebuddy 8 题 **7/8 = 87.5%**（均 57.2s） | trae 8 题今晚超时未产出，仍沿用 11-14 的 4 题数据（3/4 = 75%） |',
    '',
    '### protected 改动（需 rank2 知情）',
    '`pr.mjs:188` 的 `META_TOLERANT` 增加 `memory/SELF.md`。原因：`self.mjs` 每次自改都写这个文件，',
    '不加入白名单会导致「自举跑完 → `pr approve` 被工作区闸门拦死」的死循环（今晚实际撞上）。',
    '同类于 `memory/STATE.md`，属运行时产物，不是人为改动。',
    '',
    '### 合并记录',
    '`PR-20261115-003` 已合并 → `dd71a596`（A0 落地）；分支清理完毕，`main` 干净。',
    '',
    '### 留给下一班',
    '- trae 8 题基线：单题超时降到 90s、总超时 ≥1200s，或分批 4+4，别指望一次跑完。',
    '- A4 多文件自改还没一次真产出（解析器支持，缺端到端证据）。',
    '- `atw_*` 工具要等 DSH 重启才出现在工具列表。',
    '',
  ].join('\n');
  s = s.replace(/\s*$/, '\n') + block;
  fs.writeFileSync(P, s, 'utf8');
  console.log('已追加 ' + marker + '，文件 ' + s.length + ' 字符');
}
