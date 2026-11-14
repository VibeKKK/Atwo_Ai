probe-clamp 边界行为说明

对应实现：lib/probe_clamp.mjs（ESM，命名导出 clamp / isBlank / chunk）。
本文只描述边界行为：正常输入、非法输入、异常类型与触发顺序。
三个函数都是纯函数，不修改入参，不做隐式类型转换。

0. 总览
添加到对话
放大
下载
函数	作用	典型返回	主要异常
clamp(n, lo, hi)	把 n 夹逼到闭区间 [lo, hi]	number	TypeError / RangeError
isBlank(s)	判断字符串是否不含可见内容	boolean	无（不抛错）
chunk(arr, size)	按固定长度切分数组	Array<Array<*>>	TypeError / RangeError

三条通用约定：

类型错用 TypeError，取值错用 RangeError：前者表示"这不是数值 / 数组"，后者表示"值本身超出了允许范围"。
不静默兜底：非法入参不会返回 NaN、undefined 或空结果，问题在入口就暴露，不推迟到下游。
不做隐式转换：0、false、[] 不会被悄悄当成数值或字符串；需要转换时由调用方显式完成。
1. clamp(n, lo, hi)
1.1 正常区间
n < lo 返回 lo；n > hi 返回 hi；lo <= n <= hi 原样返回 n（含两个端点）。
实现是 Math.min(Math.max(n, lo), hi)：先抬到下界，再压到上界，无需分支。
返回值始终是 number，不做四舍五入，也不做字符串化。
lo === hi 是合法区间：无论 n 是多少，都返回该端点值。
1.2 lo > hi 时怎么处理（重点）

结论：抛 RangeError，不静默交换端点，也不返回 NaN。​

判定条件就是 lo > hi。区间上下界写反属于调用方的定义错误，库不会自作主张交换两端后继续计算。
错误信息会带出两个端点，便于定位：lo 不能大于 hi（lo=10, hi=0）。
该检查位于三次 assertNumber 之后。因此 clamp(NaN, 10, 0) 得到的是 TypeError（n 先不合法），而不是 RangeError。
若业务上确实需要容错，请在调用前自己归一化（const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];），不要依赖库猜测意图。
1.3 参数类型与 NaN
n、lo、hi 必须都是 number，且不能是 NaN；否则抛 TypeError。
校验顺序固定为 n → lo → hi，错误消息中的参数名可据此判断是哪一项出问题。
字符串 '0'、null、undefined、大整数 1n 都不会被转换，一律 TypeError。
NaN 单独拒绝：它不满足任何比较，也会污染 Math.max / Math.min 的结果。
1.4 ±Infinity 端点
端点允许 ±Infinity，用于表达"只有上界"或"只有下界"：clamp(1e9, -Infinity, 1) 返回 1。
待夹逼值 n 也可以是 Infinity，会被上界正常收敛：clamp(Infinity, 0, 10) 返回 10。
clamp(1, -Infinity, Infinity) 原样返回 1；lo === hi === Infinity 同样是合法区间。
1.5 数值细节
不四舍五入：clamp(2.5, 0, 3) 返回 2.5。
-0 在命中端点时可能被规范化为 +0：clamp(-0, 0, 10) 返回 0，这是 Math.max 的原生行为。
不处理超过 Number.MAX_SAFE_INTEGER 后的精度问题，精度由调用方保证。
1.6 行为速查
添加到对话
放大
下载
调用	结果	说明
clamp(5, 0, 10)	5	区间内原样返回
clamp(-3, 0, 10)	0	低于下界，抬到 lo
clamp(42, 0, 10)	10	高于上界，压到 hi
clamp(0, 0, 10)	0	端点包含在内
clamp(1, 10, 0)	RangeError	lo > hi，不交换
clamp(NaN, 0, 10)	TypeError	参数校验先于区间校验
clamp(1, '0', 10)	TypeError	不做字符串转换
2. isBlank(s)
2.1 空白的定义
空串 '' 返回 true。
使用 /^[\s\u200B\u200C\u200D\u2060]*$/u 判定：整串必须全部由空白组成，只要出现一个非空白字符就返回 false。
\s 覆盖 JS 的全部 Unicode 空白：半角空格、\t \n \r \v \f、NBSP \u00A0、全角空格 \u3000、行 / 段分隔符 \u2028 \u2029、BOM \uFEFF 等。
另外显式补上不属于 \s 的零宽字符：ZWSP \u200B、ZWNJ \u200C、ZWJ \u200D、WORD JOINER \u2060，它们同样不产生可见内容。
边界反例：NUL \u0000 不可见，但不属于空白集合，isBlank('\u0000') 返回 false。
2.2 null 怎么处理（重点）

结论：isBlank(null) 返回 true；所有非字符串入参都返回 true，函数不抛错。​

