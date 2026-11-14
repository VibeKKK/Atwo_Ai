# 接入一个新 Agent

Orchestra 现在管三条路：`trae`（CDP 驱动桌面应用，20–25s）、`codebuddy`（CLI，170s 但准）、`workbuddy`（CDP，22s）。要把第四条路接进来，改的是三个地方，不是十个。

配套的可运行骨架在 [agents/demo.mjs](../agents/demo.mjs)（178 行，`node --check` 通过）。下面讲**为什么**这么改，骨架讲**长什么样**，两边对着看。

## 一、三处改动

1. 新建 `agents/<name>.mjs`，导出 `meta` 与 `ask<Name>(prompt, opts)`。
2. `orchestra.mjs` 顶部加一行 import（现在的三个在 20–22 行）。
3. `lib/swarm.mjs` 的 `routeTask` 加判定，并考虑是否进 `FALLBACK` 链。

改完跑 `node orchestra.mjs doctor`，它会把新路列进可用性检查。

## 二、`meta` 契约

```js
export const meta = {
  name: 'codebuddy',              // 必须和 routeTask 的返回值一致
  kind: 'cli-agent',              // cli-agent | cdp-agent
  transport: 'cli',               // cli | cdp
  port: 'stdin',                  // stdin 或数字端口，doctor 用它探活
  strengths: ['整仓多文件改造', '跑命令改代码', '结构化 JSON 输出', '可后台可 swarm'],
  costModel: '积分（CodeBuddy 账号内扣减）',
};
```

`strengths` 不是装饰。`routeTask` 的注释里写着「要产出代码 → 慢但准」，这条判断就是从 strengths 推出来的。写不出差异化优势的路，接进来只会多一个超时来源。

`port` 决定 `doctor` 怎么探活：数字端口走 `net.connect`，`'stdin'` 表示子进程式 CLI、不需要端口。写成数字却又不监听，`doctor` 会一直报 ✗。

## 三、`ask<Name>` 契约

```js
export async function askDemo(prompt, opts = {}) {
  const { timeoutMs = 240000 } = opts;
  return { answer, code, notes, confidence, raw, ms, inputTokens, outputTokens };
}
```

字段全部要齐，缺项会让 `lib/verify.mjs` 的契约校验失败。重点说三个：

- **`answer`** 原文照抄模型输出，不做清洗。清洗是 `lib/reply.mjs` 和 agent 内部 `extractCode` 的事，混在返回值里会让「原文」和「提纯」两件事纠缠。
- **`code`** 只放能直接落盘的代码块。`lib/land.mjs` 的 `extractCode` 优先认契约 JSON 里的 `code`/`content`/`implementation`，其次认 markdown 围栏。所以 codebuddy 这类结构化 CLI 直接把 JSON 塞进 `code` 字段最省事；trae 这类只会输出 markdown 的，交给 `extractCode` 从围栏里捞。
- **`notes`** 模型没把握的地方写这里。`feedbackFor` 回喂时会把它一起带回去。

## 四、路由怎么写

```js
export function routeTask(text, mode = 'auto') {
  if (mode === 'trae' || mode === 'codebuddy' || mode === 'workbuddy') return mode;
  const t = String(text || '');
  if (HEAVY_STRONG.test(t)) return 'codebuddy';
  if (t.length <= 800) return 'workbuddy';
  return 'codebuddy';
}
```

三个判据按顺序：

1. **显式 `--agent`** 永远最高优先，不许被启发式覆盖。
2. **强信号**（`HEAVY_STRONG`：写入文件、多文件、实现某模块）→ 直接给准的那条，别省那 150 秒后返工。
3. **长度兜底**：800 字以下是短问答，给最快的路；超长自动归到能吃下长上下文的那条。

`FALLBACK` 是失败回退链，规则是「先换到同档或更快的路，别一头掉进最慢的」：

```js
export const FALLBACK = { trae: 'workbuddy', workbuddy: 'trae', codebuddy: 'workbuddy' };
```

`codebuddy` 失败降到 `workbuddy` 而不是原地重试，因为它失败基本都是「没登录」「会话超限」这类**状态性**问题，重试同一路只会得到同一个错。

## 五、四个踩过的坑

**1. `ELECTRON_RUN_AS_NODE` 污染**

DSH 自己是 Electron 应用，环境里带着 `ELECTRON_RUN_AS_NODE=1` 和 `NODE_OPTIONS`。子进程继承后，Electron 系 CLI 会变成纯 node、命令行开关全不认。所有 spawn 之前必须：

```js
delete e.ELECTRON_RUN_AS_NODE;
delete e.NODE_OPTIONS;
```

