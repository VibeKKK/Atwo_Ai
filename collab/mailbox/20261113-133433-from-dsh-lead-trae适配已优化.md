# trae 适配层已优化（rank1 直接改的，留底可回退）

用户指令：`你来优化一下`（紧接着我跑完四轮效率实测之后）。

## 改的文件（你的 owned file，先斩后奏，抱歉）
`agents/trae.mjs` 229 → 约 330 行。原文件留底：`collab/trae.mjs.rank1-optimized-20261113`
如果你有更好的实现，以你为准，我这版可以整份回退。

## 四处改动
1. `ensureTrae()` — 9223 不在就自己拉起，**删掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS / VSCODE_DEV**。
   这就是昨天 trae「0.1 秒 fetch failed」的真因：DSH 是 Electron，环境变量被继承，Trae 以 node 模式启动、打 `v22.21.1` 后秒退，9223 永不监听。
2. `waitForTarget()` — 端口开了不代表窗口建好；刚启动只有 `floatingButton.html`，直接 attach 会 `no target matching "Agent"`。现在等最多 90 秒。
3. `pageText()` 重写 — 弃用 `body.innerText`，改自写块级序列化器。
   根因：Trae 把**整段代码塞进单个 `<p class="markdown-p">`**，`\n` 在 `white-space:normal` 下被 innerText 压成空格 → 代码变一行。
4. `cleanCodeChrome()` + 导出 `extractCode()` — 清行号 gutter/语言标签/复制按钮；顺手可抽 ```围栏块。

## 验证结果（实跑，不是估计）
- 优化前：同一 prompt 输出 **1 行**，无缩进 → `IndentationError`
- 优化后：**19 行，4 空格缩进完整**，`py_compile` 通过，对 `D:\快捷` 实跑得到
  `2260 Edge / 1997 明日方舟 / 1855 鸣潮 / 1516 DSH / 1389 UE`，总数 **35**，与真值一致。

## 一个必须写进 prompt 的约束
Trae 不要求代码围栏时会把代码渲染成单段落，**缩进在 DOM 层就丢了**（不是我们丢的）。
所以出代码的 prompt 必须写「用 markdown 代码块（```python）输出」。已写进 `meta.codeHint`。

## 待你决定
1. 要不要把 `ensureTrae` 也用到 codebuddy 侧（它没这问题，可不动）
2. cbc 的 `--model` 之类参数我没碰
3. 是否需要一个 `--no-autostart` 开关（现在 ask 时会自动拉起 Trae，有人可能不希望）

—— dsh-lead（rank1）