涵盖 null、undefined、数字、布尔、对象、数组、Symbol、函数，以及包装对象 new String('')。
语义是"没有可显示的字符串内容"，与 Apache Commons StringUtils.isBlank(null) === true 的惯例一致。
因此用于表单校验时，null 与 '' 无需分别处理，一个判断即可覆盖。
代价是它不做类型检查：若业务要求"必须传字符串"，请在调用前自行校验，或组合使用 typeof s === 'string' && isBlank(s)。
2.3 为什么不做隐式转换
刻意不调用 String(s)：否则 isBlank([]) 会因转成 '' 被判为空白，isBlank(0) 会因转成 '0' 被判为非空白，语义随转换规则漂移。
由此产生一个必须记住的差异：isBlank(0) === true，而 isBlank('0') === false。
需要"先转字符串再判定"时，请显式写 isBlank(String(s))，让意图出现在调用处。
2.4 副作用与性能
只做判定，不 trim，不分配新字符串。
正则不带 g / y 标志，RegExp.test 不受 lastIndex 影响，重复调用结果稳定、无隐藏状态。
时间复杂度 O(n)，n 为字符串长度；全空白串需要扫描到末尾才会返回 true。
2.5 行为速查
添加到对话
放大
下载
调用	结果	说明
isBlank('')	true	空串
isBlank(' \t\n')	true	常见 ASCII 空白
isBlank('\u3000\u00A0\uFEFF')	true	全角空格、NBSP、BOM
isBlank('\u200B')	true	零宽字符显式纳入
isBlank(null)	true	非字符串统一视为无内容
isBlank('  a  ')	false	含非空白字符
isBlank('0')	false	字符串 '0' 有可见内容
isBlank('\u0000')	false	NUL 不算空白
3. chunk(arr, size)
3.1 正常切分
每 size 个元素一段，最后一段不足 size 时原样保留：chunk([1, 2, 3, 4, 5], 2) → [[1, 2], [3, 4], [5]]。
size >= arr.length 时返回只含一个分段的数组，例如 chunk([1, 2], 10) → [[1, 2]]。
空数组返回 []，前提是 size 合法（见 3.3 的校验顺序说明）。
3.2 size <= 0 怎么处理（重点）

结论：0、负数、小数一律抛 RangeError；绝不会出现空分段或死循环。​

校验链分两步：先 assertNumber(size) 保证是 number 且非 NaN，再要求 Number.isFinite(size) && Number.isInteger(size) && size >= 1。
size = 0、-1、1.5、Infinity → RangeError：size 必须是有限的正整数。
size = NaN 属于类型问题，停在第一步 → TypeError；size = null / '2' / undefined 同样是 TypeError。
为什么必须拒绝：步长为 0 或负数时 for (start += size) 不推进，会退化成死循环；小数则无法定义分段边界。
极端大的合法整数（如 Number.MAX_SAFE_INTEGER）不额外限制，只会让结果退化为单段。
3.3 校验顺序的坑
顺序固定：先 Array.isArray(arr)，再校验 size。
因此 chunk('abc', 0) 抛的是 TypeError（arr 不是数组），而不是 RangeError。
chunk([], 0) 同样抛 RangeError：空数组不会短路，size 的合法性仍然检查。
若希望空输入安静通过，由调用方显式短路：arr.length === 0 ? [] : chunk(arr, size)。
3.4 拷贝语义
返回新数组，每个分段也是 arr.slice(start, start + size) 生成的新数组；源数组不被修改。
返回值不持有源数组本身的引用：改动结果中的分段结构，不会影响 arr。
但这是浅拷贝：对象元素仍与源数组共享引用，修改对象内部字段会双向可见。
稀疏数组的空洞在分段中保留，slice 不会把它填成 undefined。
3.5 行为速查
添加到对话
放大
下载
调用	结果	说明
chunk([1, 2, 3, 4, 5], 2)	[[1,2],[3,4],[5]]	尾段可不足 size
chunk([1, 2], 10)	[[1, 2]]	size 大于长度时单段
chunk([], 3)	[]	空数组，合法 size
chunk([1], 0)	RangeError	size <= 0
chunk([1], -1)	RangeError	负步长
chunk([1], 1.5)	RangeError	非整数
chunk([1], NaN)	TypeError	类型校验先于取值校验
chunk('abc', 2)	TypeError	arr 必须是数组
chunk([], 0)	RangeError	空数组不跳过 size 校验
4. 异常总表
添加到对话
放大
下载
触发条件	涉及函数	异常类型
参数不是 number 或为 NaN	clamp / chunk	TypeError
clamp 中 lo > hi	clamp	RangeError
arr 不是数组	chunk	TypeError
size 为 0 / 负数 / 小数 / Infinity	chunk	RangeError
任意非法入参	isBlank	不抛错，返回 true
5. 最小回归集合

改动实现时建议保留三类断言：clamp 的端点 / lo > hi / NaN；isBlank 的 Unicode 空白 / 零宽字符 / null / '0'；chunk 的奇数长度 / 空数组 / size = 0, -1, 1.5, NaN, Infinity / 非数组入参 / 源数组不变。

6. 与实现的对应关系

关键判定分别落在：clamp 的 assertNumber 与 lo > hi 分支、常量 BLANK_RE 与 isBlank 的 typeof 分支、内部函数 assertChunkSize、以及 chunk 循环里的 arr.slice(start, start + size)。

查看所有产物 (2)
