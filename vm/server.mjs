// file: vm/server.mjs
/**
 * @file vm/server.mjs
 * @description 三值判定服务（ternary-oracle）：把 vm/judge.mjs 的输出用一个 HTTP 口暴露出来。
 *
 * 为什么要这一层：judge 目前只能被 atwo 在同一台机器上 import。目标是让「这组 z 值够不够
 * 下结论」变成一个**可被别的 agent、别的语言、别的机器**调用的判定，而不是一段只能本地跑的代码。
 * 服务只做三件事：校验输入 → 调 judge → 把结论原样吐回。判定逻辑一行都不在这里，
 * 因为它已经有唯一一份（vm/judge.mjs），复制第二份就等于再造一次「两份解释器」的事故。
 *
 * 边界（硬约束）：
 *   - 只读，无状态：服务不写盘、不记会话、不留日志文件（stdout 一行启动信息除外）。
 *   - 只判数据不判人：入参只有数值，没有身份字段。
 *   - fail-closed：任何畸形输入一律 4xx，绝不用默认值替调用方猜。
 *
 * 启动：
 *   node vm/server.mjs                  # 127.0.0.1:8731
 *   PORT=8731 HOST=0.0.0.0 node vm/server.mjs
 * 接口：
 *   GET  /health                        → 服务自述（含分档阈值，便于调用方核对版本）
 *   POST /judge  {"zValues":[...],"expected":9}
 *   GET  /judge?z=3.1,2.9,3.4&expected=9
 *   POST /votes  {"votes":["ACCEPT","REVISE",null],"expected":3}
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { judge, CUT, Z_LIMIT, CONTRACT } from './judge.mjs';
import { judgeVotes, parseVote } from './votes.mjs';

export const SERVICE = 'ternary-oracle';
export const VERSION = '1.0.0';
const MAX_BODY = 64 * 1024;
const DEFAULT_PORT = 8731;
const DEFAULT_HOST = '127.0.0.1';

/** 只把 judge 的结论搬出来，details 里的 stats 也带上（调用方要能自己复算）。 */
function project(result) {
  const st = result.details && result.details.stats ? result.details.stats : {};
  return {
    value: result.value,
    confidence: Number(result.confidence),
    reason: result.reason,
    label: result.value === 1 ? '可判' : (result.value === 0 ? '存疑' : '别判'),
    stats: {
      strength: st.strength ?? null,
      agreement: st.agreement ?? null,
      nValid: st.nValid ?? null,
      meanZ: st.meanZ ?? null,
      spread: st.spread ?? null,
    },
    checked: result.details ? {
      steps: result.details.steps,
      compiled: result.details.compiled,
      direct: result.details.direct,
      consistent: result.details.compiled === result.details.direct,
    } : null,
  };
}

/**
 * 读请求体。超过上限时**继续把字节读干净但不再累积**，然后回 413。
 * 为什么不是 destroy：直接把 socket 砍掉，客户端看到的是 ECONNRESET/SocketError，
 * 它没法区分「我发太大」和「服务挂了」。413 是一条能被人读懂的答复。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { overflow = true; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve({ text: overflow ? '' : Buffer.concat(chunks).toString('utf8'), overflow, size }));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 逗号/空格分隔的 z 值 → number[]；非数字进 bad 列表（不静默丢弃）。 */
function parseZList(text) {
  const parts = String(text == null ? '' : text).split(/[,\s]+/).filter(Boolean);
  const nums = [];
  const bad = [];
  for (const p of parts) {
    const n = Number(p);
    if (Number.isFinite(n)) nums.push(n); else bad.push(p);
  }
  return { nums, bad };
}

function parseExpected(raw) {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null; // null = 传了但非法
}

/**
 * 建服务。port=0 时由系统分配（测试用）。
 * @param {{port?:number, host?:string}} [opts]
 * @returns {Promise<{server:import('node:http').Server, port:number, close:()=>Promise<void>}>}
 */
