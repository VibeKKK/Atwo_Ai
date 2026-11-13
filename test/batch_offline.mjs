// 离线验证 batch 解析层（不调 agent，零成本）
import { parseTasks, buildBatchPrompt, splitResults } from '../lib/batch.mjs';

const t1 = parseTasks('---\n解释一下什么是幂等\n---\n写一个把秒转成 hh:mm:ss 的函数\n---\n列出 3 个 HTTP 幂等方法');
console.log('分隔符切分:', t1.length, '项');
console.log('行式切分:', parseTasks('- 甲\n- 乙\n- 丙').length, '项');
console.log('内联切分:', parseTasks('A|||B').length, '项');
const p = buildBatchPrompt(t1);
console.log('prompt 长度:', p.length, '字符（任务本体共', t1.join('').length, '字符）');

const good = {
  results: [
    { id: 1, answer: '幂等 = 同样输入重复执行结果不变', notes: ['重试安全'], confidence: 0.95 },
    { id: 2, code: 'def hms(s):\n    return "x"', notes: [], confidence: 0.9 },
    { id: 3, answer: 'GET / HEAD / PUT', notes: [], confidence: 0.8 },
  ],
};
const r = splitResults(JSON.stringify(good), t1);
console.log('契约解析:', r.source, r.items.length, '项；第2项缩进保留:', /\n    return/.test(r.items[1] && r.items[1].code || ''));

const bad = '1. 第一项答案\n2. 第二项答案\n3. 第三项答案';
const r2 = splitResults(bad, t1);
console.log('降级解析:', r2.source, r2.items.length, '项');

// 关键：字符串里带未转义双引号（Trae 真实坏输出）也必须能捞回来
const tricky = '{"results":[{"id":1,"code":"if f.endswith(".lnk"): pass","notes":[],"confidence":0.7}]}';
const r3 = splitResults(tricky, ['任务']);
console.log('坏引号能捞回:', r3.source, r3.items.length, '项');
