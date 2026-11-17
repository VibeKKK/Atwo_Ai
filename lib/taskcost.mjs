// lib/cost.mjs — 每个任务的成本账：一次派活花了多少、摊到每路多少。
// 只记账、只聚合：不联网、不打印、不 import 别的 atwo 模块，测试和 CLI 都能单独用。
import fs from 'node:fs';
import path from 'node:path';

export const COST_CONTRACT = 'atwo-cost/1';

// 单价按「每百万 token」计；未知模型落到 default —— 宁可高估，也不假装免费。
export const PRICE_PER_MTOK = {
  'deepseek-v4.1-flash': { in: 0.14, out: 0.28 },
  'glm-5.3-flash': { in: 0.1, out: 0.1 },
  'kimi-k3.1-pro': { in: 1.2, out: 1.2 },
  default: { in: 0.5, out: 1.5 },
};

// 账本和 log.jsonl / score.jsonl 同住 memory/，收工时只看一个目录。
const COST_FILE = path.join('memory', 'cost.jsonl');

// 数字兜底：'12' 能救回来，救不回来的一律 0，免得一行脏账把求和变成 NaN。
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// 金额留 6 位：单次调用常常不足一厘钱，少留一位就把差异抹平了。
const round6 = (v) => Math.round(v * 1e6) / 1e6;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function priceOf(model) {
  const table = PRICE_PER_MTOK;
  if (typeof model === 'string' && Object.prototype.hasOwnProperty.call(table, model)) {
    return table[model];
  }
  return table.default;
}

/**
 * 按每百万 token 单价算一条账的美元数。
 * @param {string} model 模型名
 * @param {number} tokensIn 输入 token
 * @param {number} tokensOut 输出 token
 * @returns {number} 美元，保留 6 位
 */
export function usdOf(model, tokensIn, tokensOut) {
  const p = priceOf(model);
  const usd = (num(tokensIn) / 1e6) * num(p.in) + (num(tokensOut) / 1e6) * num(p.out);
  return round6(usd);
}