export function createServer(opts = {}) {
  const startedAt = Date.now();
  const handle = async (req, res) => {
    const url = new URL(req.url || '/', 'http://oracle.local');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (route === '/health' && req.method === 'GET') {
        return send(res, 200, {
          ok: true, service: SERVICE, version: VERSION, engine: 'node', uptimeMs: Date.now() - startedAt,
          contractVersion: CONTRACT.contractVersion,
          cut: CUT, zLimit: Z_LIMIT, votesArity: CONTRACT.votesArity, endpoints: ['/health', '/judge', '/votes'],
        });
      }

      if (route === '/judge' && (req.method === 'POST' || req.method === 'GET')) {
        let zValues = [];
        let expected;
        if (req.method === 'GET') {
          const q = parseZList(url.searchParams.get('z'));
          if (q.bad.length) return send(res, 400, { ok: false, error: 'z 里有非数字: ' + q.bad.join(',') });
          zValues = q.nums;
          expected = parseExpected(url.searchParams.get('expected'));
          if (expected === null) return send(res, 400, { ok: false, error: 'expected 必须是正数' });
        } else {
          const { text, overflow, size } = await readBody(req);
          if (overflow) return send(res, 413, { ok: false, error: '请求体超过 ' + MAX_BODY + ' 字节（收到 ' + size + '）' });
          let body;
          try { body = JSON.parse(text || '{}'); } catch { return send(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
          if (Array.isArray(body)) zValues = body;
          else { zValues = body.zValues || body.z || []; expected = parseExpected(body.expected); }
          if (!Array.isArray(zValues)) return send(res, 400, { ok: false, error: 'zValues 必须是数组' });
          if (expected === null) return send(res, 400, { ok: false, error: 'expected 必须是正数' });
        }
        const bad = zValues.filter((v) => !Number.isFinite(Number(v)));
        if (bad.length) return send(res, 400, { ok: false, error: 'zValues 里有非数字', bad: bad.slice(0, 8) });
        if (!zValues.length) return send(res, 400, { ok: false, error: 'zValues 不能为空（没有数据时不该问判定，直接不该判）' });
        const r = judge({ zValues: zValues.map(Number), expected });
        return send(res, 200, { ok: true, ...project(r) });
      }

      if (route === '/votes' && req.method === 'POST') {
        const { text, overflow, size } = await readBody(req);
        if (overflow) return send(res, 413, { ok: false, error: '请求体超过 ' + MAX_BODY + ' 字节（收到 ' + size + '）' });
        let body;
        try { body = JSON.parse(text || '{}'); } catch { return send(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
        const votes = body.votes;
        const expected = parseExpected(body.expected);
        if (expected === null) return send(res, 400, { ok: false, error: 'expected 必须是正数' });
        if (!Array.isArray(votes)) return send(res, 400, { ok: false, error: 'votes 必须是数组（ACCEPT / REVISE / null）' });
        const unknown = votes.filter((v) => parseVote(v) === undefined);
        if (unknown.length) return send(res, 400, { ok: false, error: 'votes 里有无法识别的取值', bad: unknown.slice(0, 8) });
        return send(res, 200, { ok: true, ...judgeVotes({ votes, expected }) });
      }

      if (['/judge', '/votes'].includes(route)) {
        return send(res, 405, { ok: false, error: req.method + ' 不允许，用 ' + (route === '/judge' ? 'GET/POST' : 'POST') });
      }
      return send(res, 404, { ok: false, error: '没有这个接口: ' + route, endpoints: ['/health', '/judge', '/votes'] });
    } catch (e) {
      const status = (e && e.status) || 500;
      return send(res, status, { ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => { handle(req, res).catch(() => {}); });
    server.on('error', reject);
    server.listen(opts.port == null ? 0 : opts.port, opts.host || DEFAULT_HOST, () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// 直接跑：node vm/server.mjs（被 import 时不起服务，测试才敢 import 它）
const isMain = (() => {
  try { return !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url; } catch { return false; }
})();

if (isMain) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const host = process.env.HOST || DEFAULT_HOST;
  createServer({ port, host }).then(({ port: p }) => {
    console.log('[ternary-oracle] ' + SERVICE + ' v' + VERSION + ' 监听 http://' + host + ':' + p);
    console.log('[ternary-oracle] 分档 high>=' + CUT.high + ' / mid>=' + CUT.mid + '，z 截断 ±' + Z_LIMIT);
  }).catch((e) => {
    console.error('[ternary-oracle] 起不来：' + String((e && e.message) || e));
    process.exit(3);
  });
}
