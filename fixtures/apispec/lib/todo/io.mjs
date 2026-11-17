/** @file 纯 JSON / CSV 序列化工具，仅使用 Node 内置能力。 */
const CSV_SPECIAL = /[",\n\r]/;

/** 转义 CSV 字段。@param {unknown} value 字段值。@returns {string} 转义后的字段。 */
function escapeField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return CSV_SPECIAL.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 将 CSV 文本解析为二维数组，支持引号内的逗号、双引号与换行。
 * @param {string} text 原始 CSV 文本。
 * @returns {string[][]} 行数组，每行为字段数组。
 */
function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes && ch === '"' && text[i + 1] === '"') {
      field += '"';
      i += 1;
    } else if (inQuotes) {
      if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      started = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      rows.push([...row, field]);
      row = [];
      field = '';
      started = false;
    } else {
      field += ch;
      started = true;
    }
  }
  if (started || row.length > 0) rows.push([...row, field]);
  return rows;
}

/** 数组序列化为 JSON。@param {Array<object>} list 数组。@returns {string} 带缩进的 JSON。 */
export function toJson(list) {
  return `${JSON.stringify(Array.isArray(list) ? list : [], null, 2)}\n`;
}

/** JSON 文本还原为数组，非数组结构返回空数组。@param {string} text JSON 文本。@returns {Array<object>} 数组。 */
export function fromJson(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

/** 对象数组序列化为 CSV，表头取首条记录的全部键。@param {Array<object>} list 数组。@returns {string} CSV 文本。 */
export function toCsv(list) {
  const rows = Array.isArray(list) ? list : [];
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(escapeField).join(',')];
  for (const row of rows) lines.push(headers.map((key) => escapeField(row?.[key])).join(','));
  return `${lines.join('\n')}\n`;
}

/** CSV 文本还原为对象数组。@param {string} text CSV 文本。@returns {Array<Record<string,string>>} 记录数组。 */
export function fromCsv(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const rows = parseRows(text);
  const headers = rows[0] ?? [];
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])));
}
