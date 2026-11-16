// behavior 层的执行器 —— 在子进程里跑，因为 accept() 必须是同步的。
//
// 为什么单开进程：
//   accept() 被 orchestra / 测试 / CLI 同步调用，改成 async 会波及全部调用方。
//   更重要的是 —— 行为测试会执行被测文件的顶层代码（联网、写盘、开端口）。
//   放在子进程里，它崩了、挂住了、副作用搞坏了，都影响不到验收本身。

import { pathToFileURL } from 'node:url';

function judge(expect, got, threw) {
  if (typeof expect === 'function') {
    try { return !!expect(got, threw == null ? undefined : new Error(threw)); }
    catch (e) { return false; }
  }
  if (expect instanceof RegExp) return expect.test(threw != null ? 'throw:' + threw : String(got));
  if (threw != null) return false;
  if (typeof expect === 'string') return String(got).includes(expect);
  try { return JSON.stringify(got) === JSON.stringify(expect); } catch { return false; }
}

function show(v) {
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 77) + '...' : v;
  try { const s = JSON.stringify(v); return s && s.length > 80 ? s.slice(0, 77) + '...' : String(s); }
  catch { return String(v); }
}

const [modPath, casesPath] = process.argv.slice(2);
const out = { ok: false, fatal: null, results: [] };

try {
  const mod = await import(pathToFileURL(modPath).href);
  const casesMod = await import(pathToFileURL(casesPath).href);
  const cases = casesMod.cases || casesMod.default;
  if (!Array.isArray(cases)) throw new Error('用例文件要导出 cases 数组');
  if (!cases.length) throw new Error('用例文件是空的');

  for (const c of cases) {
    let got; let threw = null;
    // 2026-11-16 修：原来写 got = fn(mod)，不 await。
    // async 用例于是拿到一个 Promise，show() 把它序列化成 {}，
    // 三条 applyTier 用例全报「实际 {}」—— 看起来像产品坏了，其实是执行器根本不支持异步。
    // 被测函数是 async 很常见（切模型要 await 一次 CDP 往返），执行器必须等。
    const fn = c.call || c.run || c.fn;
    try { got = await fn(mod); } catch (e) { threw = (e && e.message) || String(e); }
    // 2026-11-16 修：用例不写 expect、只让 call 返回 true/false，是最自然的写法
    //（Jest 之外的所有测试框架都支持，人写起来也短）。但旧判定把 undefined
    // 当成「期望值 undefined」，用 JSON.stringify 一比必然不等 ——
    // 于是 29 条真跑通过（got 全是 true）的用例被判成 0/29，看起来像产物烂透了。
    // 契约应该是：没有 expect 时，call 的返回值本身即断言（非空/非 false 即通过）。
    // 三种写法都要认（2026-11-16 第二次修这个判定）：
    //   a) 写 expect  —— 按 expect 判（值/正则/函数）
    //   b) 不写 expect 但返回 true/false —— 返回值本身是断言
    //   c) 不写 expect 且走 assert 风格 —— 正常返回 undefined，抛错即失败
    // 第一版只认 a，把 L1 的 29 条全判失败；第二版改成 b 之后，又把 trae 这 59 条
    // 「assert 风格」全判失败（undefined 被 !! 成 false）。两次都是验收器坏了、看起来像产物烂。
    const ok = c.expect === undefined ? (threw == null && got !== false) : judge(c.expect, got, threw);
    out.results.push({
      name: String(c.name || '(无名用例)'),
      ok,
      got: threw != null ? 'throw:' + show(threw) : show(got),
    });
  }
  out.ok = true;
} catch (e) {
  out.fatal = (e && e.message) || String(e);
}

process.stdout.write(JSON.stringify(out));
