// render.mjs — 零依赖的终端表格渲染；按显示宽度对齐，中文计两格，非 TTY 自动关色。

const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const esc = (open) => (s) => (tty ? `\x1b[${open}m${s}\x1b[0m` : String(s));
const bold = esc('1');
const dim = esc('2');
const green = esc('32');
const cyan = esc('36');

// 显示宽度：ANSI 转义不占格；码点 > 255 记 2 格，其余 1 格。
function displayWidth(value) {
  const text = String(value).replace(/\x1b\[[0-9;]*m/g, '');
  let width = 0;
  for (const ch of text) width += ch.codePointAt(0) > 255 ? 2 : 1;
  return width;
}

// 右侧补空格到指定显示宽度。
function padRight(value, target) {
  const gap = target - displayWidth(value);
  return gap > 0 ? value + ' '.repeat(gap) : String(value);
}

// 左侧补空格（序号右对齐）。
function padLeft(value, target) {
  const gap = target - displayWidth(value);
  return gap > 0 ? ' '.repeat(gap) + value : String(value);
}

// 以 ASCII 边框拼表：列宽取表头与各单元格显示宽度的最大值。
function table(headers, rows, rightAlign = []) {
  const widths = headers.map((h, c) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[c] ?? '')))
  );
  const cell = (v, c) => (rightAlign.includes(c) ? padLeft(v, widths[c]) : padRight(v, widths[c]));
  const line = (cells) => cells.map((v, c) => ` ${cell(v, c)} `).join('|');
  const rule = widths.map((w) => '-'.repeat(w + 2)).join('+');
  return [bold(cyan(line(headers))), rule, ...rows.map((r) => line(r))].join('\n');
}

export function renderList(list) {
  const rows = (Array.isArray(list) ? list : []).map((item, i) => {
    const done = Boolean(item && item.done);
    const text = String((item && item.text) ?? '');
    const mark = done ? green('[x]') : '[ ]';
    return [String(i + 1), mark, done ? dim(text) : text];
  });
  if (rows.length === 0) return dim('（暂无任务，使用 add 添加）');
  return table(['序号', '状态', '内容'], rows, [0]);
}

export function renderHelp() {
  const cmd = (s) => bold(cyan(s));
  return [
    bold('todo — 轻量终端待办'),
    '',
    `  ${cmd('add <内容>')}    添加一条任务`,
    `  ${cmd('list')}          列出全部任务`,
    `  ${cmd('done <序号>')}   把指定任务标记为完成`,
    `  ${cmd('rm <序号>')}     删除指定任务`,
    `  ${cmd('help')}          显示本帮助`,
    '',
    dim('提示：序号从 1 开始；中文按两格宽对齐；非 TTY 下不上色。'),
  ].join('\n');
}
