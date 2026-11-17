// 毫秒 → 人看的时间串。只做格式化，不猜单位、不做聚合：调用方给的就是毫秒。
// 分档与边界写死在这里，三次口径（ms / 秒 / 分+秒）互不重叠：<1000、[1000,60000)、>=60000。
export function fmtMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return Math.floor(ms) + 'ms';
  // 截断到 0.1s 而不是四舍五入：59999ms 四舍五入会印成「60.0s」，
  // 那是个还没到一分钟的时长却长得像一分钟 —— 档位串了，宁可少报 0.1s。
  if (ms < 60000) return (Math.floor(ms / 100) / 10).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m + 'm' + (s < 10 ? '0' + s : String(s)) + 's';
}
