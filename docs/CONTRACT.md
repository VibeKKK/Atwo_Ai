# 接口契约：让「拼不上」在落盘那一刻暴露

写这一页的原因很具体：一个任务分成三段派给不同模型，A 写 `loadTasks(filePath)`，B 写 `bin.mjs` 时按 `loadTasks(path)` 调。两边都能过 `node --check`，名字也都叫 loadTasks，接起来才炸。今晚之前，防这件事全靠派活的人把签名抄进每段描述里——那是人的认真，不是系统的保证。

契约就是把这个「抄」变成结构，由程序判。

## 契约长什么样

就是一个 JSON，写明「这个文件应该导出什么、每个函数收几个参数、参数叫什么」：

```json
{
  "file": "lib/todo/model.mjs",
  "exports": [
    { "name": "loadTasks", "params": ["filePath"], "returns": "Todo[]" },
    { "name": "saveTasks", "params": ["filePath", "list"], "returns": "void" }
  ]
}
```

必填只有两处：`exports` 必须是数组、每项的 `name` 必须是非空字符串。`params` 可省略，省略就等于「只验名字在不在，不验签名」——宽松，但会在结论里留一句「签名未校验」，不会假装验过。`returns` 目前只给人看，程序不解析。

## 放进任务 JSON

契约挂在单个任务上，不挂在批次上：

```json
{
  "tasks": [
    {
      "id": 1,
      "text": "实现 lib/todo/model.mjs 的读写。",
      "contract": {
        "file": "lib/todo/model.mjs",
        "exports": [
          { "name": "loadTasks", "params": ["filePath"] },
          { "name": "saveTasks", "params": ["filePath", "list"] }
        ]
      }
    },
    {
      "id": 2,
      "text": "实现 bin/todo.mjs，调用 lib/todo/model.mjs。",
      "dependsOn": ["lib/todo/model.mjs"]
    }
  ]
}
```

`dependsOn` 和 `contract` 是两件事，别混：

- `dependsOn` 只把上游的真实签名拼进下游的 prompt（「照着这些签名写」）。它是**续写约束**。
- `contract` 是下游产物落盘时的**验收标准**，判不合格就退回重写。

所以第一个任务写了 `contract`，第二个任务没写——第二个任务只有约束没有验收。要让两个都硬，两个都写。

## 怎么得到一份契约

两条路，优先级相反：

**一、人写（推荐，尤其当接口是你定的）。** 直接手写上面那段 JSON。慢，但准。

**二、从已有文件反推草稿：**

```bash
node lib/apispec.mjs emit lib/todo/model.mjs
```

输出可直接粘进任务 JSON。但注意它带 `"draft": true`——这是**从产物反推的草稿**，不是你确认过的原始契约。

为什么必须标出来：如果那个文件本身就写歪了（参数名错、多一个参数），反推出来的契约也会跟着歪，然后下游会**忠诚地照着歪的签名写**，两边一起歪，验收还全过。这就是「事后 emit」和「事前 contract」的区别，也是这套东西唯一真正的风险点。反推只适合「接口已经人工确认过」的文件。

## 坏契约会怎样报

契约写错时，结论必须说「契约错了」，不能让它看起来像产物错了，更不能抛异常。三种坏法实测过：

| 你写的 | 会报什么 |
|---|---|
| `{}` | 契约没写 exports 字段，等于没给契约 |
| `{"exports":"nope"}` | 契约的 exports 必须是数组，实际是 string |
| `{"exports":[]}` | 契约 exports 是空数组，等于没给契约 |
| `{"exports":[{"name":123}]}` | exports[0].name 必须是非空字符串 |
| `{"exports":[{"name":"f"}]}` | ok，但附注「f 只给了名字、没给 params，签名未校验」 |

修之前，第二种会抛 `want.map is not a function`，在 `swarm` 的 try/catch 里被当成「验收崩溃」；第一种静默失败且不说原因。两种都让人查错方向。

## 什么能契约化，什么不能

能：函数名、参数个数、参数名、返回类型的名字。

不能：这活做得对不对。一个 todo 工具接口全对，但它是不是一个好工具，程序判不了。

能契约化的是**形状**，不能契约化的是**意图**。形状全自动，意图靠测试或人看一眼。契约化不会让第一个任务变快，它让「明天再加十个任务」变可行。

## 和另外三层验收的关系

落盘时同时跑四层，任何一层不过都退回重写：

1. **结构**——非空、无占位符（`TODO`、`...`、`待补充`）
2. **语法**——`.mjs` 跑 `node --check`，`.json` 跑 `JSON.parse`，`.md` 数 `##` 章节
3. **形态**——扩展名和内容对得上（`.md` 里不能是一段 JS，`.mjs` 里不能是 markdown）
4. **形状**——接口契约，就是这一页说的东西

前三层不需要任何配置，第四层需要你写 `contract`。

## 命令速查

```bash
node lib/apispec.mjs emit  lib/todo/model.mjs        # 反推草稿契约
node lib/apispec.mjs check lib/todo/model.mjs s.json # 用契约判一个文件
node test/apispec.test.mjs                            # 契约模块自测
```

`emit` 和 `check` 都不 import 产物，只静态读文本。理由是产物可能是刚生成、带副作用的半成品，为了验签名去 load 它，等于让验收入口承担执行风险。

## 什么时候该写，什么时候别写

**该写：**

- 两个任务之间有调用关系，尤其「A 产出、B 消费」这种。
- 接口是你定的，不是模型发挥的。你定的事让程序判，别让它猜。
- 任务会被重跑。重跑时契约是唯一不漂移的东西。

**别写：**

- 单文件、没人消费它。契约白写，只会让 `maxFix` 多花一轮。
- 文档类产物。`README` 要 120 到 160 行、要两个二级标题——这种「风格要求」用 schema 表达不了，写了也是假精确。行数和章节数已经在第三层（形态）里查了。
- 你自己都还没想清楚接口。这时候写契约会把「没想清楚」固化成一个看起来确定的 JSON，比不写更危险。

一句话判据：**下游会不会照着这个签名写代码？** 会，就写；不会，别写。

## 一个实测数字

同一份产物，参数名从 `filePath` 写成 `path`：

```
正确产物   → 总判定 ok=true   | 接口契约 ok=true
参数名写歪 → 总判定 ok=false  | apispec FAIL: loadTasks 参数不符：要 [filePath] 实为 [path]（第 1 个就错了）
```

`node --check` 对这两种情况都是通过。差别只在第四层。这就是为什么前三层够了的时候还得加这一层。