这条不写，症状是「0.1 秒就 fetch failed」——进程根本没起来。

**2. CDP 的 `Host` 头**

`http://127.0.0.1:9223/json/list` 直连会被拒。Chromium 的 DevTools 端点校验 `Host`，必须显式带 `Host: localhost:9223`（是 `localhost` 不是 `127.0.0.1`）。

**3. 回合衰减**

trae 在一次会话里连着跑十几个任务后响应会变形，输出开始缺代码块。这是 `slots` 要给 trae 设 1、给 codebuddy 设 6 的原因，也是快路溢出时优先改派 workbuddy 而不是硬塞给 trae 的原因。

**4. 内联正则的 shell 转义**

在 `node -e` 里写含 `\` 的正则，经过 shell 之后会被吃成别的意思，报出来的错误跟正则毫无关系（常见 `SyntaxError: Invalid regular expression`、`Expected ... got using`）。凡是含反斜杠或引号的脚本，先落成 `.mjs` 文件再跑。

## 六、接入后的自检清单

按顺序，每步花不到一分钟，能挡住 90% 的接入错误：

1. `node --check agents/<name>.mjs` —— 语法。
2. `node orchestra.mjs doctor` —— 新路是否出现在可用性表里，端口探活对不对。
3. `node orchestra.mjs peek <name>` —— 如果实现了 `peek<Name>`，看一眼当前页面/会话状态；没实现就跳过。
4. 单条任务：`node orchestra.mjs ask <name> "写一个 20 行的 clamp 函数"` —— 看返回字段是否齐全。
5. 走一遍落盘：`node orchestra.mjs swarm "写 lib/foo.mjs，导出 clamp" --agent <name> --land` —— 验收必须通过。落盘隐含验收，这是硬规则。

## 七、别做的事

- **别在 agent 里清洗输出再返回。** 清洗逻辑一旦分叉到三个 agent 里，同类 bug 要修三遍。清洗归 `lib/reply.mjs`，提取归 `lib/land.mjs`。
- **别让 agent 直接写盘。** 所有写入经过 `planLanding` → `applyLanding`，路径白名单（`lib`/`docs`/`agents`/`eval`/`collab`/`memory`/`tools`）和互斥检查都在那里面。让 agent 自己 `fs.writeFileSync` 等于把白名单拆了。
- **别在 `ask` 里做重试。** 重试归 `runPool` 的生命周期循环，那里知道「上次错在哪」并能生成回喂 prompt；agent 里重试只会无脑重复同一个错。

## 八、现有三条路的实测基线

接新路之前先看这个表，判断你接的东西到底有没有把天花板抬高。数字来自 `node orchestra.mjs stats`，是真实跑出来的，不是估算：

| 路 | 调用次数 | 成功率 | 均耗时 | 特点 |
|---|---|---|---|---|
| trae | 124 | 70% | 23.2s | 快，但连着跑十几个任务后会衰减 |
| codebuddy | 40 | 95% | 40.7s | 最稳，吃 74 万 in / 7 万 out token |
| workbuddy | 5 | 100% | 78.7s | 样本少，均字符只有 11，通道等于没通 |

新路要有存在价值，至少满足一条：**比 trae 稳**（成功率 > 70% 且不衰减）、**比 codebuddy 快**（< 40s 且字段齐全）、或者**能吃下前两条吃不下的输入**（超长上下文、多模态）。三条都不占，接进来只是多一个超时来源。

`workbuddy` 那 5 次均字符 11 是个教训：成功率 100% 但输出是空的，比失败更危险 —— 失败会换路，空输出会被当成「成功了」往下走。所以 `ask` 里必须校验 `answer` 长度，低于阈值直接抛错而不是返回空字符串。

## 九、命名与文件约定

- 文件名 = `meta.name` = `routeTask` 返回值，三处必须字面一致。不一致的症状是 `swarm --agent foo` 报「未知 agent」但文件明明存在。
- 导出函数名 = `ask` + 首字母大写的 name（`askTrae` / `askCodeBuddy`）。`orchestra.mjs` 靠这个命名对齐 import 时的别名，改成 `askCB` 也能跑，但下一个人会找不到。
- `peek<Name>` 是可选的观测函数，返回当前页面/会话的只读快照。它存在的价值是**排查时不用猜**：`swarm` 卡住时先 `peek` 一眼，能立刻分出「界面变了」和「模型慢了」两种情况。

---

改完记得把新路写进 `collab/SHARED.md` 的选型表。下一个人（或下一个 agent）判断「这活该派给谁」时，看的是那张表，不是代码。
