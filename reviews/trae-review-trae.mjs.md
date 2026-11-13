# Trae 评审：agents/trae.mjs

- 评审者：Trae CN（DeepSeek-V4.1-Flash）
- 时间：2026-11-13 00:12
- 结论：REVISE

---

展示更多
00:09
TRAE
思考过程
代码评审：trae.mjs
严重（会导致错误结果）

1. before 快照取在清空输入框之前 —— 会误判“Trae 没开始响应”

在哪：askTrae() 里 const before = JSON.parse(await snapshot(c)); 出现在 clearInput() 之前。
错在哪：snapshot 读的是整页 innerText，而输入框里的残留文本也在这份文本里。若上一轮输入框还留着较长草稿，before.len 会偏大；清空后页面先缩短、再被用户气泡补回来，s.len > before.len + 10 可能永远不成立，于是抛「Trae 没开始响应（可能没发出去，或额度不足）」，把正常的成功误报成失败。另外 before.tail 取完就没再用过，是无效数据。
怎么改：把 before 移到 clearInput 与 typeInto 之后、pressEnter 之前取；或者改成只统计回复区域（见第 11 条），不要用整页长度做基线。

2. addedText 不是“新增的文本”

在哪：函数注释写「等 Trae 回复完，返回新增的文本」，实现是 const added = after.len > before.len ? after.tail : '';
错在哪：after.tail 是整页 innerText 的最后 400 个字符，既包含用户自己的提问回显、侧栏、工具栏文字，也把长回复截成 400 字。页面长度不变时还直接返回空串。调用方拿到的既不是“新增”也不是“完整回复”。
怎么改：用 after.tail 与 before.tail 求公共前缀得到增量；更可靠的是用已经定义但从未使用的 SEL_MSG 取最后一个助手消息块（需换成精确选择器，见第 11 条），返回该块的完整 innerText，不要用 400 字符窗口。

3. 超时后静默返回 ok: true

在哪：while (Date.now() - t0 < timeoutMs) { ... } 循环结束后直接 return { ok: true, ... }。
错在哪：timeoutMs 到点时循环只是退出，既不抛错也不置标志位；调用方无法区分“模型答完了”和“等了 3 分钟只拿到半截”，会把截断内容当完整结果使用。
怎么改：加 let finished = false;，只有走 break 分支才置 true；返回 { ok: finished, timedOut: !finished, ... }，或在 !finished 时抛超时错误（附带已获取的部分文本）。

4. “已开始”与“已结束”的判定都不可靠

在哪：
开始判定：if (s.len > before.len + 10) { started = true; break; }
结束判定：else if (!busy && Date.now() - stableSince > settleMs) break;
错在哪：
用户消息气泡回显本身就会让页面变长 10 字符以上，因此“开始了”可能只是因为自己的提问被贴上去了，模型一个 token 都还没吐。
settleMs 默认 2500ms。推理类模型首 token 经常超过这个时间，此时页面长度不变、isBusy 又没匹配到（见第 8 条），循环会直接 break，把用户自己的提问当作回复返回。
怎么改：开始判定改为“输入框已变空 且 出现新的助手消息节点（长度增量来自回复容器）”；结束判定必须同时满足“出现过至少一次长度增长发生在开始之后”和 !busy，并把 settleMs 默认值提高到首 token 的合理上限（例如 8–10s），或把 settleMs 与“是否已收到首个助手 token”解耦。
中等

5. 清空判定阈值自相矛盾，且未处理 -1

在哪：
JavaScript
1
2
if (left > 0) { ...; left = await clearInput(c); }
if (left > 1) throw new Error('清空输入框失败，还剩 ' + left + ' 字符');
错在哪：第一次用 > 0 触发重试，第二次却用 > 1 才报错，left === 1 会带着一个残留字符继续发送。clearInput 在找不到元素时返回 -1，这里既不报错也不处理，错误会被推迟到 typeInto 抛出「输入框不见了」，信息误导。
怎么改：先 if (left < 0) throw new Error('输入框不存在');；若确实要容忍 Lexical 空段落产生的一个换行，就显式归一化后再比较（innerText.replace(/\s/g,'').length），阈值统一用 > 0，并在注释里说明为什么允许这个特例。

6. Ctrl+A 硬编码 Windows 修饰键，macOS 上会反向破坏清空

在哪：clearInput() 中两处 modifiers: 2。
错在哪：CDP 修饰位是 Alt=1、Ctrl=2、Meta=4、Shift=8。macOS 上全选是 Command（4），modifiers: 2 的 Ctrl+A 在 contenteditable 里是 Emacs 的“移到行首”，会把前面 JS 设置的选区折叠掉，随后 Delete 只删一个字符，left 依然很大，最终抛「清空输入框失败」。而且前面已经用 range.selectNodeContents(e) 选好了全部内容，这步 Ctrl+A 在 Windows 上本来就是冗余的。
怎么改：按 process.platform 选择 4（darwin）或 2（win32/linux）；既然已手动全选，也可以直接去掉 Ctrl+A，只保留“选中 + Delete”，并在 Delete 后校验一次长度。

7. SEL_EDIT 取第一个 contenteditable，可能写错框

