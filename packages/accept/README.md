# @orch/accept

AI 交活的验收闸门。零依赖，Node 18+。

一句话：**「AI 说它完成了」和「它真的完成了」之间，隔着一道程序化的闸门。**

## 为什么需要它

2026-11-15 这一天，同一个故障出现了四次——四次都不是「AI 不会写代码」，而是「AI 说写完了，其实没写完」：

| 发生了什么 | 状态显示 |
|---|---|
| 要 9 章 markdown，交上来 178 行 JavaScript | done |
| 注释开头的两个星号被渲染层当加粗吃掉，文件语法直接坏 | done |
| 问 A 题，答的是上一轮 B 题的答案 | done |
| 存盘的是对的，通道却说「没拿到回答」，于是判成失败 | failed |

四次全都通过了「看起来没问题」这一层。所以验收不能靠看。

## 四层静态判定

任一不过就是没过。

| 层 | 查什么 | 典型拦截 |
|---|---|---|
| **shape** | 存在、非空、没有占位符 | `TODO:` / `your-code-here` / 待实现 |
| **syntax** | 语言层能过 | `node --check`；JSON 走 `JSON.parse` |
| **contract** | 接口签名对得上消费者 | `loadTasks(p)` vs 契约要 `filePath` |
| **custom** | 任务点名要求的行数 / 导出名 / 章节数 | 要 120-180 行，实际 20 行 |
| **behavior** | 真跑行为用例（可选，要显式给 `--behave`） | 输入 17 个问题，输出「共列出 0 个问题」 |

前四层只看「长得对不对」，第五层看「算得对不对」。这个区别是实测出来的：

```
$ accept lib/humanize.codebuddy.mjs --lines 120-180 --exports humanVerdict,humanIssues,...
形状    过
语法    过
要求    过
判定  通过

$ 同一份文件，加上行为用例：
行为    不过（2/6 通过）  all-revise 时问题数必须真的是 17，不是 0 → 实际 共列出 0 个问题
判定  未通过
```

第五层跑在**子进程**里（`bin/behavior-runner.mjs`），20 秒超时：崩了、挂住了都不影响验收本身。

## 第五层：异源评审

静态检查判得了**形状**，判不了**意图**。这不是理论，是实测：

```
$ accept _probe/bad_subject.js
产物  _probe/bad_subject.js
尺寸  602 B · 26 行
形状    过
语法    过
判定  通过          ← 静态四层全过
```

同一个文件，交给另一个模型读：

```
评审者 codebuddy → 裁决 REVISE（6 条）
· 循环上界 <= 导致越界
· null < 60 恒为真，缺考的人被算成不及格
· sum += s 遇字符串污染
· count===0 时返回 NaN
· 给缺考者加了 5 分
· names/scores 平行数组假设
```

**结论：静态闸门和评审闸门缺一不可。** 前者挡半成品，后者挡「写得很整齐但想错了」。

评审器是可插拔的：不接就只跑四层，接了就必须给结论——**解析不到裁决不算通过**。

## 用法

```bash
accept <file>                          # 只跑 shape + syntax
accept <file> --lines 120-180          # 加行数要求
accept <file> --exports a,b,c          # 加导出名要求
accept <file> --sections 9             # 文档类：章节数
accept <file> --spec spec.json         # 接口契约
accept <file> --task task.md           # 从任务原文自动解析要求
accept <file> --behave cases.mjs       # 加行为用例（会执行被测文件）
accept <file> --json                   # 机器读
```

退出码是唯一的机器接口：**0 通过 / 1 未通过 / 2 用法错**。shell 里没人读得懂输出，只认退出码。

### 当作库用

```js
import { accept, formatReport } from '@orch/accept';

const r = accept('lib/foo.mjs', {
  spec: { exports: [{ name: 'loadTasks', params: ['filePath'] }] },
  lines: { min: 120, max: 180 },
});

if (r.verdict !== 'PASS') {
  console.error(formatReport(r));
  process.exit(1);
}
```

### 接进 CI / git hook

```bash
# pre-commit：AI 写的文件必须先过闸
for f in $(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(mjs|js|cjs)$'); do
  accept "$f" --task TASK.md || exit 1
done
```

```yaml
# GitHub Actions
- run: npx @orch/accept dist/main.mjs --spec spec.json
```

## 契约文件

`spec.json` 描述产物必须导出的东西：

```json
{
  "exports": [
    { "name": "loadTasks", "params": ["filePath"] },
    { "name": "saveTasks", "params": ["filePath", "tasks"] }
  ]
}
```

契约自己写坏了会先被报出来，不会让产物背锅：`validateSpec()` 认六种坏法（非对象 / 缺 exports / 不是数组 / 空数组 / name 不是字符串 / params 不是数组），每种都给人话。

## 刻意不做的事

1. **默认不 import 被测文件。** import 会执行顶层代码（联网、写盘、开端口），验收入口不该有副作用。唯一的例外是显式给了 `--behave` —— 那时执行发生在独立子进程里。
2. **不把「没结论」当「通过」。** 评审没给 `VERDICT` 就是没通过。
3. **不猜。** 看不出文件类型就报 unknown，不硬套检查。

## 什么时候它没用

诚实边界：

- **前四层判断不了「对不对」，只判断得了「像不像」。** 逻辑错误、业务误解、答非所问，静四层全放行——除非你写下了对应的行为用例（第五层），但用例只能验你已经想到的东西。
- **需要第五层才完整。** 而第五层依赖一个你信任的、和被审对象异源的模型。
- **不替代测试。** 它是测试之前的粗筛，不是测试的替代。
- **不验证运行结果。** 文件能不能跑、跑出来对不对，它都不知道。

## 测试

```bash
node test/accept.test.mjs   # 22 项，全部对应真实发生过的事故
```

## 相关

- `docs/REVIEW.md` — 为什么要异源评审、怎么读裁决
- `docs/CONTRACT.md` — 接口契约怎么写、什么时候别写
