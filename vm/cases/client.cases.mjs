// accept --behave 用例：客户端地址优先级 + fail-closed。
// 断言的是「拿不到远端时绝不冒名本地」这条，不是「能连上」——连得上属于 test/vm_server.test.mjs。
export const cases = [
  { name: "默认地址就是本机 8731", call: (m) => m.oracleUrl(), expect: 'http://127.0.0.1:8731' },
  { name: "显式 url 优先", call: (m) => m.oracleUrl({ url: 'http://example:9' }), expect: 'http://example:9' },
  { name: "拿不到就 ok:false（不冒名）", call: async (m) => (await m.remoteJudge([1, 1, 1], { url: 'http://127.0.0.1:1', timeout: 300 })).ok, expect: false },
  { name: "拿不到时不带 value 字段", call: async (m) => Object.prototype.hasOwnProperty.call(await m.remoteJudge([1, 1, 1], { url: 'http://127.0.0.1:1', timeout: 300 }), 'value'), expect: false },
  { name: "降级是显式的（标 degraded + source=local）", call: async (m) => { const r = await m.judgeWithFallback([2, 2, 2], { url: 'http://127.0.0.1:1', timeout: 300 }); return r.degraded === true && r.source === 'local'; } },
];
