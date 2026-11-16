// atwo diff 的最小用例夹具：两份产物、一处真分歧、一处只是写法不同。
// 用它锁住「落盘」这件事，不依赖任何一次真实派活，也不联网。
export const products = [
  { agent: 'keep', fn: { formatBytes: (n) => (n < 0 ? '-1 KB' : '0 B') } },
  { agent: 'clamp', fn: { formatBytes: () => '0 B' } },
];

export const cases = [
  { name: '负数 -1024', call: (m) => m.formatBytes(-1024) },
];