在哪：const SEL_EDIT = '[contenteditable="true"]';，全文用它做 document.querySelector。
错在哪：Trae 里搜索框、重命名框、聊天输入都是 contenteditable，querySelector 返回文档序第一个命中的元素。面板切换后很可能把 prompt 打进搜索框，后面 tail 校验可能仍然通过（如果确实写进去了），最终 Enter 触发的是别的行为。
怎么改：先定位 Agent 面板容器（用面板标识 class/data-testid），再在容器内 querySelector(SEL_EDIT)；至少加上可见性与尺寸校验（getBoundingClientRect().width > 0），并在命中多于一个时直接报错。

8. isBusy 全页启发式，两头都容易错

在哪：
JavaScript
1
2
if (/停止生成|停止响应|Stop generating|Esc 停止/i.test(t)) return true;
const spinners = document.querySelectorAll('[class*="loading"],[class*="Loading"],[class*="spinner"],...');
错在哪：
扫的是整页 innerText。用户提问里只要出现“停止生成”这几个字，就会永远 busy，一直空转到 timeoutMs。
[class*="loading"] / spinner 会匹配到文件树加载、Git 状态、插件安装等无关动画，同样导致假忙到超时。
反过来，若 Trae 的停止按钮文案或 class 与这几条正则都不匹配，就会一直 busy === false，配合第 4 条直接提前收尾。
怎么改：把作用域限制到最后一条助手消息容器内；停止态判断优先用按钮节点是否存在且可见（[data-testid]/aria-label），文案正则只作兜底；再加一个“连续 N 次 busy 但长度无变化超过 X 秒则视为卡死”的逃逸条件。

9. 空 prompt 必然抛错，且错误信息误导

在哪：askTrae() 中 if (afterSend && afterSend.includes(prompt.trim().slice(0, 20)))
错在哪：prompt = '' 时 ''.slice(0,20) === ''，String.includes('') 恒为 true，只要输入框有任何内容就抛「回车没发出去，输入框还留着文字」，真实原因是没传 prompt。同理 typeInto 里的 got.includes('') 也恒真，空串能一路通过校验。
怎么改：入口处 if (!prompt || !String(prompt).trim()) throw new Error('prompt 为空');；比较时用非空守卫 const head = prompt.trim().slice(0, 20); if (head && afterSend.includes(head)) ...。

10. 发送成功校验窗口过短、匹配方式脆弱

在哪：await new Promise(r => setTimeout(r, 600)); 之后读输入框并做前缀 20 字符匹配。
错在哪：600ms 对 Electron 主线程忙碌时不够，正常发送会被误判为失败；反过来，若输入框内是 placeholder 文案或历史草稿恰好以相同 20 字符开头，也会误判。前缀匹配对含 Markdown 转换、\u200b（Lexical 常用零宽占位符）的文本尤其不可靠。
怎么改：改成“轮询直到输入框为空或超时（如 5s）”，判空用 innerText.replace(/[\s\u200b]/g, '') === ''，不要用包含式前缀比较。
轻微 / 可简化

11. 死代码与注释不符

const SEL_MSG = ... 全文未使用；且 [class*="message"] 会匹配到 messageInput、no-messages 这类元素，就算启用也是错的。
snapshot 的注释写「统计当前页面上"消息块"的指纹」，实现却是 document.body.innerText 的长度加末尾 400 字符，跟“消息块”无关。
怎么改：要么删掉 SEL_MSG，要么把它改成精确的助手消息选择器并在第 2 条的增量提取中真正用上；同步修正注释。

12. peekTrae 的“可见文本”说法不成立

document.body.innerText 返回的是渲染后的整页文本，与视口滚动位置无关。注释「拿当前面板的可见文本」应改为「拿当前页面的渲染文本（含滚动外内容）」。

13. snapshot 的 JSON 往返是多余的

CDP 本身会把 Runtime.evaluate 的返回值序列化回 Node，这里又在页面里 JSON.stringify、回到 Node 再 JSON.parse，多一次解析，也埋下解析异常的风险。直接 return { len: txt.length, tail: txt.slice(-400) }（returnByValue: true）即可。

14. typeInto 的注释与实现自相矛盾

注释写「必须走 execCommand 才认」，实现却是构造 ClipboardEvent('paste') 派发。
另外合成事件的 isTrusted === false，而 Lexical 的 paste 处理对受信性/isComposing 有判断；这条路径是否真能写入需要实证，不清楚就不能在注释里断言“必须走 execCommand”。
怎么改：先用一次真实运行确认这条路径有效，然后按实际做法改注释；如果确认无效，就换成 Input.insertText 或 document.execCommand('insertText')，别保留错误的技术说明。

15. 细节不统一

finally { c.close(); }：若 close() 返回 Promise，失败会被吞掉，应 await c.close()（finally 内 await 合法）。
文件里已经有 sleep，但多处仍写 new Promise(r => setTimeout(...))，统一用 sleep。
elapsedMs 从 t0 起算，而 t0 在“等开始”之前就赋了值，所以这个数包含最多 20s 的启动等待；JSDoc 没说明它是“总耗时”还是“生成耗时”。
timeoutMs 小于 20000 时，前一个“等开始”循环仍会阻塞满 20s，超出调用方给的预算；应对 timeoutMs 做下限校验或让两段共享同一截止时间。

结论：REVISE —— 第 1/2/3/4 条会让这个驱动在正常场景下误报失败或返回错误内容（尤其 addedText 根本不是新增回复、超时静默成功），必须先修这几处，再谈多平台键位和无用代码的清理。