// 本地时间 <yyyyMMddHHmmss>-<4位hex>：前缀可排序，hex 让同一秒的多条不撞号。
function newId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${stamp}-${hex}`;
}

// 时间戳坏了就当 0：记账不能因为一个坏参数整条抛掉。
function msOf(rec) {
  const a = Date.parse(rec.startedAt);
  const b = Date.parse(rec.endedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return b > a ? b - a : 0;
}

// calls 缺省是 1：一条没写调用次数的账至少算一次，不能算成 0 次。
function callsOf(v) {
  if (v === undefined || v === null || v === '') return 1;
  const n = Number(v);
  return Number.isFinite(n) ? n : 1;
}

// 账本行只有一种形状：缺什么补什么，写进去的就一定是能算的账。
function normalize(record, id) {
  const r = isObj(record) ? record : {};
  const tokensIn = num(r.tokensIn);
  const tokensOut = num(r.tokensOut);
  const model = typeof r.model === 'string' && r.model ? r.model : 'default';
  const out = {
    id,
    taskId: typeof r.taskId === 'string' && r.taskId ? r.taskId : 'unknown',
    kind: typeof r.kind === 'string' && r.kind ? r.kind : 'run',
    lane: typeof r.lane === 'string' && r.lane ? r.lane : 'unknown',
    model,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
    endedAt: typeof r.endedAt === 'string' ? r.endedAt : '',
    tokensIn,
    tokensOut,
    calls: callsOf(r.calls),
    usd: usdOf(model, tokensIn, tokensOut),
  };
  if (typeof r.note === 'string' && r.note) out.note = r.note;   // 没备注就不占字段
  return out;
}

/**
 * 追加一行账。写盘失败也把原因带出去，调用方只说话不阻断。
 * @param {string} cwd 仓库根
 * @param {object} record {taskId,kind,lane,model,startedAt,endedAt,tokensIn,tokensOut,calls,note?}
 * @returns {{ok:boolean,id:string,reason:string}}
 */
export function appendCost(cwd, record) {
  const id = newId();
  try {
    const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
    const file = path.join(base, COST_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(normalize(record, id)) + '\n', 'utf8');
    return { ok: true, id, reason: '' };
  } catch (e) {
    return { ok: false, id, reason: e && e.message ? e.message : String(e) };
  }
}

/**
 * 逐行读账；文件不存在算空账本，坏行只计数不中断。
 * @param {string} cwd 仓库根
 * @returns {{ok:boolean,records:object[],corrupt:number}}
 */
export function readCost(cwd) {
  const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const file = path.join(base, COST_FILE);
  const records = [];
  let corrupt = 0;
  let body;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, records, corrupt };   // 还没花过钱不是错
    return { ok: false, records, corrupt };
  }
  for (const raw of String(body).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      corrupt += 1;   // 一行垃圾不能拖垮整本账
      continue;
    }
    if (isObj(obj)) records.push(obj);
    else corrupt += 1;   // 能解析但不是对象，同样算坏账
  }
  return { ok: true, records, corrupt };
}

// 三个维度共用一套累加器，小计才和总额用同一把尺子，不会对不上账。
function blank() {
  return { calls: 0, ms: 0, tokensIn: 0, tokensOut: 0, usd: 0 };
}

function bucketIn(map, key) {
  let b = map.get(key);
  if (!b) {
    b = blank();
    map.set(key, b);
  }
  return b;
}

function add(bucket, rec, ms, usd) {
  bucket.calls += rec.calls;
  bucket.ms += ms;
  bucket.tokensIn += rec.tokensIn;
  bucket.tokensOut += rec.tokensOut;
  bucket.usd += usd;
}

function finish(bucket) {
  return {
    calls: bucket.calls,
    ms: bucket.ms,
    tokensIn: bucket.tokensIn,
    tokensOut: bucket.tokensOut,
    usd: round6(bucket.usd),
  };
}

function shapeOf(map) {
  const out = {};
  for (const [k, b] of map) out[k] = finish(b);
  return out;
}

/**
 * 按 lane / model / taskId 聚合；opts.since 只统计之后开始的账。
 * @param {object[]} records readCost().records
 * @param {{since?:string}} [opts]
 * @returns {{contract:string,total:object,byLane:object,byModel:object,byTask:object}}
 */
export function summarizeCost(records, opts = {}) {
  const list = Array.isArray(records) ? records : [];
  const o = isObj(opts) ? opts : {};
  const since = typeof o.since === 'string' ? Date.parse(o.since) : NaN;
  const hasSince = !Number.isNaN(since);   // since 读不出来就当没设，别把账全筛掉
  const total = blank();
  const lanes = new Map();
  const models = new Map();
  const tasks = new Map();
  for (const raw of list) {
    const rec = isObj(raw) ? raw : {};
    const model = typeof rec.model === 'string' && rec.model ? rec.model : 'default';
    const lane = typeof rec.lane === 'string' && rec.lane ? rec.lane : 'unknown';
    const taskId = typeof rec.taskId === 'string' && rec.taskId ? rec.taskId : 'unknown';
    if (hasSince) {
      // 归属时间看 startedAt：那是这次派活开始花钱的那一刻；
      // 读不出时间的账在带 since 时不算，宁可少算不误算。
      const t = Date.parse(rec.startedAt);
      if (Number.isNaN(t) || t < since) continue;
    }
    const norm = {
      calls: callsOf(rec.calls),
      tokensIn: num(rec.tokensIn),
      tokensOut: num(rec.tokensOut),
    };
    const ms = msOf(rec);
    const usd = usdOf(model, norm.tokensIn, norm.tokensOut);
    add(total, norm, ms, usd);
    add(bucketIn(lanes, lane), norm, ms, usd);
    add(bucketIn(models, model), norm, ms, usd);
    add(bucketIn(tasks, taskId), norm, ms, usd);
  }
  return {
    contract: COST_CONTRACT,
    total: finish(total),
    byLane: shapeOf(lanes),
    byModel: shapeOf(models),
    byTask: shapeOf(tasks),
  };
}

// 人读的一行账：金额 4 位、时长换秒，单路几厘钱也看得见。
const dollars = (usd) => `$${num(usd).toFixed(4)}`;
const seconds = (ms) => `${(num(ms) / 1000).toFixed(2)}s`;

function dimLine(label, dim) {
  const entries = isObj(dim) ? Object.entries(dim) : [];
  const top = entries
    .map(([k, v]) => [k, isObj(v) ? v : {}])
    .sort((a, b) => num(b[1].usd) - num(a[1].usd))
    .slice(0, 3)
    .map(([k, v]) => `${k}=${dollars(v.usd)}`);
  return top.length ? `${label} ${top.join(' ')}` : `${label} -`;
}

/**
 * 打成人读文本：total 一行 + 三个维度各一行（每维只列最贵的三项）。
 * @param {object} summary summarizeCost 的输出
 * @returns {string}
 */
export function formatCost(summary) {
  const s = isObj(summary) ? summary : {};
  const total = isObj(s.total) ? s.total : {};
  const head = `total calls=${num(total.calls)} ${seconds(total.ms)} in=${num(total.tokensIn)} out=${num(total.tokensOut)} ${dollars(total.usd)}`;
  const lines = [head, dimLine('lane', s.byLane), dimLine('model', s.byModel), dimLine('task', s.byTask)];
  return lines.slice(0, 8).join('\n');   // 上限 8 行，再多就不叫一眼看完
}
