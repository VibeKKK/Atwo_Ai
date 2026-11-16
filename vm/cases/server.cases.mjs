// accept --behave 用例：真起一个端口再打 —— 契约是 HTTP，不是函数签名。
// 端口一律 0（系统分配）：固定端口会让"本机已经跑着 oracle"变成随机红。
export const cases = [
  { name: '服务自述名固定', call: (m) => m.SERVICE, expect: 'ternary-oracle' },
  {
    name: '/health 报同一份阈值与引擎',
    call: async (m) => {
      const svc = await m.createServer({ port: 0 });
      try {
        const h = await fetch('http://127.0.0.1:' + svc.port + '/health').then((r) => r.json());
        return h.service === 'ternary-oracle' && h.engine === 'node' && h.cut.high === 0.45 && h.cut.mid === 0.22;
      } finally { await svc.close(); }
    },
  },
  {
    name: 'POST /judge 打得通并回三值结论',
    call: async (m) => {
      const svc = await m.createServer({ port: 0 });
      try {
        const r = await fetch('http://127.0.0.1:' + svc.port + '/judge', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ zValues: [2.5, 2.4, 2.6], expected: 3 }),
        }).then((x) => x.json());
        return r.value === 1 && typeof r.confidence === 'number';
      } finally { await svc.close(); }
    },
  },
  {
    name: '畸形 JSON 回 400（不是 500）',
    call: async (m) => {
      const svc = await m.createServer({ port: 0 });
      try {
        const r = await fetch('http://127.0.0.1:' + svc.port + '/judge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
        return r.status === 400;
      } finally { await svc.close(); }
    },
  },
  {
    name: '空 zValues 回 400（没数据不该问判定）',
    call: async (m) => {
      const svc = await m.createServer({ port: 0 });
      try {
        const r = await fetch('http://127.0.0.1:' + svc.port + '/judge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"zValues":[]}' });
        return r.status === 400;
      } finally { await svc.close(); }
    },
  },
];
